/** A customer approval link must be a PayPal https URL. It is a per-subscriber secret: never log or echo it. */
export function isPayPalApprovalUrl(href: string): boolean {
  try {
    const u = new URL(href);
    // Real approval links carry no port or credentials; reject anything that could disguise the host.
    if (href !== href.trim() || u.username !== "" || u.password !== "" || u.port !== "") return false;
    return u.protocol === "https:" && (u.hostname === "paypal.com" || u.hostname.endsWith(".paypal.com"));
  } catch {
    return false;
  }
}
