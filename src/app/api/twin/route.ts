import { currentMerchant } from "@/merchant";

export function GET() {
  const { twin, history } = currentMerchant();
  return Response.json({ twin, history, dataLabel: "Synthetic demo history (not real merchant data)" });
}
