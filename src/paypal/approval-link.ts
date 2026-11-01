/** A customer approval link must be a PayPal https URL. It is a per-subscriber secret: never log or echo it. */
export function isPayPalApprovalUrl(href: string): boolean {
  try {
    const u = new URL(href);
    return u.protocol === "https:" && (u.hostname === "paypal.com" || u.hostname.endsWith(".paypal.com"));
  } catch {
    return false;
  }
}
