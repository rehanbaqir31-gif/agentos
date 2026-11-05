import { ProviderError } from "./errors.js";

export interface CredentialStore {
  get(reference: string): Promise<string | undefined>;
  set(reference: string, value: string): Promise<void>;
  delete(reference: string): Promise<void>;
}

export class EnvironmentCredentialStore implements CredentialStore {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async get(reference: string): Promise<string | undefined> {
    const match = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(reference);
    if (!match) return undefined;
    const value = this.environment[match[1]!];
    return value?.trim() ? value : undefined;
  }

  async set(): Promise<void> {
    throw new Error(
      "Environment credentials are read-only; update the secret in the host environment",
    );
  }

  async delete(): Promise<void> {
    throw new Error(
      "Environment credentials are read-only; remove the secret in the host environment",
    );
  }
}

export class MemoryCredentialStore implements CredentialStore {
  readonly #values = new Map<string, string>();

  async get(reference: string): Promise<string | undefined> {
    return this.#values.get(reference);
  }

  async set(reference: string, value: string): Promise<void> {
    if (!reference || !value) throw new Error("Credential reference and value are required");
    this.#values.set(reference, value);
  }

  async delete(reference: string): Promise<void> {
    this.#values.delete(reference);
  }
}

/** Adapter seam for native Windows Credential Manager, macOS Keychain, or Linux Secret Service APIs. */
export interface OsKeychainBackend {
  read(service: string, account: string): Promise<string | undefined>;
  write(service: string, account: string, value: string): Promise<void>;
  remove(service: string, account: string): Promise<void>;
}

export class OsKeychainCredentialStore implements CredentialStore {
  constructor(
    private readonly backend: OsKeychainBackend,
    private readonly service = "AgentOS",
  ) {}

  private account(reference: string): string {
    const match = /^(?:keychain|os-credential):([A-Za-z0-9._:/-]+)$/.exec(reference);
    if (!match) throw new ProviderError("credentials", "invalid_configuration");
    return match[1]!;
  }

  get(reference: string): Promise<string | undefined> {
    return this.backend.read(this.service, this.account(reference));
  }

  set(reference: string, value: string): Promise<void> {
    if (!value) throw new Error("Credential value must not be empty");
    return this.backend.write(this.service, this.account(reference), value);
  }

  delete(reference: string): Promise<void> {
    return this.backend.remove(this.service, this.account(reference));
  }
}

export class CompositeCredentialStore implements CredentialStore {
  constructor(private readonly stores: readonly CredentialStore[]) {}

  async get(reference: string): Promise<string | undefined> {
    for (const store of this.stores) {
      const value = await store.get(reference);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  async set(reference: string, value: string): Promise<void> {
    const store = this.stores.find((entry) => entry instanceof OsKeychainCredentialStore);
    if (!store) throw new Error("No writable OS credential store is configured");
    await store.set(reference, value);
  }

  async delete(reference: string): Promise<void> {
    const store = this.stores.find((entry) => entry instanceof OsKeychainCredentialStore);
    if (!store) throw new Error("No writable OS credential store is configured");
    await store.delete(reference);
  }
}

export async function resolveCredential(
  store: CredentialStore,
  reference: string | null,
  providerId: string,
): Promise<string | undefined> {
  if (reference === null) return undefined;
  let value: string | undefined;
  try {
    value = await store.get(reference);
  } catch {
    throw new ProviderError(
      providerId,
      "unavailable",
      "The configured credential store could not be read.",
      true,
    );
  }
  if (!value) throw new ProviderError(providerId, "missing_credential");
  return value;
}
