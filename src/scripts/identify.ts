import dotenv from "dotenv";
dotenv.config();

import { existsSync } from "fs";
import {
  visualSearchFromFile,
  visualSearchFromUrl,
} from "../services/visual-search";
import type { SearchOptions } from "../services/visual-search";
import type { VisualSearchResult } from "../types/visual-search";
import type { Product, ProductInsert, ProductCategory, ProductCondition, InventoryStatus } from "../types/database";
import { supabase } from "../lib/supabase";
import { pushProductToShopify } from "../services/shopify-sync";

function formatPrice(cents: number | undefined): string {
  if (!cents || cents === 0) return "-";
  return `$${(cents / 100).toFixed(2)}`;
}

function parseDollars(value: string): number {
  const cleaned = value.replace("$", "").trim();
  const num = parseFloat(cleaned);
  if (isNaN(num)) {
    throw new Error(`Invalid price: "${value}"`);
  }
  return Math.round(num * 100);
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith("--")) {
    return args[idx + 1];
  }
  return undefined;
}

function printResult(result: VisualSearchResult): void {
  const { identification: id } = result;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`IDENTIFICATION (${id.confidence} confidence)`);
  console.log(`${"=".repeat(60)}`);
  console.log(`  Title:       ${id.title}`);
  console.log(`  Category:    ${id.category}`);
  console.log(`  Description: ${id.description}`);

  const details = id.details;
  if (details.game) console.log(`  Game:        ${details.game}`);
  if (details.set) console.log(`  Set:         ${details.set}`);
  if (details.card_number) console.log(`  Card #:      ${details.card_number}`);
  if (details.rarity) console.log(`  Rarity:      ${details.rarity}`);
  if (details.variant) console.log(`  Variant:     ${details.variant}`);
  if (details.platform) console.log(`  Platform:    ${details.platform}`);
  if (details.region) console.log(`  Region:      ${details.region}`);
  if (details.year) console.log(`  Year:        ${details.year}`);
  if (details.brand) console.log(`  Brand:       ${details.brand}`);
  if (details.condition_estimate) console.log(`  Condition:   ${details.condition_estimate}`);
  if (details.grading_company) console.log(`  Graded:      ${details.grading_company} ${details.grade ?? ""}`);

  console.log(`\n  Search queries:`);
  console.log(`    Primary:    ${id.search_queries.primary}`);
  console.log(`    eBay:       ${id.search_queries.ebay}`);

  // PriceCharting match
  if (result.pricecharting) {
    const pc = result.pricecharting;
    console.log(`\n${"=".repeat(60)}`);
    console.log(`PRICECHARTING MATCH`);
    console.log(`${"=".repeat(60)}`);
    console.log(`  Product:  ${pc.product_name} (${pc.console_name})`);
    console.log(`  PC ID:    ${pc.pricecharting_id}`);
    console.log(`  Loose:    ${formatPrice(pc.loose_price_cents)}`);
    console.log(`  CIB:      ${formatPrice(pc.cib_price_cents)}`);
    console.log(`  New:      ${formatPrice(pc.new_price_cents)}`);
    if (pc.graded_price_cents) {
      console.log(`  Graded:   ${formatPrice(pc.graded_price_cents)}`);
    }

    // Show alternatives if there were multiple candidates
    if (result.pc_candidates && result.pc_candidates.length > 1) {
      console.log(`\n  Wrong match? Re-run with --pc-pick N:`);
      for (let i = 0; i < result.pc_candidates.length; i++) {
        const c = result.pc_candidates[i];
        const selected = c.pricecharting_id === pc.pricecharting_id ? " <<<" : "";
        console.log(`    [${i}] ${c.product_name} (${c.console_name}) - Loose: ${formatPrice(c.loose_price_cents)}${selected}`);
      }
    }
  }

  // eBay pricing (only shown when used as fallback)
  if (result.ebay_prices && result.ebay_prices.sample_size > 0) {
    const ep = result.ebay_prices;
    console.log(`\n${"=".repeat(60)}`);
    console.log(`EBAY SOLD LISTINGS - FALLBACK (${ep.sample_size} results)`);
    console.log(`${"=".repeat(60)}`);
    console.log(`  Average:  ${formatPrice(ep.average_price_cents)}`);
    console.log(`  Median:   ${formatPrice(ep.median_price_cents)}`);
    console.log(`  Low:      ${formatPrice(ep.low_price_cents)}`);
    console.log(`  High:     ${formatPrice(ep.high_price_cents)}`);

    const topListings = ep.listings.slice(0, 5);
    if (topListings.length > 0) {
      console.log(`\n  Recent sales:`);
      for (const l of topListings) {
        const total = l.price_cents + (l.shipping_cents ?? 0);
        console.log(`    ${formatPrice(total)} - ${l.title.slice(0, 60)}`);
      }
    }
  }

  // Google Lens pricing (only shown when used as fallback)
  if (result.google_lens_prices && result.google_lens_prices.sample_size > 0) {
    const gl = result.google_lens_prices;
    console.log(`\n${"=".repeat(60)}`);
    console.log(`GOOGLE LENS - FALLBACK (${gl.sample_size} results)`);
    console.log(`${"=".repeat(60)}`);
    console.log(`  Average:  ${formatPrice(gl.average_price_cents)}`);
    console.log(`  Median:   ${formatPrice(gl.median_price_cents)}`);
    console.log(`  Low:      ${formatPrice(gl.low_price_cents)}`);
    console.log(`  High:     ${formatPrice(gl.high_price_cents)}`);

    const topResults = gl.results.slice(0, 5);
    if (topResults.length > 0) {
      console.log(`\n  Price matches:`);
      for (const r of topResults) {
        const src = r.source ? ` (${r.source})` : "";
        console.log(`    ${formatPrice(r.price_cents)} - ${r.title.slice(0, 55)}${src}`);
      }
    }
  }

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log(`SUGGESTED MARKET PRICE`);
  console.log(`${"=".repeat(60)}`);
  if (result.suggested_market_price_cents) {
    console.log(`  ${formatPrice(result.suggested_market_price_cents)} (source: ${result.price_source})`);
  } else {
    console.log(`  No pricing data available`);
  }
}

// ---------------------------------------------------------------------------
// Save to database
// ---------------------------------------------------------------------------

async function saveToDatabase(
  result: VisualSearchResult,
  args: string[]
): Promise<void> {
  const { identification: id } = result;

  // Map Claude's category string to our enum
  const categoryMap: Record<string, ProductCategory> = {
    trading_card: "trading_card",
    video_game: "video_game",
    console_hardware: "console_hardware",
    accessory: "accessory",
    arcade: "arcade",
    coin: "coin",
    comic: "comic",
    toy: "toy",
    apparel: "apparel",
    electronics: "electronics",
    promotional: "promotional",
    misc: "misc",
  };

  // Map Claude's condition estimate to our enum
  const conditionMap: Record<string, ProductCondition> = {
    mint: "new_sealed",
    "near mint": "cib",
    "lightly played": "good",
    "moderately played": "good",
    "heavily played": "loose",
    damaged: "loose",
  };

  // Build the product from identification + overrides
  const category =
    (getFlag(args, "--category") as ProductCategory) ??
    categoryMap[id.category] ??
    "misc";

  const autoCondition =
    id.details.condition_estimate
      ? conditionMap[id.details.condition_estimate.toLowerCase()] ?? "loose"
      : "loose";

  const condition =
    (getFlag(args, "--condition") as ProductCondition) ?? autoCondition;

  const status =
    (getFlag(args, "--status") as InventoryStatus) ?? "in_stock";

  // Build metadata from identification details
  const metadata: Record<string, unknown> = { ...id.details };
  delete metadata.condition_estimate;
  delete metadata.grading_company;
  delete metadata.grade;

  // Override title if provided
  const title = getFlag(args, "--title") ?? id.title;

  const insert: ProductInsert = {
    title,
    category,
    description: getFlag(args, "--desc") ?? id.description,
    condition,
    inventory_status: status,
    metadata,
    quantity: parseInt(getFlag(args, "--qty") ?? "1", 10),
  };

  // Grading info
  if (id.details.grading_company) {
    insert.grading_company = getFlag(args, "--grader") ?? id.details.grading_company;
  }
  if (id.details.grade) {
    insert.graded_score = id.details.grade;
    insert.condition = "graded";
  }

  // PriceCharting link
  if (result.pricecharting) {
    insert.pricecharting_id = result.pricecharting.pricecharting_id;
  }

  // Pricing - override or use identified price
  const priceFlag = getFlag(args, "--price");
  if (priceFlag) {
    insert.current_price = parseDollars(priceFlag);
  }

  if (result.suggested_market_price_cents) {
    insert.market_price = result.suggested_market_price_cents;
  }

  // Purchase info overrides
  const paid = getFlag(args, "--paid");
  if (paid) insert.purchase_price = parseDollars(paid);

  const source = getFlag(args, "--source");
  if (source) insert.purchase_source = source;

  const date = getFlag(args, "--date");
  if (date) insert.purchase_date = date;

  const notes = getFlag(args, "--notes");
  if (notes) insert.purchase_notes = notes;

  const upc = getFlag(args, "--upc");
  if (upc) insert.upc = upc;

  const pcId = getFlag(args, "--pc-id");
  if (pcId) insert.pricecharting_id = pcId;

  // Save
  const { data, error } = await supabase
    .from("products")
    .insert(insert)
    .select("id, title, category, condition, current_price, market_price")
    .single();

  if (error) {
    console.error(`\nFailed to save: ${error.message}`);
    process.exit(1);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`SAVED TO DATABASE`);
  console.log(`${"=".repeat(60)}`);
  console.log(`  ID:         ${data.id}`);
  console.log(`  Title:      ${data.title}`);
  console.log(`  Category:   ${data.category}`);
  console.log(`  Condition:  ${data.condition}`);
  console.log(`  Asking:     ${formatPrice(data.current_price)}`);
  console.log(`  Market:     ${formatPrice(data.market_price)}`);

  // Store the visual search result on the image record
  if (result.identification.raw_response) {
    await supabase.from("product_images").insert({
      product_id: data.id,
      is_primary: true,
      visual_search_result: {
        identification: result.identification,
        pricecharting: result.pricecharting,
        price_source: result.price_source,
      },
    });
  }

  // Push to Shopify if --list flag is present
  if (args.includes("--list")) {
    const price = data.current_price ?? data.market_price;
    if (!price || price <= 0) {
      console.log("\n  Skipping Shopify listing - no price set. Use --price to set one.");
      return;
    }

    console.log("\n  Pushing to Shopify...");
    const { data: fullProduct } = await supabase
      .from("products")
      .select("*")
      .eq("id", data.id)
      .single();

    if (fullProduct) {
      const pushResult = await pushProductToShopify(fullProduct as Product);
      if (pushResult.success) {
        console.log(`  LISTED on Shopify (${pushResult.action}) - Product ID: ${pushResult.shopifyProductId}`);
      } else {
        console.error(`  Shopify push failed: ${pushResult.error}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log("Identify a collectible from an image and get pricing\n");
  console.log("Pipeline: Image -> Claude Vision -> PriceCharting -> (fallback: eBay + Google Lens)\n");
  console.log("Usage:");
  console.log('  npm run identify -- photo.jpg                   Identify and price');
  console.log('  npm run identify -- https://example.com/img.jpg Identify from URL');
  console.log('  npm run identify -- photo.jpg --context "Japanese promo card"');
  console.log("  npm run identify -- photo.jpg --id-only         Only identify, no pricing");
  console.log("  npm run identify -- photo.jpg --skip-pc         Skip PriceCharting");
  console.log("  npm run identify -- photo.jpg --no-ebay         Disable eBay fallback");
  console.log("  npm run identify -- photo.jpg --no-lens         Disable Google Lens fallback");
  console.log("  npm run identify -- photo.jpg --pc-pick 2       Use PriceCharting result #2 instead of auto-match");
  console.log("");
  console.log("Save to database:");
  console.log("  npm run identify -- photo.jpg --save");
  console.log("  npm run identify -- photo.jpg --save --title \"Display Box - Charizard\"");
  console.log("  npm run identify -- photo.jpg --save --condition loose --price 12.99");
  console.log("  npm run identify -- photo.jpg --save --status personal_collection");
  console.log("  npm run identify -- photo.jpg --save --notes \"display box only, no cards\"");
  console.log("");
  console.log("Save + list on Shopify (one shot):");
  console.log("  npm run identify -- photo.jpg --save --list --price 29.99");
  console.log("  npm run identify -- photo.jpg --save --list --price 49.99 --condition cib");
  console.log("");
  console.log("Save overrides:");
  console.log("  --title      Override identified title");
  console.log("  --desc       Override description");
  console.log("  --category   Override category (trading_card, video_game, etc.)");
  console.log("  --condition  loose|good|very_good|cib|new_sealed|graded");
  console.log("  --status     in_stock|listed_shopify|listed_ebay|sold|personal_collection");
  console.log("  --price      Asking price in dollars (e.g. 12.99)");
  console.log("  --paid       Purchase price in dollars");
  console.log("  --source     Where you bought it");
  console.log("  --date       Purchase date (YYYY-MM-DD)");
  console.log("  --notes      Notes about the item");
  console.log("  --qty        Quantity (default 1)");
  console.log("  --upc        UPC barcode");
  console.log("  --pc-id      Override PriceCharting product ID");
  console.log("  --grader     Override grading company");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help")) {
    printUsage();
    return;
  }

  const source = args[0];
  const shouldSave = args.includes("--save");

  const pcPickStr = getFlag(args, "--pc-pick");

  const options: SearchOptions = {
    identifyOnly: args.includes("--id-only"),
    skipPriceCharting: args.includes("--skip-pc"),
    skipEbay: args.includes("--no-ebay"),
    skipGoogleLens: args.includes("--no-lens"),
    additionalContext: getFlag(args, "--context"),
    pcPick: pcPickStr !== undefined ? parseInt(pcPickStr, 10) : undefined,
  };

  let result: VisualSearchResult;

  if (source.startsWith("http://") || source.startsWith("https://")) {
    result = await visualSearchFromUrl(source, options);
  } else if (existsSync(source)) {
    result = await visualSearchFromFile(source, options);
  } else {
    console.error(`File not found: ${source}`);
    process.exit(1);
  }

  printResult(result);

  if (shouldSave) {
    await saveToDatabase(result, args);
  }
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
