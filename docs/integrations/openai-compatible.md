# OpenAI-compatible provider

Use this driver for a service that implements the OpenAI-style chat-completions HTTP contract. Supply the server base URL, model identifier and optional behavior flags. Use HTTPS for remote services; HTTP is limited to loopback endpoints. The driver does not assume model discovery is implemented by the target server.

```ts
const credentials = new EnvironmentCredentialStore();
const provider = new OpenAiCompatibleProvider(credentials);
const config = provider.validateConfiguration({
  baseUrl: "https://api.example.test/v1",
  model: "code-model",
  credentialRef: "env:AGENTOS_MODEL_API_KEY",
  headers: { "x-tenant": "development" },
  modelDiscoveryPath: null,
  healthCheckPath: null,
  supportsStreaming: true,
  supportsUsageReporting: false,
  timeoutMs: 120_000,
});

const response = await provider.chat(config, {
  model: "code-model",
  messages: [{ role: "user", content: "Explain this function." }],
});
```

The default chat route is `chat/completions` relative to the configured base URL, so a base ending in `/v1` targets `/v1/chat/completions`. A custom `chatCompletionsPath` can be provided. `modelDiscoveryPath` and `healthCheckPath` are disabled by default; when set, AgentOS calls those exact configured paths. If no health path is configured, connection testing sends a minimal one-token chat request and may incur provider charges.

Streaming uses server-sent events and expects the `[DONE]` marker. Usage reporting is opt-in because compatible servers differ; when enabled, streaming requests ask for the final usage chunk. Reported usage fields are passed through without guessed costs or token counts. Only `chat`, and configured `streaming`, `model-discovery`, or `usage-reporting` capabilities are declared. Tool-calling, structured output and vision are not advertised by this driver.

Custom non-secret headers are supported. Authentication header names are configured through `credentialHeaderName` and their values come only from `credentialRef`; secret-like header values are rejected. HTTP status, timeout, cancellation and malformed responses are normalized without forwarding the upstream response body.

Compatibility is endpoint-specific. The automated suite verifies the implemented contract against a mock HTTP server; no paid or live third-party endpoint is used in CI. Verify optional features with the target vendor before enabling them.
