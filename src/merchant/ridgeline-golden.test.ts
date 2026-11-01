import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildDemoTwin } from "./demo";

// Byte-for-byte guard for the shared twin builder (M6): Ridgeline's twin and history must not change.
// Regenerate only for an intentional model change:
//   UPDATE_RIDGELINE_GOLDEN=1 npx vitest run src/merchant/ridgeline-golden.test.ts
const fixture = join(process.cwd(), "src", "merchant", "fixtures", "ridgeline-golden.json");

// Always LF and a single trailing newline, whatever the platform or git autocrlf setting.
const serialized = () => `${JSON.stringify(buildDemoTwin(), null, 2)}\n`;
const recorded = () => readFileSync(fixture, "utf8").replace(/\r\n/g, "\n");

it("builds exactly the recorded Ridgeline twin and history", () => {
  const actual = serialized();
  // JSON.stringify turns NaN and Infinity into null, which would hide a broken number in the record.
  expect(actual).not.toMatch(/:\s*null\b/);
  if (process.env.UPDATE_RIDGELINE_GOLDEN === "1") writeFileSync(fixture, actual, { encoding: "utf8" });
  expect(actual).toBe(recorded());
});
