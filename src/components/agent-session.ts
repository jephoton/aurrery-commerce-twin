import type { AgentEvent } from "@/agent/contracts";
import { requestAgent } from "@/agent/stream";

interface SessionCallbacks {
  fetch?: typeof fetch;
  onEvent(event: AgentEvent): void;
  onResult(result: Awaited<ReturnType<typeof requestAgent>>): void;
  onError(message: string): void;
  onFinish(): void;
}
/** One stable instance per mounted panel; stopped generations cannot update a later run. */
export class AgentSession {
  private generation = 0;
  private controller: AbortController | null = null;
  get active() { return this.controller !== null; }
  stop() {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
  }
  async run(objective: string, callbacks: SessionCallbacks): Promise<void> {
    if (this.active) return;
    const controller = new AbortController(), current = ++this.generation;
    this.controller = controller;
    try {
      const result = await requestAgent(objective, { fetch: callbacks.fetch, signal: controller.signal, onEvent: event => {
        if (this.generation === current && !controller.signal.aborted) callbacks.onEvent(event);
      } });
      if (this.generation === current) callbacks.onResult(result);
    } catch (error) {
      if (this.generation === current) callbacks.onError(controller.signal.aborted ? "Run cancelled." : error instanceof Error ? error.message : "Agent unavailable. Run incomplete.");
    } finally {
      if (this.generation === current) { this.controller = null; callbacks.onFinish(); }
    }
  }
}
