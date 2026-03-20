import dotenv from "dotenv";
dotenv.config();

import {
  searchProducts,
  getProductById,
  getProductByQuery,
} from "../lib/pricecharting";

function formatPrice(cents: number | undefined): string {
  if (cents === undefined || cents === 0) return "-";
  return `$${(cents / 100).toFixed(2)}`;
}

function printFullProduct(product: ReturnType<typeof Object>) {
  const p = product as Record<string, unknown>;
  console.log(`\n${p["product-name"]} (${p["console-name"]})`);
  console.log(`  ID:       ${p.id}`);
  if (p["release-date"]) console.log(`  Released: ${p["release-date"]}`);
  if (p.genre) console.log(`  Genre:    ${p.genre}`);
  console.log(`  Loose:    ${formatPrice(p["loose-price"] as number)}`);
  console.log(`  CIB:      ${formatPrice(p["cib-price"] as number)}`);
  console.log(`  New:      ${formatPrice(p["new-price"] as number)}`);
  if (p["graded-price"]) console.log(`  Graded:   ${formatPrice(p["graded-price"] as number)}`);
  if (p["box-only-price"]) console.log(`  Box:      ${formatPrice(p["box-only-price"] as number)}`);
  if (p["manual-only-price"]) console.log(`  Manual:   ${formatPrice(p["manual-only-price"] as number)}`);
  if (p["gamestop-price"]) console.log(`  GameStop: ${formatPrice(p["gamestop-price"] as number)}`);
  if (p["retail-loose-buy"]) {
    console.log(`  Retail Loose:  Buy ${formatPrice(p["retail-loose-buy"] as number)} / Sell ${formatPrice(p["retail-loose-sell"] as number)}`);
  }
  if (p["retail-cib-buy"]) {
    console.log(`  Retail CIB:    Buy ${formatPrice(p["retail-cib-buy"] as number)} / Sell ${formatPrice(p["retail-cib-sell"] as number)}`);
  }
  if (p.upc) console.log(`  UPC:      ${p.upc}`);
  if (p.asin) console.log(`  ASIN:     ${p.asin}`);
  if (p.epid) console.log(`  ePID:     ${p.epid}`);
  if (p["sales-volume"]) console.log(`  Volume:   ${p["sales-volume"]}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("Usage:");
    console.log('  Search:  npm run pc:search -- "earthbound"');
    console.log('  By ID:   npm run pc:search -- --id 6910');
    console.log('  By UPC:  npm run pc:search -- --upc 045496830434');
    console.log('  Lucky:   npm run pc:search -- --q "earthbound snes"  (single best match)');
    process.exit(0);
  }

  // --id lookup
  if (args[0] === "--id") {
    const id = args[1];
    if (!id) {
      console.error("Provide a PriceCharting product ID.");
      process.exit(1);
    }
    console.log(`Looking up PriceCharting ID: ${id}...`);
    const product = await getProductById(id);
    printFullProduct(product);
    return;
  }

  // --upc lookup
  if (args[0] === "--upc") {
    const upc = args[1];
    if (!upc) {
      console.error("Provide a UPC.");
      process.exit(1);
    }
    console.log(`Looking up UPC: ${upc}...`);
    const { getProductByUpc } = await import("../lib/pricecharting");
    const product = await getProductByUpc(upc);
    printFullProduct(product);
    return;
  }

  // --q single-product text search (best match)
  if (args[0] === "--q") {
    const query = args.slice(1).join(" ");
    if (!query) {
      console.error("Provide a search query.");
      process.exit(1);
    }
    console.log(`Best match for: "${query}"...`);
    const product = await getProductByQuery(query);
    printFullProduct(product);
    return;
  }

  // Default: multi-product search
  const query = args.join(" ");
  console.log(`Searching: "${query}"...`);
  const products = await searchProducts(query);

  if (products.length === 0) {
    console.log("No results found.");
    return;
  }

  console.log(`\nFound ${products.length} result(s):\n`);
  for (const p of products) {
    const loose = formatPrice(p["loose-price"]);
    const cib = formatPrice(p["cib-price"]);
    console.log(
      `  [${p.id}] ${p["product-name"]} (${p["console-name"]}) - Loose: ${loose} | CIB: ${cib}`
    );
  }
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
