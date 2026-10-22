// Verifies the hero PayPal operation against the live sandbox: override one subscription's price,
// read it back, then restore it.
//
//   npm run paypal:check                   uses the first registered pilot subscription
//   npm run paypal:check -- I-XXXXXXXXXX   uses a specific subscription

import { listSandboxSubscribers } from "@/ledger/proposals";
import { getSubscription, overrideSubscriptionPrice, type PatchOperation } from "@/paypal/subscriptions";

const TEST_PRICE = "23.45";

async function main() {
  const id = process.argv[2] ?? listSandboxSubscribers()[0]?.subscriptionId;
  if (!id) throw new Error("No subscription given and none registered. Run npm run paypal:setup first.");

  const before = await getSubscription(id);
  if (!before.ok) throw new Error(`Read failed: ${JSON.stringify(before.error)}`);
  console.log("before", { status: before.value.status, regularPrice: before.value.regularPrice, overridden: before.value.planOverridden });
  if (before.value.status !== "ACTIVE" && before.value.status !== "SUSPENDED") {
    throw new Error(`Subscription is ${before.value.status}; approve it as a sandbox buyer first.`);
  }
  const original = before.value.regularPrice ?? "24.00";

  let workingOperation: PatchOperation | null = null;
  for (const operation of ["replace", "add"] as const) {
    const r = await overrideSubscriptionPrice(id, TEST_PRICE, 1, operation);
    console.log(`PATCH op=${operation}`, r.ok ? { httpStatus: r.value.httpStatus, debugId: r.debugId } : r.error);
    if (r.ok) {
      workingOperation = operation;
      break;
    }
  }
  if (!workingOperation) throw new Error("PayPal accepted neither replace nor add.");

  const after = await getSubscription(id);
  if (after.ok) {
    console.log("read-back", { regularPrice: after.value.regularPrice, overridden: after.value.planOverridden, debugId: after.debugId });
    console.log("raw plan", JSON.stringify((after.value.raw as { plan?: unknown }).plan ?? null, null, 2));
  } else {
    console.log("read-back failed", after.error);
  }
  const verified = after.ok && Number(after.value.regularPrice) === Number(TEST_PRICE);
  console.log(verified ? "VERIFIED: read-back shows the override" : "NOT VERIFIED: read-back does not show the override");

  const restore = await overrideSubscriptionPrice(id, original, 1, workingOperation);
  console.log("restore", restore.ok ? { to: original, httpStatus: restore.value.httpStatus, debugId: restore.debugId } : restore.error);
  console.log(`\nResult: operation=${workingOperation} verified=${verified}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
