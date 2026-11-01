import { exportLedgerCli } from "@/ledger/export";
import { ApprovalLinkLeakError } from "@/ledger/import";

exportLedgerCli(process.argv.slice(2)).then(manifest => {
  console.log(JSON.stringify(manifest, null, 2));
}).catch((error) => {
  // Fixed text naming only a table and column; every other failure stays suppressed.
  if (error instanceof ApprovalLinkLeakError) console.error(`Ledger export was not confirmed: ${error.message}. Remove that copy, then retry.`);
  else console.error("Ledger export was not confirmed. Check authority and private output before retrying; details suppressed.");
  process.exitCode = 1;
});
