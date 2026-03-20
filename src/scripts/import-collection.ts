import dotenv from "dotenv";
dotenv.config();

import { supabase } from "../lib/supabase";
import { getCollection, getProductById } from "../lib/pricecharting";
import type { PriceChartingOffer } from "../types/pricecharting";
import type { ProductInsert } from "../types/database";

function getSellerId(): string {
  const id = process.env.PRICECHARTING_SELLER_ID;
  if (!id) {
    throw new Error(
      "Missing PRICECHARTING_SELLER_ID in environment. " +
        "Find your seller ID on your PriceCharting profile URL and add it to .env"
    );
  }
  return id;
}

function mapConsoleToCategoryAndPlatform(
  consoleName: string
): { category: ProductInsert["category"]; platform?: string } {
  const lower = consoleName.toLowerCase();

  if (
    lower.includes("pokemon") ||
    lower.includes("yugioh") ||
    lower.includes("magic") ||
    lower.includes("card")
  ) {
    return { category: "trading_card" };
  }

  if (lower.includes("comic")) {
    return { category: "comic" };
  }

  if (lower.includes("coin") || lower.includes("currency")) {
    return { category: "coin" };
  }

  // Everything else is likely a video game console
  return { category: "video_game", platform: consoleName };
}

function mapConditionString(
  condStr: string
): ProductInsert["condition"] {
  const lower = condStr.toLowerCase();
  if (lower.includes("new") || lower.includes("sealed")) return "new_sealed";
  if (lower.includes("cib") || lower.includes("complete")) return "cib";
  if (lower.includes("graded")) return "graded";
  if (lower.includes("good")) return "good";
  if (lower.includes("very good")) return "very_good";
  return "loose";
}

async function importCollection(): Promise<void> {
  const sellerId = getSellerId();
  const dryRun = process.argv.includes("--dry-run");

  console.log(`Fetching PriceCharting collection for seller: ${sellerId}...`);
  const offers = await getCollection(sellerId);

  if (offers.length === 0) {
    console.log("No collection items found.");
    return;
  }

  console.log(`Found ${offers.length} collection item(s).\n`);

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const offer of offers) {
    const productName = offer["product-name"];
    const consoleName = offer["console-name"];

    // Check if already imported (by pricecharting_id or matching title)
    const pcProductId = offer.id ?? null;
    if (pcProductId) {
      const { data: existing } = await supabase
        .from("products")
        .select("id, title")
        .eq("pricecharting_id", pcProductId)
        .limit(1);

      if (existing && existing.length > 0) {
        console.log(`  SKIP  ${productName} (${consoleName}) - already in DB as "${existing[0].title}"`);
        skipped++;
        continue;
      }
    }

    const { category, platform } = mapConsoleToCategoryAndPlatform(consoleName);
    const condition = mapConditionString(offer["condition-string"] ?? "");

    const metadata: Record<string, unknown> = {};
    if (platform) metadata.platform = platform;
    if (consoleName) metadata.console_name = consoleName;

    const insert: ProductInsert = {
      title: productName,
      category,
      condition,
      inventory_status: "personal_collection",
      pricecharting_id: pcProductId ?? undefined,
      current_price: offer.price > 0 ? offer.price : undefined,
      purchase_price: offer["cost-basis"] ?? undefined,
      metadata,
      quantity: offer.quantity ?? 1,
    };

    if (dryRun) {
      console.log(`  DRY   ${productName} (${consoleName}) -> ${category}, ${condition}`);
      imported++;
      continue;
    }

    // Fetch full product data from prices API for market price
    let marketPrice: number | undefined;
    if (pcProductId) {
      try {
        const fullProduct = await getProductById(pcProductId);
        // Use loose price as default market price
        if (condition === "cib" && fullProduct["cib-price"]) {
          marketPrice = fullProduct["cib-price"];
        } else if (condition === "new_sealed" && fullProduct["new-price"]) {
          marketPrice = fullProduct["new-price"];
        } else if (fullProduct["loose-price"]) {
          marketPrice = fullProduct["loose-price"];
        }
      } catch {
        // Price lookup failed, continue without market price
      }
    }

    if (marketPrice) {
      insert.market_price = marketPrice;
    }

    const { error } = await supabase.from("products").insert(insert);

    if (error) {
      console.error(`  ERR   ${productName}: ${error.message}`);
      errors++;
    } else {
      const priceStr = marketPrice ? ` @ $${(marketPrice / 100).toFixed(2)}` : "";
      console.log(`  ADD   ${productName} (${consoleName}) -> ${category}${priceStr}`);
      imported++;
    }
  }

  console.log(`\nDone${dryRun ? " (dry run)" : ""}. ${imported} imported, ${skipped} skipped, ${errors} errors.`);
}

function printUsage(): void {
  console.log("Import your PriceCharting collection into Supabase\n");
  console.log("Usage:");
  console.log("  npm run collection:import              Import collection");
  console.log("  npm run collection:import -- --dry-run  Preview without writing");
  console.log("\nRequires PRICECHARTING_SELLER_ID in .env");
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    printUsage();
    return;
  }

  await importCollection();
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
