import "server-only";
import { isAbsolute, posix } from "node:path";

/** Server-only runtime configuration. Never serialize this object to a response. */
export type HostedConfig = { hosted: false } | { hosted: true; origin: string; adminPassword: string; secret: string };

export function hostedConfig(env: Record<string, string | undefined> = process.env): HostedConfig {
  const flag = env.HOSTED_DEMO;
  if (flag !== undefined && flag !== "true" && flag !== "false") throw new Error("Invalid hosted configuration");
  if (env.RENDER !== "true" && flag !== "true") return { hosted: false };
  const url = env.APP_URL;
  if (!url || !env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 32 || !env.HOSTED_SECRET || env.HOSTED_SECRET.length < 32) throw new Error("Invalid hosted configuration");
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("Invalid hosted configuration"); }
  if (parsed.protocol !== "https:" || parsed.origin !== url || parsed.username || parsed.password) throw new Error("Invalid hosted configuration");
  if (!env.LEDGER_PATH || env.LEDGER_PATH === ":memory:") throw new Error("Invalid hosted configuration");
  if (env.RENDER === "true") {
    if (!posix.isAbsolute(env.LEDGER_PATH) || !posix.normalize(env.LEDGER_PATH).startsWith("/var/data/") || env.LEDGER_PATH.includes("..")) throw new Error("Invalid hosted configuration");
  } else if (!isAbsolute(env.LEDGER_PATH)) throw new Error("Invalid hosted configuration");
  return { hosted: true, origin: parsed.origin, adminPassword: env.ADMIN_PASSWORD, secret: env.HOSTED_SECRET };
}
