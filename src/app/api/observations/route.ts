import { connection } from "next/server";
import { listSafeObservations } from "@/ledger/webhooks";

export async function GET() {
  await connection();
  try { return Response.json({ observations: await listSafeObservations() }); }
  catch { return Response.json({ error: "OBSERVATIONS_UNAVAILABLE" }, { status: 503 }); }
}
