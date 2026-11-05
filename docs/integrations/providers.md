# Provider integrations

`@agentos/providers` is the provider runtime package. It defines typed chat/generate requests, responses, stream events, model metadata, capability declarations, normalized usage, structured errors, credential stores and a provider registry. Built-in drivers are Ollama (`ollama`), OpenAI-compatible chat completions (`openai_compatible`), OpenAI Responses (`openai`), Anthropic Messages (`anthropic`), and Google Gemini (`google`). There is no agent execution or frontend code in this package.

```ts
import {
  EnvironmentCredentialStore,
  AnthropicProvider,
  GeminiProvider,
  OllamaProvider,
  OpenAiCompatibleProvider,
  OpenAiProvider,
  ProviderRegistry,
} from "@agentos/providers";
import { openConfiguredDatabase } from "@agentos/database";

const configured = await openConfiguredDatabase();
const credentials = new EnvironmentCredentialStore();
const registry = new ProviderRegistry(configured.repositories.providers);
registry.register(new OllamaProvider(credentials));
registry.register(new OpenAiCompatibleProvider(credentials));
registry.register(new OpenAiProvider(credentials));
registry.register(new AnthropicProvider(credentials));
registry.register(new GeminiProvider(credentials));

try {
  const instance = await registry.add({
    driverId: "ollama",
    name: "Local Ollama",
    configuration: { baseUrl: "http://127.0.0.1:11434" },
  });
  const models = await registry.listModels(instance.id);
  // Persisted provider records contain endpoint/settings and credential references only.
  console.log(models.map(({ id, capabilities }) => ({ id, capabilities })));
} finally {
  await configured.close();
}
```

Drivers validate configuration and API responses with Zod. Requests support cancellation through `AbortSignal`; configuration timeouts apply to SDK calls and response streams. Stream consumers receive only text deltas and a final normalized result. Provider errors contain a stable code and a generic safe message; upstream response bodies are discarded. Usage fields are included only when the provider reports them. Cost is omitted because no pricing source is configured.

Capabilities are conservative. A feature is reported only when the driver and common contract support it. All five drivers support text chat/generation and streaming. The SDK drivers support model discovery and normalized vendor usage when returned. Ollama model-specific tools and vision are advertised only from `/api/show`. The OpenAI-compatible endpoint lets users opt into model discovery, streaming and usage support; compatibility varies by server. The current common request contract does not expose tool calls, structured output, image input, or embeddings, so those are not advertised even when a vendor API supports them.

The registry rejects duplicate driver registrations, validates provider configuration, persists instances through `ProviderRepository`, supports enabling/disabling/removing instances, refreshes model lists, returns health, and resolves a model selection. Configured default models can be selected without model discovery; a configured model-discovery endpoint is required to query available models.

Provider instances may store endpoint configuration, non-secret custom headers, and a credential reference. Never pass secret values in configuration. The provider package has an OS-keychain adapter seam but currently ships no native OS backend. Environment references default to `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GOOGLE_API_KEY` for the official drivers; Ollama does not require a credential by default. Provider endpoint URLs must use HTTPS except for loopback HTTP endpoints. See [credential security](../security/credentials.md).

Official SDK implementation details and limitations are documented in [official SDK providers](official-sdk-providers.md). OpenAI uses the official Responses API; Anthropic uses its Messages API; Gemini uses `@google/genai` `generateContent` and `generateContentStream`. These adapters normalize text output and usage metadata without claiming every vendor feature.

There is not yet a CLI package, so `agentos providers ...` commands are not implemented. Automated mocked HTTP tests run by default and require no provider accounts. Optional live smoke tests are disabled by default. Enable them with `AGENTOS_PROVIDER_SMOKE=1` and set the provider's model, endpoint, and credential environment variables described in `providers.smoke.test.ts`; these calls may incur usage charges. No live provider was available for local verification during this implementation.
