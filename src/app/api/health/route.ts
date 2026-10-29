import { connection } from "next/server";
import { readiness } from "@/hosting/readiness";

export async function GET() {
  await connection();
  return readiness();
}
