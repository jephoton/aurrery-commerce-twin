import { SAMPLE_ECONOMICS } from "@/import/economics";
import { parseHistoryCsv } from "@/import/history-csv";
import { toTuple, type ImportPayload } from "@/import/import-payload";
import { SAMPLE_REASON_COUNTS, sampleMerchantFiles } from "@/import/sample-merchant";

/** The committed sample merchant as the browser would send it, with or without classified feedback. */
export function samplePayload(options: { feedback?: boolean } = {}): ImportPayload {
  const parsed = parseHistoryCsv(sampleMerchantFiles().history);
  if (!parsed.ok) throw new Error("The sample history must parse.");
  return {
    rows: parsed.rows.map(toTuple),
    economics: { ...SAMPLE_ECONOMICS },
    ...(options.feedback === false ? {} : { reasonCounts: structuredClone(SAMPLE_REASON_COUNTS) }),
  };
}
