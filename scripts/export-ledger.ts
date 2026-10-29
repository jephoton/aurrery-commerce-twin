import { exportLedgerCli } from "@/ledger/export";

exportLedgerCli(process.argv.slice(2)).then(manifest => {
  console.log(JSON.stringify(manifest, null, 2));
}).catch(() => {
  console.error("Ledger export was not confirmed. Check authority and private output before retrying; details suppressed.");
  process.exitCode = 1;
});
