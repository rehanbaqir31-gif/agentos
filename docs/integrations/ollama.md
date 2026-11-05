# Ollama provider

The AgentOS Ollama driver uses the documented REST API. Install Ollama using its [official installation instructions](https://ollama.com/download), start the local server, and pull a model before selecting it. The default local endpoint is `http://127.0.0.1:11434`; set `baseUrl` to another reachable HTTP(S) endpoint when needed.

```ts
const provider = new OllamaProvider(new EnvironmentCredentialStore());
const config = provider.validateConfiguration({
  baseUrl: "http://127.0.0.1:11434",
  timeoutMs: 120_000,
});

const connection = await provider.testConnection(config, "qwen3:8b");
const details = await provider.getModel(config, "qwen3:8b");
const response = await provider.chat(config, {
  model: details.id,
  messages: [{ role: "user", content: "Summarize the staged changes." }],
});
```

Connection testing reads `/api/version`; it does not invoke inference. `/api/tags` provides model discovery and `/api/show` provides model capabilities and metadata. Only capabilities returned by `/api/show` are assigned to an individual model. Ollama chat and prompt generation use `/api/chat` and `/api/generate`; both support NDJSON streaming and AbortSignal cancellation. Token counts are mapped from the reported prompt/evaluation counts. Timing is measured locally; cost and cached-token counts are included only when reported.

The default local configuration needs no credential. HTTP endpoints are allowed only on loopback; use HTTPS for a remote Ollama Cloud or other authenticated server. Store a reference such as `env:OLLAMA_API_KEY` or `keychain:ollama/cloud` in the provider record. The credential value is attached as a Bearer header at request time and never placed into the database record or provider error.

If Ollama is unavailable, AgentOS returns `unavailable` with a local-server hint; check the server address and that Ollama is running. A 404 from model operations is normalized to `model_not_found`. API behavior and model feature support can vary with Ollama/model versions. Automated tests use an HTTP test server; no live Ollama server was available during the implementation verification.

Implementation follows Ollama's published [`/api/version` overview](https://docs.ollama.com/api/introduction), [chat endpoint](https://docs.ollama.com/api/chat), and [generate endpoint](https://docs.ollama.com/api/generate).
