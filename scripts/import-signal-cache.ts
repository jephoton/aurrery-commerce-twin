import { readFile } from "node:fs/promises";
import { importSignalCache } from "@/signals/cache-import";
import { selectedProvider } from "@/agent/model";

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0] || /^[a-z][a-z0-9+.-]*:\/\//i.test(args[0])) throw new Error("One explicit local artifact path is required.");
  const selected = selectedProvider(process.env);
  const source: unknown = JSON.parse(await readFile(args[0], "utf8"));
  const result = importSignalCache(source, selected);
  console.log(`Imported ${result.imported} classifier cache entries for ${result.provider}/${result.model}.`);
}
main().catch(() => {
  console.error("Cache import failed. Supply one local fresh evaluation artifact matching the explicit selected provider/model and current classification fingerprints. Details suppressed.");
  process.exitCode = 1;
});
