import { buildDemoTwin, type DemoHistory } from "./demo";
import type { MerchantTwin } from "@/twin/types";

// Single source of the merchant twin for the server. Today: the synthetic demo merchant.

let cached: { twin: MerchantTwin; history: DemoHistory } | null = null;

export function currentMerchant() {
  cached ??= buildDemoTwin();
  return structuredClone(cached);
}
