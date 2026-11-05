export const providerErrorCodes = [
  "invalid_configuration",
  "invalid_request",
  "missing_credential",
  "unavailable",
  "timeout",
  "cancelled",
  "authentication_failed",
  "model_not_found",
  "unsupported_operation",
  "invalid_response",
  "request_failed",
  "duplicate_registration",
  "ambiguous_model",
] as const;
export type ProviderErrorCode = (typeof providerErrorCodes)[number];

const defaultMessages: Record<ProviderErrorCode, string> = {
  invalid_configuration: "The provider configuration is invalid.",
  invalid_request: "The provider request is invalid.",
  missing_credential: "A credential required by this provider is not available.",
  unavailable: "The provider server is unavailable. Check its address and that it is running.",
  timeout: "The provider request timed out.",
  cancelled: "The provider request was cancelled.",
  authentication_failed: "The provider rejected its credential.",
  model_not_found: "The selected model is not available from this provider.",
  unsupported_operation: "This provider configuration does not support that operation.",
  invalid_response: "The provider returned a response that did not match its API contract.",
  request_failed: "The provider request failed.",
  duplicate_registration: "A provider with this identifier is already registered.",
  ambiguous_model: "The model name matches more than one configured provider.",
};

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly providerId: string;
  readonly retriable: boolean;

  constructor(
    providerId: string,
    code: ProviderErrorCode,
    message = defaultMessages[code],
    retriable = false,
  ) {
    super(message);
    this.name = "ProviderError";
    this.providerId = providerId;
    this.code = code;
    this.retriable = retriable;
  }
}

export function normalizeHttpError(providerId: string, status: number): ProviderError {
  if (status === 401 || status === 403)
    return new ProviderError(providerId, "authentication_failed");
  if (status === 404) return new ProviderError(providerId, "model_not_found");
  if (status === 408 || status === 504)
    return new ProviderError(providerId, "timeout", undefined, true);
  if (status === 429 || status >= 500)
    return new ProviderError(providerId, "request_failed", undefined, true);
  return new ProviderError(providerId, "request_failed");
}

export function normalizeTransportError(
  providerId: string,
  error: unknown,
  signal?: AbortSignal,
): ProviderError {
  if (signal?.aborted) {
    const reason = signal.reason;
    if (reason instanceof DOMException && reason.name === "TimeoutError")
      return new ProviderError(providerId, "timeout", undefined, true);
    return new ProviderError(providerId, "cancelled");
  }
  if (error instanceof DOMException && error.name === "TimeoutError")
    return new ProviderError(providerId, "timeout", undefined, true);
  if (error instanceof Error && error.name === "AbortError")
    return new ProviderError(providerId, "cancelled");
  return new ProviderError(providerId, "unavailable", undefined, true);
}

export function normalizeSdkError(
  providerId: string,
  error: unknown,
  signal?: AbortSignal,
): ProviderError {
  if (signal?.aborted) return normalizeTransportError(providerId, error, signal);
  if (error && typeof error === "object" && "status" in error) {
    const status = Number((error as { status?: unknown }).status);
    if (Number.isInteger(status) && status >= 100) return normalizeHttpError(providerId, status);
  }
  if (error instanceof Error && /timeout/i.test(error.name))
    return new ProviderError(providerId, "timeout", undefined, true);
  return normalizeTransportError(providerId, error, signal);
}
