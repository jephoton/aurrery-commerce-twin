import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { loadEnvConfig } from "@next/env";
import { deploymentConfiguration } from "../src/hosting/deployment";

export function startArguments(env: Record<string, string | undefined>): string[] {
  const port = env.PORT ?? "3001";
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("Invalid runtime configuration");
  return ["start", "--hostname", "0.0.0.0", "--port", port];
}

export function prepareStartup(loadEnvironment: () => void, env: Record<string, string | undefined> = process.env): string[] {
  loadEnvironment();
  deploymentConfiguration(env);
  return startArguments(env);
}

/** Explicit executable/argument array; never interpolate PORT into a shell. */
export function runNext(modulePath: string, args: string[]) {
  const child = spawn(process.execPath, [modulePath, ...args], { stdio: "inherit", shell: false });
  const interrupt = () => { child.kill("SIGINT"); };
  const terminate = () => { child.kill("SIGTERM"); };
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  const cleanup = () => { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); };
  child.once("error", () => { cleanup(); console.error("Application startup failed."); process.exitCode = 1; });
  child.once("exit", (code, signal) => { cleanup(); process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143); });
  return child;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = prepareStartup(() => loadEnvConfig(process.cwd(), false, { info() {}, error() { throw new Error("Invalid runtime configuration"); } }));
    runNext(createRequire(import.meta.url).resolve("next/dist/bin/next"), args);
  } catch { console.error("Invalid runtime configuration."); process.exitCode = 1; }
}
