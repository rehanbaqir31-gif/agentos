import { ProviderError, normalizeHttpError, normalizeTransportError } from "./errors.js";
import { isIP } from "node:net";

function loopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIP(host) === 4) return host.startsWith("127.");
  return host === "::1";
}

export function safeBaseUrl(value: string, providerId: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderError(providerId, "invalid_configuration");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    (url.protocol === "http:" && !loopbackHost(url.hostname)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ProviderError(providerId, "invalid_configuration");
  }
  return url;
}

export function endpointUrl(baseUrl: string, path: string, providerId: string): URL {
  const base = safeBaseUrl(baseUrl, providerId);
  const root = base.toString().endsWith("/") ? base.toString() : `${base.toString()}/`;
  const result = new URL(path.replace(/^\//, ""), root);
  if (result.origin !== base.origin) throw new ProviderError(providerId, "invalid_configuration");
  return result;
}

export function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function fetchProvider(
  providerId: string,
  url: URL,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  try {
    const response = await fetch(url, init);
    if (!response.ok) {
      const error = normalizeHttpError(providerId, response.status);
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
    return response;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw normalizeTransportError(providerId, error, signal);
  }
}

export async function responseJson(providerId: string, response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ProviderError(providerId, "invalid_response");
  }
}

export async function* readNdjson(
  providerId: string,
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<unknown> {
  if (!response.body) throw new ProviderError(providerId, "invalid_response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) yield parseLine(providerId, line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield parseLine(providerId, buffer);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw normalizeTransportError(providerId, error, signal);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function* readSse(
  providerId: string,
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  if (!response.body) throw new ProviderError(providerId, "invalid_response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "") {
          if (data.length) yield data.join("\n");
          data = [];
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).trimStart());
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.startsWith("data:")) data.push(buffer.slice(5).trimStart());
    if (data.length) yield data.join("\n");
  } catch (error) {
    throw normalizeTransportError(providerId, error, signal);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function parseLine(providerId: string, line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw new ProviderError(providerId, "invalid_response");
  }
}
