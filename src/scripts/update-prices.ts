import dotenv from "dotenv";
dotenv.config();

import { updateAllPrices } from "../services/price-updater";

async function main(): Promise<void> {
  console.log("Updating prices from PriceCharting...\n");

  const results = await updateAllPrices();

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  console.log(`\nDone. ${succeeded} updated, ${failed} skipped.`);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
