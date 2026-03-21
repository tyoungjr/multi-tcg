import dotenv from "dotenv";
dotenv.config();

import { syncOrders } from "../services/shopify-sync";

function printUsage(): void {
  console.log("Sync Shopify orders - marks sold products in Supabase\n");
  console.log("Usage:");
  console.log("  npm run shopify:orders                          Sync all orders");
  console.log("  npm run shopify:orders -- --since 2026-01-01    Only orders after date");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help")) {
    printUsage();
    return;
  }

  const sinceIdx = args.indexOf("--since");
  const sinceDate = sinceIdx !== -1 ? args[sinceIdx + 1] : undefined;

  console.log(
    `Syncing Shopify orders${sinceDate ? ` since ${sinceDate}` : ""}...\n`
  );

  const { synced, skipped, errors } = await syncOrders(sinceDate);

  console.log(
    `\nDone. ${synced} marked sold, ${skipped} skipped, ${errors} errors.`
  );
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
