/** Exact demo cohort labels and attributes; replacement subscription IDs come from the registry. */
export const PILOT_COHORT = [
  { label: "Pilot A: \"honestly it's just too expensive right now\"", segment: "cancel_intent", reason: "price" },
  { label: "Pilot B: \"can't justify $24 a month anymore\"", segment: "cancel_intent", reason: "price" },
  { label: "Pilot C: \"moving abroad next month\"", segment: "cancel_intent", reason: "other" },
  { label: "Pilot D: loyal, 14 months", segment: "core", reason: "other" },
] as const;
