# Official SDK providers

These drivers share the `ProviderDriver` contract and normalize text chat, text generation, streaming, model discovery, usage, errors, cancellation, and timeouts. They intentionally do not expose tool calling, multimodal content, structured output, or provider-specific controls that are not represented in the common contract.

| Driver ID   | SDK/API                            | Default credential reference | Usage mapping                                       |
| ----------- | ---------------------------------- | ---------------------------- | --------------------------------------------------- |
| `openai`    | `openai` package, Responses API    | `env:OPENAI_API_KEY`         | Input/output/total and cached input tokens          |
| `anthropic` | `@anthropic-ai/sdk`, Messages API  | `env:ANTHROPIC_API_KEY`      | Input/output and cache-read input tokens            |
| `google`    | `@google/genai`, `generateContent` | `env:GOOGLE_API_KEY`         | Prompt, candidate, total, and cached content tokens |

Register the driver with the same credential store used for the other provider integrations. Supply a model identifier in the driver configuration. `baseUrl` is optional and is intended for a trusted compatible endpoint; use HTTPS remotely. HTTP is accepted only for loopback development servers. The SDK's default service endpoint is used when `baseUrl` is omitted.

Example using the OpenAI SDK driver:

```ts
const openai = new OpenAiProvider(new EnvironmentCredentialStore());
const reply = await openai.chat(
  { model: "gpt-4.1-mini" },
  {
    model: "gpt-4.1-mini",
    messages: [{ role: "user", content: "Summarize this change." }],
  },
);
```

OpenAI uses the Responses API, which does not accept the shared `stop` option; requests with stop sequences fail as `unsupported_operation`. Anthropic's SDK exposes text message blocks, which are concatenated into the normalized text response. Gemini maps assistant messages to the provider's `model` role and uses `systemInstruction` for system messages. Gemini cancellation is client-side and may not stop service-side work that has already begun.

Mock HTTP tests validate SDK paths, payloads, streaming, discovery, and usage without sending real provider requests. Live tests in `providers.smoke.test.ts` are skipped unless `AGENTOS_PROVIDER_SMOKE=1` and the corresponding environment credential/model is set. Real tests may generate billable usage. Never enable smoke tests in CI unless credentials and cost controls are deliberately configured.

Official SDK references: [OpenAI Node SDK and Responses API](https://github.com/openai/openai-node), [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript), and [Google Gen AI SDK](https://github.com/googleapis/js-genai).
