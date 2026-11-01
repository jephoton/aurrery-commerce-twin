// Display-only draft an administrator copies and sends by hand. Aurrery never sends it. The text
// carries the subscriber's secret approval link: never log it or show it to visitors.

import { parseIsoInstant } from "./annual-offer-status";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Explicit formatting (no Intl) so the text is identical on every Node build and locale.
function formatUtcInstant(ms: number): string {
  const d = new Date(ms);
  const hour12 = d.getUTCHours() % 12 === 0 ? 12 : d.getUTCHours() % 12;
  const minute = String(d.getUTCMinutes()).padStart(2, "0");
  const meridiem = d.getUTCHours() < 12 ? "AM" : "PM";
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${hour12}:${minute} ${meridiem} UTC`;
}

export function draftAnnualOfferMessage(input: {
  merchantName: string; planName: string; annualPrice: string; discountPct: number; expiresAt: string; approvalUrl: string;
}): string {
  const closesMs = parseIsoInstant(input.expiresAt);
  if (closesMs === null) throw new RangeError("Invalid expiresAt");
  const closes = formatUtcInstant(closesMs);
  return [
    `Hi from ${input.merchantName}.`,
    `You can switch your ${input.planName} subscription to a yearly plan for $${input.annualPrice} a year, ${input.discountPct}% less than twelve monthly payments.`,
    "Nothing changes unless you agree in PayPal. If you do, the yearly price is charged from your next renewal date.",
    `This offer is open until ${closes}. Review and approve it here: ${input.approvalUrl}`,
  ].join("\n\n");
}
