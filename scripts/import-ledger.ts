import { importLedger } from "@/ledger/import";

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0];
  if ((mode !== "--dry-run" && mode !== "--apply") || args[1] !== "--source" || !args[2] || args.length !== 3) {
    throw new Error("Use --dry-run|--apply --source <absolute SQLite path>");
  }
  const manifest = await importLedger({ sourcePath: args[2], dryRun: mode === "--dry-run" });
  console.log(JSON.stringify(manifest, null, 2));
}
main().catch(() => {
  console.error("Ledger import was not confirmed. Check the source and authoritative target state before retrying; details suppressed.");
  process.exitCode = 1;
});
