import { expect, it } from "vitest";
import { prepareStartup, startArguments } from "../../scripts/start";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

it("loads Next's runtime environment before validation and port selection", () => {
  const env: Record<string, string | undefined> = {};
  expect(prepareStartup(() => { env.PORT = "10000"; }, env).at(-1)).toBe("10000");
  expect(() => prepareStartup(() => { env.RENDER = "true"; }, env)).toThrow("Invalid hosted configuration");
});

it("executes the actual CLI guard and loads only an owned fixture environment before failing safely", () => {
  const dir = mkdtempSync(join(tmpdir(), "aurrery-start-cli-"));
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production", TSX_TSCONFIG_PATH: resolve("tsconfig.json") };
  for (const key of ["PORT", "RENDER", "HOSTED_DEMO", "APP_URL", "ADMIN_PASSWORD", "HOSTED_SECRET"]) delete env[key];
  try {
    // Never permit a Next/server spawn, even if the entrypoint/validation regresses.
    const preload = join(dir, "no-children.cjs");
    writeFileSync(preload, "require('node:child_process').spawn=()=>{console.error('UNEXPECTED_SPAWN');throw Error('fixture')};require('node:module').syncBuiltinESMExports();");
    const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    for (const contents of ["PORT=unsafe-port\n", "HOSTED_DEMO=true\nADMIN_PASSWORD=private-fixture-short\n"]) {
      writeFileSync(join(dir, ".env.local"), contents);
      const result = spawnSync(process.execPath, ["--require", preload, `--import=${loader}`, "--conditions=react-server", resolve("scripts/start.ts")], { cwd: dir, env, encoding: "utf8", timeout: 10_000 });
      expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
      expect(result.stderr).toContain("Invalid runtime configuration.");
      expect(result.stderr).not.toMatch(/UNEXPECTED_SPAWN|private-fixture-short|Cannot find|ERR_MODULE/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("uses a validated assigned port, defaults locally, and passes arguments without shell interpolation", () => {
  expect(startArguments({})).toEqual(["start", "--hostname", "0.0.0.0", "--port", "3001"]);
  expect(startArguments({ PORT: "10000" }).at(-1)).toBe("10000");
  for (const PORT of ["", "0", "65536", "3;echo secret", "1e4", " 3001", "-1"]) expect(() => startArguments({ PORT })).toThrow();
});

it("forwards child exit codes and termination using an isolated process fixture", () => {
  const dir = mkdtempSync(join(tmpdir(), "aurrery-start-"));
  try {
    const child = join(dir, "child.cjs");
    writeFileSync(child, "process.exit(Number(process.argv[2]))");
    const script = join(dir, "parent.cjs");
    const start = resolve("scripts/start.ts");
    writeFileSync(script, `const { runNext } = require(${JSON.stringify(start)}); runNext(${JSON.stringify(child)}, ['7']);`);
    const result = spawnSync(process.execPath, ["--import=tsx", "--conditions=react-server", script], { encoding: "utf8" });
    expect(result.status).toBe(7);
    writeFileSync(child, "setInterval(() => {}, 1000)");
    writeFileSync(script, `const { runNext } = require(${JSON.stringify(start)}); const child = runNext(${JSON.stringify(child)}, []); child.once('spawn', () => process.emit('SIGTERM'));`);
    const terminated = spawnSync(process.execPath, ["--import=tsx", "--conditions=react-server", script], { encoding: "utf8", timeout: 10_000 });
    expect(terminated.error).toBeUndefined(); expect(terminated.status).toBe(143);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
