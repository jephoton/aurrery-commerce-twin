import { generateSyntheticHistory, type SyntheticTruth } from "@/twin/synthetic-history";
import type { ReasonCounts } from "@/twin/build-twin";
import type { ReasonId, SegmentId } from "@/twin/types";
import { historyCsv, historyRowsFromTwin, toCsv } from "./csv-write";
import { FEEDBACK_COLUMNS } from "./feedback-csv";
import type { HistoryRow } from "./history-csv";
import type { SAMPLE_FILES } from "./sample-files";

// Hollowbrook Treat Box: a fictional $20/month dog-treat box, the sample "second merchant".
// SYNTHETIC, like Ridgeline: generated once from these fixed rates and seed. Its core subscribers
// rarely cancel, so an annual prepay discount buys little retention. Price-sensitive subscribers
// often slip into at risk, where half cancel each month but most of those who stay recover. On
// history alone, a broad at-risk discount is the move here: the opposite of Ridgeline's lesson.
// Its feedback (at-risk leavers mostly cite price) sharpens that story but is not needed for it.

export const SAMPLE_TRUTH: SyntheticTruth = {
  churn: { new: 0.12, core: 0.015, price_sensitive: 0.03, at_risk: 0.5, cancel_intent: 0.4 },
  involuntary: 0.004,
  newGraduation: 0.4,
  newToPriceSensitive: 0.5,
  coreToAtRisk: 0.015,
  priceSensitiveToAtRisk: 0.15,
  atRiskRecovery: 0.75,
  atRiskToCancelIntent: 0.12,
  cancelIntentToAtRisk: 0.1,
  acquisitionMean: 26,
  acquisitionSd: 5,
};
const SAMPLE_START: Record<SegmentId, number> = { new: 45, core: 100, price_sensitive: 90, at_risk: 25, cancel_intent: 6 };
const SAMPLE_MONTHS = 12;
const SAMPLE_SEED = 7311;
const SAMPLE_AS_OF = "2026-10";

const PRICE = [
  "The box is too expensive for us now. Twenty dollars a month adds up.",
  "Money is tight this month, so the treat box is the first thing to go.",
  "I love the treats but I can't justify the price anymore.",
  "Found similar treats at the pet store for half the cost.",
  "Please lower the price or I'll have to cancel.",
  "We're cutting back on subscriptions to save money.",
  "It was good value at first, but lately it feels overpriced.",
  "Once I added up a year of boxes, it felt far too expensive.",
  "My budget changed after a job loss, so I need something cheaper.",
  "A discount would keep me around; otherwise it's too pricey.",
  "The treats are great. The cost is the problem.",
  "Paying for this every month is hard on a pension.",
  "Too much money for a handful of biscuits.",
  "I'm skipping boxes because I can't afford them right now.",
  "Cheaper options exist and my dog doesn't notice the difference.",
  "If it were fifteen dollars I'd stay without thinking.",
  "Rent went up, so small luxuries like this have to go.",
  "I'd keep it if there were a smaller, cheaper box.",
  "Honestly, it's just not worth twenty dollars to me.",
  "We need to trim expenses and this is an easy cut.",
  "The value isn't there for the price.",
  "I paused because money is tight, and I may cancel.",
  "Love it, but I'm switching to a budget brand to save money.",
  "Cost is the only reason I'm leaving.",
];
const OTHER = [
  "My dog developed a chicken allergy and most of the treats contain chicken.",
  "We're moving overseas and you don't ship there.",
  "The last two boxes arrived crushed.",
  "Our dog passed away last month. Thank you for the treats.",
  "My vet put her on a strict diet, so no more treats for now.",
  "Deliveries keep arriving late and sit outside in the rain.",
  "He just doesn't like the flavours lately.",
  "We already have too many treats piling up in the cupboard.",
  "The box is lovely, but my puppy is teething and can't chew these.",
  "Boxes keep going to my old flat after I moved.",
  "Too much packaging for my taste; I'm trying to reduce waste.",
  "My sister gives us treats from her shop now.",
  "The treats are too hard for my senior dog's teeth.",
  "Support never answered my email about a missing box.",
  "We're travelling for three months and won't need deliveries.",
  "I prefer to pick treats in person with my dog.",
];
/** How many price- and other-reason rows each segment gets, in order from PRICE and OTHER. */
export const SAMPLE_REASON_COUNTS: ReasonCounts = {
  new: { price: 1, other: 4 },
  core: { price: 1, other: 4 },
  price_sensitive: { price: 5, other: 1 },
  at_risk: { price: 16, other: 2 },
  cancel_intent: { price: 1, other: 5 },
};

/** Intended labels are for tests only; the CSV carries only segment and text. */
export const SAMPLE_FEEDBACK: { segment: SegmentId; text: string; reason: ReasonId }[] = (() => {
  let p = 0, o = 0;
  return (Object.keys(SAMPLE_REASON_COUNTS) as SegmentId[]).flatMap((segment) => [
    ...Array.from({ length: SAMPLE_REASON_COUNTS[segment].price }, () => ({ segment, text: PRICE[p++], reason: "price" as const })),
    ...Array.from({ length: SAMPLE_REASON_COUNTS[segment].other }, () => ({ segment, text: OTHER[o++], reason: "other" as const })),
  ]);
})();

/** Header plus one example month that satisfies every rule. */
const TEMPLATE_ROWS: HistoryRow[] = [
  { month: "2026-09", segment: "new", active_start: 120, voluntary_cancels: 14, involuntary_cancels: 2, moved_to_core: 25, moved_to_price_sensitive: 20, moved_to_at_risk: 0, moved_to_cancel_intent: 0, new_signups: 60 },
  { month: "2026-09", segment: "core", active_start: 900, voluntary_cancels: 25, involuntary_cancels: 9, moved_to_core: 0, moved_to_price_sensitive: 0, moved_to_at_risk: 30, moved_to_cancel_intent: 0, new_signups: 60 },
  { month: "2026-09", segment: "price_sensitive", active_start: 400, voluntary_cancels: 24, involuntary_cancels: 4, moved_to_core: 0, moved_to_price_sensitive: 0, moved_to_at_risk: 18, moved_to_cancel_intent: 0, new_signups: 60 },
  { month: "2026-09", segment: "at_risk", active_start: 150, voluntary_cancels: 30, involuntary_cancels: 2, moved_to_core: 20, moved_to_price_sensitive: 0, moved_to_at_risk: 0, moved_to_cancel_intent: 15, new_signups: 60 },
  { month: "2026-09", segment: "cancel_intent", active_start: 40, voluntary_cancels: 14, involuntary_cancels: 1, moved_to_core: 0, moved_to_price_sensitive: 0, moved_to_at_risk: 8, moved_to_cancel_intent: 0, new_signups: 60 },
];

export function sampleHistory() {
  return generateSyntheticHistory({ truth: SAMPLE_TRUTH, startActive: SAMPLE_START, months: SAMPLE_MONTHS, seed: SAMPLE_SEED, asOfMonth: SAMPLE_AS_OF }).history;
}

export function sampleMerchantFiles(): Record<keyof typeof SAMPLE_FILES, string> {
  return {
    template: historyCsv(TEMPLATE_ROWS),
    history: historyCsv(historyRowsFromTwin(sampleHistory())),
    feedback: toCsv(FEEDBACK_COLUMNS, SAMPLE_FEEDBACK.map((f) => [f.segment, f.text])),
  };
}
