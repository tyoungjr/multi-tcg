import dotenv from "dotenv";
dotenv.config();

import { watch, existsSync, mkdirSync, renameSync } from "fs";
import { join, extname, basename } from "path";
import {
  visualSearchFromFile,
} from "../services/visual-search";
import type { SearchOptions } from "../services/visual-search";
import type { VisualSearchResult } from "../types/visual-search";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const DEBOUNCE_MS = 2000; // wait for file to finish writing

// Track files we've already processed or are currently processing
const processed = new Set<string>();
const pending = new Map<string, NodeJS.Timeout>();

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

function formatPrice(cents: number | undefined): string {
  if (!cents || cents === 0) return "-";
  return `$${(cents / 100).toFixed(2)}`;
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

  if (result.pricecharting) {
    const pc = result.pricecharting;
    console.log(`  PC Match:   ${pc.product_name} (${pc.console_name})`);
    console.log(`  PC Price:   Loose ${formatPrice(pc.loose_price_cents)} | CIB ${formatPrice(pc.cib_price_cents)} | New ${formatPrice(pc.new_price_cents)}`);
  }

  if (result.ebay_prices && result.ebay_prices.sample_size > 0) {
    console.log(`  eBay:       Median ${formatPrice(result.ebay_prices.median_price_cents)} (${result.ebay_prices.sample_size} sold)`);
  }

  if (result.google_lens_prices && result.google_lens_prices.sample_size > 0) {
    console.log(`  Lens:       Median ${formatPrice(result.google_lens_prices.median_price_cents)} (${result.google_lens_prices.sample_size} results)`);
  }

  if (result.suggested_market_price_cents) {
    console.log(`  >>> PRICE:  ${formatPrice(result.suggested_market_price_cents)} (${result.price_source})`);
  } else {
    console.log(`  >>> PRICE:  No pricing data found`);
  }

  console.log("");
}

// ---------------------------------------------------------------------------
// Process a single file
// ---------------------------------------------------------------------------

async function processFile(
  filePath: string,
  options: SearchOptions
): Promise<void> {
  if (processed.has(filePath)) return;
  processed.add(filePath);

  const file = basename(filePath);
  console.log(`\nProcessing: ${file}...`);

  try {
    const result = await visualSearchFromFile(filePath, options);
    printResult(filePath, result);

    // Move to processed/ subfolder
    const dir = join(filePath, "..");
    const processedDir = join(dir, "processed");
    if (!existsSync(processedDir)) {
      mkdirSync(processedDir, { recursive: true });
    }
    const dest = join(processedDir, file);
    try {
      renameSync(filePath, dest);
      console.log(`  Moved to: processed/${file}`);
    } catch {
      // File might be locked, that's ok
    }
  } catch (err) {
    console.error(`  Failed: ${err instanceof Error ? err.message : err}`);
  }
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

function startWatching(
  inboxDir: string,
  options: SearchOptions
): void {
  console.log(`Watching: ${inboxDir}`);
  console.log(`Drop images here to identify and price them.`);
  console.log(`Processed files move to: ${inboxDir}/processed/`);
  console.log(`Press Ctrl+C to stop.\n`);

  // Process any files already in the directory
  const { readdirSync } = require("fs") as typeof import("fs");
  const existing = readdirSync(inboxDir);
  for (const file of existing) {
    const ext = extname(file).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext) && file !== "processed") {
      const filePath = join(inboxDir, file);
      // Small delay to stagger existing files
      const timeout = setTimeout(() => processFile(filePath, options), 500);
      pending.set(filePath, timeout);
    }
  }

  // Watch for new files
  watch(inboxDir, (eventType, filename) => {
    if (!filename) return;

    const ext = extname(filename).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) return;

    const filePath = join(inboxDir, filename);

    // Debounce: wait for file to finish writing (phone transfers can be slow)
    if (pending.has(filePath)) {
      clearTimeout(pending.get(filePath)!);
    }

    pending.set(
      filePath,
      setTimeout(() => {
        pending.delete(filePath);
        if (existsSync(filePath) && !processed.has(filePath)) {
          processFile(filePath, options);
        }
      }, DEBOUNCE_MS)
    );
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log("Watch a folder for images and auto-identify + price them\n");
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
