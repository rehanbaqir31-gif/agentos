import { describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  EnvironmentCredentialStore,
  GeminiProvider,
  OllamaProvider,
  OpenAiCompatibleProvider,
  OpenAiProvider,
} from "../src/index.js";

const enabled = process.env["AGENTOS_PROVIDER_SMOKE"] === "1";
const credentials = new EnvironmentCredentialStore();
const ollamaModel = process.env["AGENTOS_OLLAMA_SMOKE_MODEL"];
const compatibleUrl = process.env["AGENTOS_COMPATIBLE_SMOKE_URL"];
const compatibleModel = process.env["AGENTOS_COMPATIBLE_SMOKE_MODEL"];
const compatibleCredentialRef = process.env["AGENTOS_COMPATIBLE_SMOKE_CREDENTIAL_REF"];

describe("optional live provider smoke tests (disabled unless explicitly enabled)", () => {
  it.skipIf(!enabled || !ollamaModel)(
    "calls the configured local Ollama model",
    async () => {
      const provider = new OllamaProvider(credentials);
      const response = await provider.chat(
        {
          baseUrl: process.env["AGENTOS_OLLAMA_BASE_URL"] ?? "http://127.0.0.1:11434",
          timeoutMs: 120_000,
        },
        {
          model: ollamaModel!,
          messages: [{ role: "user", content: "Reply with the single word ready." }],
        },
      );
      expect(response.text.trim().length).toBeGreaterThan(0);
    },
    180_000,
  );

  it.skipIf(!enabled || !compatibleUrl || !compatibleModel)(
    "calls a configured OpenAI-compatible endpoint",
    async () => {
      const provider = new OpenAiCompatibleProvider(credentials);
      const response = await provider.chat(
        {
          baseUrl: compatibleUrl!,
          model: compatibleModel!,
          credentialRef: compatibleCredentialRef ? `env:${compatibleCredentialRef}` : null,
          supportsUsageReporting: false,
          timeoutMs: 120_000,
        },
        {
          model: compatibleModel!,
          messages: [{ role: "user", content: "Reply with the single word ready." }],
        },
      );
      expect(response.text.trim().length).toBeGreaterThan(0);
    },
    180_000,
  );

  it.skipIf(
    !enabled || !process.env["OPENAI_API_KEY"] || !process.env["AGENTOS_OPENAI_SMOKE_MODEL"],
  )(
    "calls the configured OpenAI model",
    async () => {
      const provider = new OpenAiProvider(credentials);
      const response = await provider.chat(
        { model: process.env["AGENTOS_OPENAI_SMOKE_MODEL"]! },
        {
          model: process.env["AGENTOS_OPENAI_SMOKE_MODEL"]!,
          messages: [{ role: "user", content: "Reply with the single word ready." }],
          maxOutputTokens: 16,
        },
      );
      expect(response.text.trim().length).toBeGreaterThan(0);
    },
    180_000,
  );

  it.skipIf(
    !enabled || !process.env["ANTHROPIC_API_KEY"] || !process.env["AGENTOS_ANTHROPIC_SMOKE_MODEL"],
  )(
    "calls the configured Anthropic model",
    async () => {
      const provider = new AnthropicProvider(credentials);
      const model = process.env["AGENTOS_ANTHROPIC_SMOKE_MODEL"]!;
      const response = await provider.chat(
        { model },
        {
          model,
          messages: [{ role: "user", content: "Reply with the single word ready." }],
          maxOutputTokens: 16,
        },
      );
      expect(response.text.trim().length).toBeGreaterThan(0);
    },
    180_000,
  );

  it.skipIf(
    !enabled || !process.env["GOOGLE_API_KEY"] || !process.env["AGENTOS_GEMINI_SMOKE_MODEL"],
  )(
    "calls the configured Gemini model",
    async () => {
      const provider = new GeminiProvider(credentials);
      const model = process.env["AGENTOS_GEMINI_SMOKE_MODEL"]!;
      const response = await provider.chat(
        { model },
        {
          model,
          messages: [{ role: "user", content: "Reply with the single word ready." }],
          maxOutputTokens: 16,
        },
      );
      expect(response.text.trim().length).toBeGreaterThan(0);
    },
    180_000,
  );
});
