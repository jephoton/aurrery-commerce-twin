import "server-only";
import { statSync, accessSync, constants } from "node:fs";
import { resolve } from "node:path";
import { runtimeLedgerConnection } from "@/ledger/connection";
import { authoritativeWrite } from "@/ledger/operations";
import { deploymentConfiguration } from "./deployment";

type Dependencies = { validate(): void; worker(): void; probe(): Promise<void> };
const response = (ready: boolean) => Response.json({ status: ready ? "ready" : "unavailable" }, { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } });

export function createReadiness(dependencies: Dependencies): () => Promise<Response> {
  let pending: Promise<boolean> | undefined;
  let cached: { ready: boolean; until: number } | undefined;
  return async () => {
    try { dependencies.validate(); dependencies.worker(); } catch { return response(false); }
    if (cached && Date.now() < cached.until) return response(cached.ready);
    if (!pending) {
      pending = Promise.resolve().then(dependencies.probe).then(() => true, () => false).then((ready) => {
        cached = { ready, until: Date.now() + 2_000 };
        pending = undefined;
        return ready;
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const expired = new Promise<boolean>((done) => { timer = setTimeout(() => done(false), 3_500); });
      // A response deadline never releases the slot. The SDK retains ownership
      // until its bounded underlying operation settles, including initialization.
      return response(await Promise.race([pending, expired]));
    } finally { clearTimeout(timer); }
  };
}

const key = Symbol.for("aurrery.hosting.readiness");
const registry = globalThis as typeof globalThis & { [key: symbol]: (() => Promise<Response>) | undefined };
export function readiness(): Promise<Response> {
  const handler = registry[key] ??= createReadiness({
    validate: deploymentConfiguration,
    worker() {
      const path = resolve(process.cwd(), "build", "twin-worker.cjs");
      if (!statSync(path).isFile() || statSync(path).size === 0) throw new Error();
      accessSync(path, constants.R_OK);
    },
    async probe() {
      await authoritativeWrite(await runtimeLedgerConnection(), async (tx) => {
        const rows = await tx.query("SELECT COUNT(*) AS n FROM kv WHERE key = ?", ["readiness.probe"]);
        if (rows.length !== 1 || !Number.isInteger(Number(rows[0].n))) throw new Error();
      });
    },
  });
  return handler();
}
