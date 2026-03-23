import dotenv from "dotenv";
dotenv.config();

import { createInterface } from "readline";
import { watch, existsSync, mkdirSync, renameSync, readdirSync, readFileSync, statSync } from "fs";
import { join, extname, basename } from "path";
import {
  visualSearchFromFile,
} from "../services/visual-search";
import type { SearchOptions } from "../services/visual-search";
import type { VisualSearchResult, PriceChartingMatch } from "../types/visual-search";
import type { Product, ProductInsert, ProductCategory, ProductCondition } from "../types/database";
import { supabase } from "../lib/supabase";
import { pushProductToShopify } from "../services/shopify-sync";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const DEBOUNCE_MS = 2000;
const STABILITY_CHECK_MS = 1500; // wait for file size to stop changing (OneDrive sync)
const STABILITY_RETRIES = 5;    // max checks before giving up

// OneDrive temp file patterns to ignore
const IGNORE_PATTERNS = [
  /^~\$/,           // Office temp files
  /^~tmp/i,         // temp files
  /\.tmp$/i,        // .tmp extension
  /\.partial$/i,    // partial downloads
  /\.crdownload$/i, // Chrome downloads
  /\(1\)\./,        // duplicate files from sync conflicts
  /^\.~/,           // hidden temp
];

const processed = new Set<string>();
const pending = new Map<string, NodeJS.Timeout>();
const fileQueue: string[] = [];
let processing = false;

// ---------------------------------------------------------------------------
// Readline prompt
// ---------------------------------------------------------------------------

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

function formatPrice(cents: number | undefined): string {
  if (!cents || cents === 0) return "-";
  return `$${(cents / 100).toFixed(2)}`;
}

function parseDollars(value: string): number {
  const cleaned = value.replace("$", "").trim();
  const num = parseFloat(cleaned);
  if (isNaN(num)) throw new Error(`Invalid price: "${value}"`);
  return Math.round(num * 100);
}

function printResult(filePath: string, result: VisualSearchResult): void {
  const { identification: id } = result;
  const file = basename(filePath);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${file}`);
  console.log(`${"=".repeat(60)}`);
  console.log(`  Title:      ${id.title}`);
  console.log(`  Category:   ${id.category}`);
  console.log(`  Confidence: ${id.confidence}`);

  const d = id.details;
  const details: string[] = [];
  if (d.game) details.push(`Game: ${d.game}`);
  if (d.set) details.push(`Set: ${d.set}`);
  if (d.card_number) details.push(`#${d.card_number}`);
  if (d.rarity) details.push(d.rarity);
  if (d.variant) details.push(d.variant);
  if (d.platform) details.push(d.platform);
  if (d.region) details.push(d.region);
  if (d.condition_estimate) details.push(`Condition: ${d.condition_estimate}`);
  if (d.grading_company) details.push(`${d.grading_company} ${d.grade ?? ""}`);
  if (details.length > 0) {
    console.log(`  Details:    ${details.join(" | ")}`);
  }

  if (result.suggested_market_price_cents) {
    console.log(`  >>> PRICE:  ${formatPrice(result.suggested_market_price_cents)} (${result.price_source})`);
  } else {
    console.log(`  >>> PRICE:  No pricing data found`);
  }
}

// ---------------------------------------------------------------------------
// Interactive PriceCharting pick
// ---------------------------------------------------------------------------

async function pickPriceChartingMatch(
  result: VisualSearchResult
): Promise<PriceChartingMatch | null | "keep"> {
  const candidates = result.pc_candidates;
  if (!candidates || candidates.length === 0) {
    if (result.pricecharting) return "keep";
    return null;
  }

  console.log(`\n  PriceCharting candidates:`);
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const selected = result.pricecharting?.pricecharting_id === c.pricecharting_id ? " <<<" : "";
    console.log(
      `    [${i}] ${c.product_name} (${c.console_name}) - Loose: ${formatPrice(c.loose_price_cents)}${selected}`
    );
  }

  const answer = await ask(`  Pick match [0-${candidates.length - 1}], Enter to keep auto, 'n' for none: `);

  if (answer === "" || answer === "y") {
    return "keep";
  }
  if (answer === "n" || answer === "none") {
    return null;
  }

  const idx = parseInt(answer, 10);
  if (!isNaN(idx) && idx >= 0 && idx < candidates.length) {
    return candidates[idx];
  }

  console.log("  Invalid choice, keeping auto-match.");
  return "keep";
}

// ---------------------------------------------------------------------------
// Interactive save prompt
// ---------------------------------------------------------------------------

async function uploadImage(
  filePath: string,
  productId: string
): Promise<{ storagePath: string; publicUrl: string } | null> {
  try {
    const file = basename(filePath);
    const ext = extname(filePath).toLowerCase();
    const contentType =
      ext === ".png" ? "image/png" :
      ext === ".webp" ? "image/webp" :
      ext === ".gif" ? "image/gif" :
      "image/jpeg";

    const storagePath = `products/${productId}/${file}`;
    const fileData = readFileSync(filePath);

    const { error } = await supabase.storage
      .from("product-images")
      .upload(storagePath, fileData, { contentType, upsert: true });

    if (error) {
      console.warn(`  Image upload failed: ${error.message}`);
      return null;
    }

    const { data: urlData } = supabase.storage
      .from("product-images")
      .getPublicUrl(storagePath);

    return { storagePath, publicUrl: urlData.publicUrl };
  } catch (err) {
    console.warn(`  Image upload failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function promptSave(
  result: VisualSearchResult,
  pcMatch: PriceChartingMatch | null | undefined,
  imageFilePath: string
): Promise<void> {
  const answer = await ask("\n  Save to database? (y/n/edit): ");

  if (answer === "n" || answer === "no") {
    console.log("  Skipped.");
    return;
  }

  const { identification: id } = result;

  // Defaults from identification
  const conditionMap: Record<string, ProductCondition> = {
    mint: "new_sealed",
    "near mint": "cib",
    "lightly played": "good",
    "moderately played": "good",
    "heavily played": "loose",
    damaged: "loose",
  };

  let title = id.title;
  let category: ProductCategory = (id.category as ProductCategory) || "misc";
  let condition: ProductCondition =
    id.details.condition_estimate
      ? conditionMap[id.details.condition_estimate.toLowerCase()] ?? "loose"
      : "loose";
  let status: string = "in_stock";
  let askingPrice: number | undefined;
  let notes: string | undefined;
  let qty = 1;

  if (answer === "edit" || answer === "e") {
    // Interactive edit mode
    const newTitle = await ask(`  Title [${title}]: `);
    if (newTitle) title = newTitle;

    const newCat = await ask(`  Category [${category}]: `);
    if (newCat) category = newCat as ProductCategory;

    const newCond = await ask(`  Condition (loose/good/very_good/cib/new_sealed/graded) [${condition}]: `);
    if (newCond) condition = newCond as ProductCondition;

    const newStatus = await ask(`  Status (in_stock/personal_collection/listed_ebay) [${status}]: `);
    if (newStatus) status = newStatus;

    const priceStr = await ask(`  Asking price in $ (blank to skip): `);
    if (priceStr) askingPrice = parseDollars(priceStr);

    const qtyStr = await ask(`  Quantity [1]: `);
    if (qtyStr) qty = parseInt(qtyStr, 10) || 1;

    const notesStr = await ask(`  Notes (blank to skip): `);
    if (notesStr) notes = notesStr;
  }

  // Build metadata
  const metadata: Record<string, unknown> = { ...id.details };
  delete metadata.condition_estimate;
  delete metadata.grading_company;
  delete metadata.grade;

  const insert: ProductInsert = {
    title,
    category,
    description: id.description,
    condition,
    inventory_status: status as ProductInsert["inventory_status"],
    metadata,
    quantity: qty,
  };

  if (id.details.grading_company) {
    insert.grading_company = id.details.grading_company;
  }
  if (id.details.grade) {
    insert.graded_score = id.details.grade;
    insert.condition = "graded";
  }

  if (pcMatch) {
    insert.pricecharting_id = pcMatch.pricecharting_id;
    // Use the selected match's price
    const pcPrice = pcMatch.loose_price_cents || pcMatch.cib_price_cents || pcMatch.new_price_cents;
    if (pcPrice > 0) insert.market_price = pcPrice;
  } else if (result.suggested_market_price_cents) {
    insert.market_price = result.suggested_market_price_cents;
  }

  if (askingPrice) insert.current_price = askingPrice;
  if (notes) insert.purchase_notes = notes;

  const { data, error } = await supabase
    .from("products")
    .insert(insert)
    .select("id, title, category, condition, inventory_status, current_price, market_price, pricecharting_id")
    .single();

  if (error) {
    console.error(`  Save failed: ${error.message}`);
    return;
  }

  console.log(`\n  SAVED`);
  console.log(`  ID:       ${data.id}`);
  console.log(`  Title:    ${data.title}`);
  console.log(`  Category: ${data.category} | Condition: ${data.condition} | Status: ${data.inventory_status}`);
  console.log(`  Asking:   ${formatPrice(data.current_price)} | Market: ${formatPrice(data.market_price)}`);
  if (data.pricecharting_id) {
    console.log(`  PC ID:    ${data.pricecharting_id}`);
  }

  // Upload image to Supabase Storage and create image record
  const uploaded = await uploadImage(imageFilePath, data.id);
  await supabase.from("product_images").insert({
    product_id: data.id,
    storage_path: uploaded?.storagePath ?? null,
    url: uploaded?.publicUrl ?? null,
    is_primary: true,
    visual_search_result: {
      identification: result.identification,
      pricecharting: pcMatch,
      price_source: result.price_source,
    },
  });

  if (uploaded) {
    console.log(`  Image:    ${uploaded.publicUrl}`);
  }

  // Step 3: Offer to push to Shopify immediately
  if (process.env.SHOPIFY_ACCESS_TOKEN) {
    const listAnswer = await ask("  List on Shopify now? (y/n): ");
    if (listAnswer === "y" || listAnswer === "yes") {
      // Ensure there's a listing price
      let listingPrice = data.current_price ?? data.market_price;
      if (!listingPrice || listingPrice <= 0) {
        const priceInput = await ask("  Listing price in $ (required): ");
        if (!priceInput) {
          console.log("  No price set, skipping Shopify.");
          return;
        }
        listingPrice = parseDollars(priceInput);
      } else {
        const priceOverride = await ask(`  Listing price [${formatPrice(listingPrice)}]: `);
        if (priceOverride) {
          listingPrice = parseDollars(priceOverride);
        }
      }

      // Update the price in the database
      await supabase
        .from("products")
        .update({ current_price: listingPrice })
        .eq("id", data.id);

      console.log(`  Listing at ${formatPrice(listingPrice)}...`);

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
}

// ---------------------------------------------------------------------------
// Process a single file (interactive)
// ---------------------------------------------------------------------------

async function processFile(
  filePath: string,
  options: SearchOptions
): Promise<void> {
  if (processed.has(filePath)) return;
  processed.add(filePath);

  const file = basename(filePath);
  console.log(`\n${"~".repeat(60)}`);
  console.log(`Processing: ${file}...`);

  try {
    const result = await visualSearchFromFile(filePath, options);
    printResult(filePath, result);

    // Step 1: Let user pick PriceCharting match
    let pcMatch = result.pricecharting;
    if (result.pc_candidates && result.pc_candidates.length > 1) {
      const pick = await pickPriceChartingMatch(result);
      if (pick === "keep") {
        // keep auto-match
      } else if (pick === null) {
        pcMatch = undefined;
        console.log("  No PriceCharting link.");
      } else {
        pcMatch = pick;
        console.log(`  Selected: ${pick.product_name} (${pick.console_name}) - ${formatPrice(pick.loose_price_cents)}`);
      }
    }

    // Step 2: Save prompt
    await promptSave(result, pcMatch, filePath);

    // Move to processed/
    const dir = join(filePath, "..");
    const processedDir = join(dir, "processed");
    if (!existsSync(processedDir)) {
      mkdirSync(processedDir, { recursive: true });
    }
    try {
      renameSync(filePath, join(processedDir, file));
    } catch {
      // File might be locked
    }
  } catch (err) {
    console.error(`  Failed: ${err instanceof Error ? err.message : err}`);
  }
}

// ---------------------------------------------------------------------------
// Queue processor (sequential so prompts don't overlap)
// ---------------------------------------------------------------------------

async function processQueue(options: SearchOptions): Promise<void> {
  if (processing) return;
  processing = true;

  while (fileQueue.length > 0) {
    const filePath = fileQueue.shift()!;
    if (!processed.has(filePath) && existsSync(filePath)) {
      await processFile(filePath, options);
    }
  }

  processing = false;
  console.log(`\nWaiting for images... (Ctrl+C to stop)`);
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

function startWatching(inboxDir: string, options: SearchOptions): void {
  console.log(`Watching: ${inboxDir}`);
  console.log(`Drop images here to identify and price them.`);
  console.log(`Processed files move to: ${inboxDir}/processed/`);
  console.log(`Press Ctrl+C to stop.\n`);

  // Queue existing files
  const existing = readdirSync(inboxDir);
  for (const file of existing) {
    const ext = extname(file).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext) && file !== "processed") {
      fileQueue.push(join(inboxDir, file));
    }
  }

  if (fileQueue.length > 0) {
    console.log(`Found ${fileQueue.length} existing image(s).\n`);
    processQueue(options);
  } else {
    console.log(`Waiting for images... (Ctrl+C to stop)`);
  }

  // Watch for new files
  watch(inboxDir, (eventType, filename) => {
    if (!filename) return;

    const ext = extname(filename).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) return;

    const filePath = join(inboxDir, filename);

    // Debounce for slow transfers
    if (pending.has(filePath)) {
      clearTimeout(pending.get(filePath)!);
    }

    pending.set(
      filePath,
      setTimeout(() => {
        pending.delete(filePath);
        if (existsSync(filePath) && !processed.has(filePath)) {
          fileQueue.push(filePath);
          processQueue(options);
        }
      }, DEBOUNCE_MS)
    );
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log("Watch a folder for images, identify, and interactively save\n");
  console.log("Usage:");
  console.log("  npm run identify:watch -- inbox/              Watch the inbox/ folder");
  console.log("  npm run identify:watch -- inbox/ --skip-pc    Skip PriceCharting");
  console.log("  npm run identify:watch -- inbox/ --id-only    Only identify, no pricing");
  console.log("  npm run identify:watch -- inbox/ --no-lens    Disable Google Lens");
  console.log('  npm run identify:watch -- inbox/ --context "Japanese cards"');
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help")) {
    printUsage();
    return;
  }

  const inboxDir = args[0];

  if (!existsSync(inboxDir)) {
    mkdirSync(inboxDir, { recursive: true });
    console.log(`Created inbox directory: ${inboxDir}`);
  }

  let additionalContext: string | undefined;
  const contextIdx = args.indexOf("--context");
  if (contextIdx !== -1 && args[contextIdx + 1]) {
    additionalContext = args[contextIdx + 1];
  }

  const options: SearchOptions = {
    identifyOnly: args.includes("--id-only"),
    skipPriceCharting: args.includes("--skip-pc"),
    skipEbay: args.includes("--no-ebay"),
    skipGoogleLens: args.includes("--no-lens"),
    additionalContext,
  };

  startWatching(inboxDir, options);
}

main();
