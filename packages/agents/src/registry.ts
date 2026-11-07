import type { AgentAdapter, AgentCapabilities } from "./contracts.js";

export class AdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();
  register(adapter: AgentAdapter): void {
    if (this.adapters.has(adapter.id)) throw new Error(`Adapter already registered: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
  }
  get(id: string): AgentAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Unknown agent adapter: ${id}`);
    return adapter;
  }
  remove(id: string): boolean {
    return this.adapters.delete(id);
  }
  list(): Array<{ id: string; capabilities: AgentCapabilities }> {
    return [...this.adapters.values()].map((a) => ({ id: a.id, capabilities: a.capabilities() }));
  }
}
