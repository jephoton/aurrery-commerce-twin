import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { runAgent, type RunOptions } from "../src/agent/run";
import type { AgentEvent } from "../src/agent/contracts";

export const DEFAULT_OBJECTIVE = "Investigate whether a broad discount for at-risk subscribers improves retention value. Compare a selective cancel-and-price offer, annual prepay and do nothing honestly, inspect uncertainty and stress, and propose only a supported action within explicit rules.";
export async function checkAgent(options: { objective?: string; signal?: AbortSignal; run?: typeof runAgent; directory?: string; log?: (message: string) => void } = {}) {
  const directory = options.directory ?? resolve("data");
  const log = options.log ?? console.log;
  const events: AgentEvent[] = [];
  const objective = options.objective ?? DEFAULT_OBJECTIVE;
  const request: RunOptions = { objective, signal: options.signal, emit(event) {
    events.push(event);
    if (event.type === "status" || event.type === "summary" || event.type === "wait") log(event.message);
    if (event.type === "tool_started") log(`Tool: ${event.name}`);
    if (event.type === "error") log(`Run status: ${event.code}`);
  } };
  const result = await (options.run ?? runAgent)(request);
  await mkdir(directory, { recursive: true });
  const filename = `agent-run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.json`;
  const artifactPath = join(directory, filename);
  await writeFile(artifactPath, JSON.stringify({ version: "agent-run-v1", objective, events, result }, null, 2), { flag: "wx" });
  log(`Public run artifact: ${filename}`);
  log(`Result: ${result.status} (${result.reason}); tools ${result.counters.requestedTools}, model turns ${result.counters.modelTurns}, accounted tokens ${result.counters.accountedTokens}.`);
  return { result, artifactPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  checkAgent({ objective: process.argv.slice(2).join(" ").trim() || undefined, signal: controller.signal })
    .then(({ result }) => { process.exitCode = result.status === "complete" ? 0 : 1; })
    .catch(() => { console.error("Agent check could not complete or save its public artifact. Details suppressed."); process.exitCode = 1; })
    .finally(() => { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); });
}
