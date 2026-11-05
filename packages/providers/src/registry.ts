import type { Provider, ProviderRepositoryContract } from "@agentos/core";
import { ProviderError } from "./errors.js";
import type {
  ConnectionTestResult,
  ProviderCapability,
  ProviderDriver,
  ProviderHealth,
  ProviderModel,
} from "./types.js";

export interface RegisterProviderInput {
  driverId: string;
  name: string;
  configuration: unknown;
  enabled?: boolean;
}

export interface RegisteredProvider {
  provider: Provider;
  capabilities: ProviderCapability[];
}

export interface ResolvedModel {
  provider: Provider;
  model: ProviderModel;
}

const driverTypes: Readonly<Record<string, Provider["providerType"]>> = {
  ollama: "ollama",
  openai_compatible: "openai_compatible",
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
};

function safeConfiguration(
  driver: ProviderDriver,
  input: unknown,
): {
  validated: unknown;
  publicConfig: Record<string, unknown>;
  baseUrl: string | null;
  credentialRef: string | null;
} {
  const validated = driver.validateConfiguration(input);
  if (!validated || typeof validated !== "object" || Array.isArray(validated))
    throw new ProviderError(driver.id, "invalid_configuration");
  const record = validated as Record<string, unknown>;
  const { baseUrl, credentialRef, credentialHeaderName, credentialPrefix, ...remaining } = record;
  return {
    validated,
    publicConfig: {
      ...remaining,
      ...(typeof credentialHeaderName === "string" ? { authHeaderName: credentialHeaderName } : {}),
      ...(typeof credentialPrefix === "string" ? { authSchemePrefix: credentialPrefix } : {}),
    },
    baseUrl: typeof baseUrl === "string" ? baseUrl : null,
    credentialRef: typeof credentialRef === "string" ? credentialRef : null,
  };
}

export class ProviderRegistry {
  readonly #drivers = new Map<string, ProviderDriver>();

  constructor(private readonly repository: ProviderRepositoryContract) {}

  register(driver: ProviderDriver): void {
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(driver.id))
      throw new ProviderError(
        driver.id,
        "invalid_configuration",
        "Provider identifiers must be stable lowercase identifiers.",
      );
    if (this.#drivers.has(driver.id)) throw new ProviderError(driver.id, "duplicate_registration");
    this.#drivers.set(driver.id, driver);
  }

  unregister(driverId: string): boolean {
    return this.#drivers.delete(driverId);
  }

  listDrivers(): Array<{ id: string; displayName: string }> {
    return [...this.#drivers.values()]
      .map(({ id, displayName }) => ({ id, displayName }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  private driver(driverId: string): ProviderDriver {
    const driver = this.#drivers.get(driverId);
    if (!driver)
      throw new ProviderError(
        driverId,
        "unsupported_operation",
        "This provider driver is not registered.",
      );
    return driver;
  }

  validateConfiguration(driverId: string, configuration: unknown): unknown {
    return this.driver(driverId).validateConfiguration(configuration);
  }

  async add(input: RegisterProviderInput): Promise<Provider> {
    const driver = this.driver(input.driverId);
    const providerType = driverTypes[driver.id];
    if (!providerType)
      throw new ProviderError(
        driver.id,
        "unsupported_operation",
        "This registered driver has no persistence mapping.",
      );
    const normalized = safeConfiguration(driver, input.configuration);
    const created = await this.repository.create({
      name: input.name,
      providerType,
      baseUrl: normalized.baseUrl,
      credentialRef: normalized.credentialRef,
      availableModels: [],
      configuration: normalized.publicConfig,
      enabled: input.enabled ?? true,
    });
    return created;
  }

  async updateConfiguration(providerId: string, input: unknown): Promise<Provider> {
    const provider = await this.repository.getById(providerId);
    const driver = this.driver(provider.providerType);
    const normalized = safeConfiguration(driver, input);
    return this.repository.update(provider.id, {
      baseUrl: normalized.baseUrl,
      credentialRef: normalized.credentialRef,
      configuration: normalized.publicConfig,
      availableModels: [],
    });
  }

  async list(): Promise<RegisteredProvider[]> {
    const page = await this.repository.list({ limit: 200, offset: 0 });
    return page.items.map((provider) => {
      const driver = this.#drivers.get(provider.providerType);
      return {
        provider,
        capabilities:
          driver && provider.enabled ? driver.capabilities(this.configuration(provider)) : [],
      };
    });
  }

  async setEnabled(providerId: string, enabled: boolean): Promise<Provider> {
    return this.repository.update(providerId, { enabled });
  }

  async remove(providerId: string): Promise<boolean> {
    return this.repository.delete(providerId);
  }

  private configuration(provider: Provider): unknown {
    const driver = this.#drivers.get(provider.providerType);
    if (!driver)
      throw new ProviderError(
        provider.providerType,
        "unsupported_operation",
        "No driver is registered for the saved provider.",
      );
    const { authHeaderName, authSchemePrefix, ...settings } = provider.configuration;
    return driver.validateConfiguration({
      ...settings,
      baseUrl: provider.baseUrl ?? undefined,
      credentialRef: provider.credentialRef,
      ...(typeof authHeaderName === "string" ? { credentialHeaderName: authHeaderName } : {}),
      ...(typeof authSchemePrefix === "string" ? { credentialPrefix: authSchemePrefix } : {}),
    });
  }

  private enabledProvider(provider: Provider): { driver: ProviderDriver; configuration: unknown } {
    if (!provider.enabled)
      throw new ProviderError(
        provider.providerType,
        "unsupported_operation",
        "The provider is disabled.",
      );
    const driver = this.#drivers.get(provider.providerType);
    if (!driver)
      throw new ProviderError(
        provider.providerType,
        "unsupported_operation",
        "No driver is registered for the saved provider.",
      );
    return { driver, configuration: this.configuration(provider) };
  }

  async listModels(providerId: string, signal?: AbortSignal): Promise<ProviderModel[]> {
    const provider = await this.repository.getById(providerId);
    const { driver, configuration } = this.enabledProvider(provider);
    const models = await driver.listModels(configuration, signal);
    await this.repository.update(provider.id, { availableModels: models.map((model) => model.id) });
    return models;
  }

  async testConnection(
    providerId: string,
    modelId?: string,
    signal?: AbortSignal,
  ): Promise<ConnectionTestResult> {
    const provider = await this.repository.getById(providerId);
    const { driver, configuration } = this.enabledProvider(provider);
    return driver.testConnection(configuration, modelId, signal);
  }

  async healthCheck(providerId: string, signal?: AbortSignal): Promise<ProviderHealth> {
    const provider = await this.repository.getById(providerId);
    if (!provider.enabled)
      return { providerId, status: "degraded", checkedAt: new Date().toISOString() };
    const { driver, configuration } = this.enabledProvider(provider);
    return driver.healthCheck(configuration, signal);
  }

  async resolveModel(
    modelId: string,
    providerId?: string,
    signal?: AbortSignal,
  ): Promise<ResolvedModel> {
    const providers = providerId
      ? [await this.repository.getById(providerId)]
      : (await this.repository.list({ limit: 200, offset: 0 })).items;
    const matches: ResolvedModel[] = [];
    for (const provider of providers) {
      if (!provider.enabled) continue;
      const driver = this.#drivers.get(provider.providerType);
      if (!driver) continue;
      const configuration = this.configuration(provider);
      let model: ProviderModel | undefined;
      try {
        if (driver.capabilities(configuration).includes("model-discovery")) {
          model = (await driver.listModels(configuration, signal)).find(
            (entry) => entry.id === modelId,
          );
        } else {
          const configuredModel = (configuration as Record<string, unknown>)["model"];
          if (configuredModel === modelId) {
            model = {
              id: modelId,
              displayName: modelId,
              capabilities: driver.capabilities(configuration),
              metadata: { discovery: "configured" },
            };
          }
        }
      } catch (error) {
        if (providerId) throw error;
      }
      if (model) matches.push({ provider, model });
    }
    if (matches.length === 0) throw new ProviderError(providerId ?? "providers", "model_not_found");
    if (matches.length > 1) throw new ProviderError("providers", "ambiguous_model");
    return matches[0]!;
  }
}
