// Verifies the hero PayPal operation against the live sandbox: override one subscription's price,
// read it back, then restore it.
//
//   npm run paypal:check                   uses the first registered loyal ("core") pilot subscription
//   npm run paypal:check -- I-XXXXXXXXXX   uses a specific subscription
//
// The default target is the loyal/core pilot (Pilot D), not a hero-demo subscription. The restore
// re-sets the price, but PayPal likely leaves plan_overridden=true on that subscription afterwards.

import { listSandboxSubscribers } from "@/ledger/proposals";
import { getSubscription, overrideSubscriptionPrice, type PatchOperation } from "@/paypal/subscriptions";

const TEST_PRICE = "23.45";

async function main() {
  const id = process.argv[2] ?? (await listSandboxSubscribers()).find((s) => s.segment === "core")?.subscriptionId;
  if (!id) throw new Error("No subscription given and no core pilot registered. Pass an explicit subscription id.");

  const before = await getSubscription(id);
  if (!before.ok) throw new Error(`Read failed: ${JSON.stringify(before.error)}`);
  console.log("before", { status: before.value.status, regularPrice: before.value.regularPrice, overridden: before.value.planOverridden });
  if (before.value.status !== "ACTIVE" && before.value.status !== "SUSPENDED") {
    throw new Error(`Subscription is ${before.value.status}; approve it as a sandbox buyer first.`);
  }
  if (Number(before.value.regularPrice) === Number(TEST_PRICE)) {
    throw new Error(
      `${id} is already at ${TEST_PRICE}: it appears stuck at the test price from a previous run. Restore it by hand to the plan price first.`,
    );
  }
  if (before.value.regularPrice == null) console.log("regularPrice not returned by GET; assuming plan price 24.00");
  const original = before.value.regularPrice ?? "24.00";

  let workingOperation: PatchOperation | null = null;
  for (const operation of ["replace", "add"] as const) {
    const r = await overrideSubscriptionPrice(id, TEST_PRICE, 1, operation);
    console.log(`PATCH op=${operation}`, r.ok ? { httpStatus: r.value.httpStatus, debugId: r.debugId } : r.error);
    if (r.ok) {
      workingOperation = operation;
      break;
    }
    // Only a 400/422 means "this op isn't valid for that path"; anything else is not worth retrying.
    if (r.error.httpStatus !== 400 && r.error.httpStatus !== 422) {
      if (r.error.httpStatus === null) {
        const check = await getSubscription(id);
        console.log(
          "PATCH outcome unknown (network/timeout); current price:",
          check.ok ? check.value.regularPrice : check.error,
        );
      }
      throw new Error(`PATCH op=${operation} failed with HTTP ${r.error.httpStatus}; not trying other operations.`);
    }
  }
  if (!workingOperation) throw new Error("PayPal accepted neither replace nor add.");

  const after = await getSubscription(id);
  let verified = false;
  if (after.ok) {
    console.log("read-back", {
      regularPrice: after.value.regularPrice,
      overridden: `${before.value.planOverridden} → ${after.value.planOverridden}`,
      debugId: after.debugId,
    });
    // The SDK's camelCased view of the plan, not PayPal's raw JSON.
    console.log("raw plan", JSON.stringify((after.value.raw as { plan?: unknown }).plan ?? null, null, 2));
    verified =
      Number(after.value.regularPrice) === Number(TEST_PRICE) &&
      Number(before.value.regularPrice) !== Number(after.value.regularPrice);
  } else {
    console.log("read-back failed", after.error);
  }
  console.log(verified ? "VERIFIED: read-back shows the override" : "NOT VERIFIED: read-back does not show the override");

  const restore = await overrideSubscriptionPrice(id, original, 1, workingOperation);
  if (restore.ok) {
    console.log("restore", { to: original, httpStatus: restore.value.httpStatus, debugId: restore.debugId });
  } else {
    console.log("restore", restore.error);
    console.error(`RESTORE FAILED: ${id} is still at ${TEST_PRICE} — restore it to ${original} by hand`);
    process.exitCode = 1;
  }
  console.log(`\nResult: operation=${workingOperation} verified=${verified} restored=${restore.ok}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
