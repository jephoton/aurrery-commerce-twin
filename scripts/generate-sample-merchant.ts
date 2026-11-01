// Writes the committed import template and sample merchant CSVs. Deterministic: rerunning must not
// change them (src/import/sample-merchant.test.ts compares the committed files with the generator).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SAMPLE_FILES } from "../src/import/sample-files";
import { sampleMerchantFiles } from "../src/import/sample-merchant";

const files = sampleMerchantFiles();
for (const key of Object.keys(SAMPLE_FILES) as (keyof typeof SAMPLE_FILES)[]) {
  const path = join(process.cwd(), "public", SAMPLE_FILES[key]);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, files[key]);
}
console.log(`Wrote ${Object.keys(files).length} sample files.`);
