import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthenticatedPrincipal, TrustedPrincipalSource } from "@agentos/agents";

interface Context {
  principal: AuthenticatedPrincipal;
  validateSession: () => Promise<boolean>;
}

const principalContext = new AsyncLocalStorage<Context>();

export const requestPrincipalSource: TrustedPrincipalSource = {
  async currentPrincipal() {
    const context = principalContext.getStore();
    if (!context || !(await context.validateSession())) return null;
    return context.principal;
  },
};

export function withAuthenticatedPrincipal<T>(
  principal: AuthenticatedPrincipal,
  operation: () => T,
  validateSession: () => Promise<boolean> = async () => true,
): T {
  return principalContext.run({ principal, validateSession }, operation);
}
