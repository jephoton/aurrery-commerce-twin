// Display-only draft an administrator copies and sends by hand. Aurrery never sends it. The text
// carries the subscriber's secret approval link: never log it or show it to visitors.

export function draftAnnualOfferMessage(input: {
  merchantName: string; planName: string; annualPrice: string; discountPct: number; expiresAt: string; approvalUrl: string;
}): string {
  const closes = new Date(input.expiresAt);
  if (Number.isNaN(closes.getTime())) throw new RangeError("Invalid expiresAt");
  const date = closes.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  return [
    `Hi from ${input.merchantName}.`,
    `You can switch your ${input.planName} subscription to a yearly plan for $${input.annualPrice} a year, ${input.discountPct}% less than twelve monthly payments.`,
    "Nothing changes unless you agree in PayPal. If you do, the yearly price is charged from your next renewal date.",
    `This offer is open until ${date} (UTC). Review and approve it here: ${input.approvalUrl}`,
  ].join("\n\n");
}
