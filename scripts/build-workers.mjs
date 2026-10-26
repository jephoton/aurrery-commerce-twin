import { build } from "esbuild";

await build({
  entryPoints: ["src/twin/worker-entry.ts"],
  outfile: "build/twin-worker.cjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  logLevel: "warning",
});
