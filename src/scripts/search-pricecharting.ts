import dotenv from "dotenv";
dotenv.config();

import { searchProducts, getProductById } from "../lib/pricecharting";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("Usage:");
    console.log("  Search:  npm run pc:search -- \"earthbound\"");
    console.log("  Search:  npm run pc:search -- \"mario\" \"Nintendo 64\"");
    console.log("  By ID:   npm run pc:search -- --id 6910");
    process.exit(0);
  }

  if (args[0] === "--id") {
    const id = args[1];
    if (!id) {
      console.error("Provide a PriceCharting product ID.");
      process.exit(1);
    }
    console.log(`Looking up PriceCharting ID: ${id}...`);
    const product = await getProductById(id);
    console.log(`\n${product["product-name"]} (${product["console-name"]})`);
    console.log(`  Loose:  $${((product["loose-price"] ?? 0) / 100).toFixed(2)}`);
    console.log(`  CIB:    $${((product["cib-price"] ?? 0) / 100).toFixed(2)}`);
    console.log(`  New:    $${((product["new-price"] ?? 0) / 100).toFixed(2)}`);
    if (product["graded-price"]) {
      console.log(`  Graded: $${(product["graded-price"] / 100).toFixed(2)}`);
    }
    if (product.upc) console.log(`  UPC:    ${product.upc}`);
    if (product.asin) console.log(`  ASIN:   ${product.asin}`);
    return;
  }

  const query = args[0];
  const consoleName = args[1];

  console.log(
    `Searching: "${query}"${consoleName ? ` on ${consoleName}` : ""}...`
  );
  const products = await searchProducts(query, consoleName);

  if (products.length === 0) {
    console.log("No results found.");
    return;
  }

  console.log(`\nFound ${products.length} result(s):\n`);
  for (const p of products) {
    const loose = ((p["loose-price"] ?? 0) / 100).toFixed(2);
    const cib = ((p["cib-price"] ?? 0) / 100).toFixed(2);
    console.log(
      `  [${p.id}] ${p["product-name"]} (${p["console-name"]}) - Loose: $${loose} | CIB: $${cib}`
    );
  }
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
