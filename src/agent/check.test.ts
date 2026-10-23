import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAgent } from "../../scripts/check-agent";
import type { RunResult } from "./run";

it("writes unique public transcript artifacts with usage and safe progress", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-check-"));
  try {
    const log = vi.fn();
    const result: RunResult = { status: "incomplete", reason: "NO_PROPOSAL", counters: { requestedTools: 0, executedTools: 0, modelTurns: 1, accountedTokens: 1500, reportedTokens: 0, httpRequests: 1, elapsedMs: 1 }, transcript: [{ role: "assistant", content: "Public" }], requests: [{ kind: "model", reservation: 1500, status: 200 }] };
    const run = vi.fn(async (options) => { options.emit({ type: "status", message: "Investigating" }); return result; });
    await checkAgent({ run, directory, log });
    await checkAgent({ run, directory, log });
    const files = await readdir(directory);
    expect(files).toHaveLength(2);
    expect(files.every((f) => /^agent-run-.*\.json$/.test(f))).toBe(true);
    const artifact = JSON.parse(await readFile(join(directory, files[0]), "utf8"));
    expect(artifact).toMatchObject({ version: "agent-run-v1", events: [{ type: "status", message: "Investigating" }], result: { transcript: [{ role: "assistant", content: "Public" }], requests: [{ reservation: 1500 }] } });
    expect(log).toHaveBeenCalledWith("Investigating");
    expect(run.mock.calls[0][0].objective).toContain("at-risk");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
