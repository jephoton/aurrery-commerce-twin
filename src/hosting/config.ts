import "server-only";
import { isAbsolute } from "node:path";
import { validateTursoUrl } from "@/ledger/connection";

/** Server-only runtime configuration. Never serialize this object to a response. */
export type HostedConfig = { hosted: false } | { hosted: true; origin: string; adminPassword: string; secret: string };

export function hostedConfig(env: Record<string, string | undefined> = process.env): HostedConfig {
  const flag = env.HOSTED_DEMO;
  if (flag !== undefined && flag !== "true" && flag !== "false") throw new Error("Invalid hosted configuration");
  if (env.RENDER !== "true" && flag !== "true") return { hosted: false };
  if (env.LEDGER_BACKEND !== undefined && env.LEDGER_BACKEND !== "sqlite" && env.LEDGER_BACKEND !== "turso") throw new Error("Invalid hosted configuration");
  const url = env.APP_URL ?? (env.RENDER === "true" ? env.RENDER_EXTERNAL_URL : undefined);
  if (!url || !env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.trim().length < 32 || !env.HOSTED_SECRET || env.HOSTED_SECRET.trim().length < 32 || env.ADMIN_PASSWORD === env.HOSTED_SECRET) throw new Error("Invalid hosted configuration");
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("Invalid hosted configuration"); }
  if (parsed.protocol !== "https:" || parsed.origin !== url || parsed.username || parsed.password) throw new Error("Invalid hosted configuration");
  if (env.RENDER === "true") {
    if (env.LEDGER_BACKEND !== "turso" || !env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN?.trim() || env.LEDGER_PATH) throw new Error("Invalid hosted configuration");
  } else if ((env.LEDGER_BACKEND ?? "sqlite") === "sqlite" && (!env.LEDGER_PATH || env.LEDGER_PATH === ":memory:" || !isAbsolute(env.LEDGER_PATH))) {
    throw new Error("Invalid hosted configuration");
  } else if (env.LEDGER_BACKEND === "turso" && (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN?.trim() || env.LEDGER_PATH)) {
    throw new Error("Invalid hosted configuration");
  }
  if (env.LEDGER_BACKEND === "turso") {
    try { validateTursoUrl(env.TURSO_DATABASE_URL!); } catch { throw new Error("Invalid hosted configuration"); }
  }
  return { hosted: true, origin: parsed.origin, adminPassword: env.ADMIN_PASSWORD, secret: env.HOSTED_SECRET };
}
