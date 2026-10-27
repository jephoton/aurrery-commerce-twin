import { observedMerchant } from "@/merchant/observed";
import { connection } from "next/server";
import { errorResponse } from "../_lib/http";

export async function GET() {
  await connection();
  try {
    const { twin, history, evidence, changes } = await observedMerchant();
    return Response.json({ twin, history, evidence, changes, dataLabel: "Synthetic demo history with separately measured sandbox evidence" });
  } catch (error) { return errorResponse(error); }
}
