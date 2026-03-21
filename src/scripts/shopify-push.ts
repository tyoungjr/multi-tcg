import dotenv from "dotenv";
dotenv.config();

import { pushAllToShopify, pushProductToShopify } from "../services/shopify-sync";
import { supabase } from "../lib/supabase";
import type { Product } from "../types/database";

function printUsage(): void {
  console.log("Push products from Supabase to Shopify\n");
  console.log("Usage:");
  console.log("  npm run shopify:push                           Push all in-stock products");
  console.log("  npm run shopify:push -- --category trading_card  Only push trading cards");
  console.log("  npm run shopify:push -- --id <product-uuid>    Push a single product");
  console.log("  npm run shopify:push -- --dry-run              Preview without pushing");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help")) {
    printUsage();
    return;
  }

  const dryRun = args.includes("--dry-run");

  // Single product push
  const idIdx = args.indexOf("--id");
  if (idIdx !== -1 && args[idIdx + 1]) {
    const productId = args[idIdx + 1];

    const { data, error } = await supabase
      .from("products")
      .select("*")
      .eq("id", productId)
      .single();

    if (error || !data) {
      console.error(`Product not found: ${productId}`);
      process.exit(1);
    }

    const product = data as Product;
    const price = product.current_price ?? product.market_price;
    console.log(`Pushing: ${product.title} ($${price ? (price / 100).toFixed(2) : "no price"})`);

    if (dryRun) {
      console.log("  DRY RUN - would push to Shopify");
      return;
    }

    const result = await pushProductToShopify(product);
    if (result.success) {
      console.log(`  ${result.action}: Shopify product ID ${result.shopifyProductId}`);
    } else {
      console.error(`  Failed: ${result.error}`);
      process.exit(1);
    }
    return;
  }

  // Bulk push
  const catIdx = args.indexOf("--category");
  const category = catIdx !== -1 ? args[catIdx + 1] : undefined;

  console.log(
    `Pushing${category ? ` ${category}` : ""} products to Shopify...${dryRun ? " (dry run)" : ""}\n`
  );

  if (dryRun) {
    const { data, error } = await supabase
      .from("products")
      .select("id, title, current_price, market_price, category, shopify_product_id")
      .in("inventory_status", ["in_stock", "listed_shopify"])
      .or("current_price.gt.0,market_price.gt.0")
      .order("title");

    if (error) {
      console.error(`Failed: ${error.message}`);
      process.exit(1);
    }

    const products = category
      ? (data ?? []).filter((p: { category: string }) => p.category === category)
      : (data ?? []);

    for (const p of products) {
      const price = p.current_price ?? p.market_price;
      const action = p.shopify_product_id ? "UPD" : "NEW";
      console.log(`  ${action}  ${p.title} - $${price ? (price / 100).toFixed(2) : "?"}`);
    }
    console.log(`\n${products.length} product(s) would be pushed.`);
    return;
  }

  const results = await pushAllToShopify({ category });

  const created = results.filter((r) => r.action === "created").length;
  const updated = results.filter((r) => r.action === "updated").length;
  const failed = results.filter((r) => !r.success).length;

  console.log(`\nDone. ${created} created, ${updated} updated, ${failed} failed.`);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
