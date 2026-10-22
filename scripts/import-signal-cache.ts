import { readFile } from "node:fs/promises";
import { importSignalCache } from "@/signals/cache-import";

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0] || /^[a-z][a-z0-9+.-]*:\/\//i.test(args[0])) throw new Error("One explicit local artifact path is required.");
  if (process.env.AI_PROVIDER !== "groq" || !process.env.GROQ_MODEL) throw new Error("Configure AI_PROVIDER=groq and GROQ_MODEL first.");
  const source: unknown = JSON.parse(await readFile(args[0], "utf8"));
  const result = importSignalCache(source, { provider: "groq", model: process.env.GROQ_MODEL });
  console.log(`Imported ${result.imported} classifier cache entries for ${result.provider}/${result.model}.`);
}
main().catch(() => {
  console.error("Cache import failed. Supply one local fresh M2 evaluation artifact matching AI_PROVIDER=groq, GROQ_MODEL and the current classification fingerprints. Details suppressed.");
  process.exitCode = 1;
});
