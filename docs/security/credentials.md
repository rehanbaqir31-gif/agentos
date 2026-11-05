# Credential storage and rotation

## Credential references

Provider database records store only a reference, such as `env:AGENTOS_MODEL_API_KEY` or `keychain:provider/account`. The actual credential is resolved at request time and attached to the HTTP request. Do not place secret values in provider configuration, custom headers, logs, event payloads, manifests, source control or client/browser storage.

`EnvironmentCredentialStore` reads explicitly named environment variables and is read-only. Put values in the host's secret manager or process environment; do not commit `.env` files. `MemoryCredentialStore` is volatile and intended for development/tests only. `OsKeychainCredentialStore` delegates to an injected `OsKeychainBackend`; it never falls back to plaintext storage. The backend interface exposes read/write/remove so a desktop integration can use Windows Credential Manager, macOS Keychain or Linux Secret Service.

**Native keychain implementations are not included yet.** Desktop packaging must provide a platform backend before offering keychain references to users. If no OS backend is configured, keychain reads fail safely. No file encryption format or key management is improvised in this package.

## Rotation

- For an environment reference, update the host secret/environment value and restart or reload the host process. The reference itself does not change.
- For an OS credential reference, call `CredentialStore.set(reference, newValue)` to overwrite the stored value; remove a retired reference with `delete`. Platform backends should use the OS credential service's protected APIs.
- To change references, call `ProviderRegistry.updateConfiguration` with the new `credentialRef`; it clears the cached model list so it can be rediscovered.
- Do not log a credential value or include it in an error when rotation fails.

Provider response bodies and transport errors are intentionally not surfaced in `ProviderError` messages because upstream services may echo request content or credentials. Errors expose a stable code, provider identifier and retry hint only. Custom request headers reject common auth/secret names and secret-like values; authentication values must use the credential store.

These controls do not encrypt the operating system environment, secure the process memory, or prevent a privileged process from reading host secrets. Apply platform access controls and use a native keychain backend for desktop secret persistence.
