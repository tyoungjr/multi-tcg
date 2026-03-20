import dotenv from "dotenv";
dotenv.config();

import { supabase } from "../lib/supabase";
import type { Product, ProductInsert } from "../types/database";

function formatPrice(cents: number | null): string {
  if (cents === null) return "-";
  return `$${(cents / 100).toFixed(2)}`;
}

function printProduct(p: Product): void {
  console.log(`\n  ${p.title}`);
  console.log(`  ID:        ${p.id}`);
  console.log(`  Category:  ${p.category}`);
  console.log(`  Condition: ${p.condition ?? "-"}`);
  console.log(`  Status:    ${p.inventory_status}`);
  console.log(`  Qty:       ${p.quantity}`);
  console.log(`  Asking:    ${formatPrice(p.current_price)}`);
  console.log(`  Market:    ${formatPrice(p.market_price)}`);
  if (p.purchase_price !== null) {
    console.log(`  Paid:      ${formatPrice(p.purchase_price)}`);
  }
  if (p.purchase_source) {
    console.log(`  Source:    ${p.purchase_source}`);
  }
  if (p.purchase_date) {
    console.log(`  Acquired:  ${p.purchase_date}`);
  }
  if (p.pricecharting_id) {
    console.log(`  PC ID:     ${p.pricecharting_id}`);
  }
  if (p.upc) console.log(`  UPC:       ${p.upc}`);
  if (p.description) console.log(`  Desc:      ${p.description}`);
  if (p.metadata && Object.keys(p.metadata).length > 0) {
    console.log(`  Metadata:  ${JSON.stringify(p.metadata)}`);
  }
  if (p.purchase_notes) {
    console.log(`  Notes:     ${p.purchase_notes}`);
  }
  console.log(`  Added:     ${new Date(p.created_at).toLocaleDateString()}`);
  console.log(`  Updated:   ${new Date(p.updated_at).toLocaleDateString()}`);
}

async function searchCollection(query: string): Promise<void> {
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .ilike("title", `%${query}%`)
    .order("title");

  if (error) {
    console.error("Query failed:", error.message);
    process.exit(1);
  }

  const products = data as Product[];

  if (products.length === 0) {
    console.log(`No products matching "${query}".`);
    return;
  }

  console.log(`Found ${products.length} product(s) matching "${query}":`);
  for (const p of products) {
    printProduct(p);
  }
}

async function getById(id: string): Promise<void> {
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .eq("id", id)
    .single();

  if (error) {
    console.error(`Product not found: ${id}`);
    process.exit(1);
  }

  printProduct(data as Product);
}

async function listByCategory(category: string): Promise<void> {
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .eq("category", category)
    .order("title");

  if (error) {
    console.error("Query failed:", error.message);
    process.exit(1);
  }

  const products = data as Product[];

  if (products.length === 0) {
    console.log(`No products in category "${category}".`);
    return;
  }

  console.log(`${products.length} product(s) in "${category}":`);
  for (const p of products) {
    printProduct(p);
  }
}

async function listAll(): Promise<void> {
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .order("category")
    .order("title");

  if (error) {
    console.error("Query failed:", error.message);
    process.exit(1);
  }

  const products = data as Product[];
  console.log(`${products.length} product(s) in collection:`);
  for (const p of products) {
    printProduct(p);
  }
}

function parseDollars(value: string): number {
  const cleaned = value.replace("$", "").trim();
  const num = parseFloat(cleaned);
  if (isNaN(num)) {
    throw new Error(`Invalid price: "${value}"`);
  }
  return Math.round(num * 100);
}

async function addProduct(args: string[]): Promise<void> {
  // Required: title, category
  // Optional flags: --condition, --status, --price, --paid, --source, --notes,
  //                 --pc-id, --upc, --qty, --metadata (JSON string)
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length) {
      flags[args[i].slice(2)] = args[i + 1];
      i++;
    } else {
      positional.push(args[i]);
    }
  }

  const title = positional[0];
  const category = positional[1];

  if (!title || !category) {
    console.error("Usage: npm run collection -- add \"Title\" category [flags]");
    console.error("  Categories: trading_card, video_game, console_hardware, accessory,");
    console.error("              arcade, coin, comic, toy, apparel, electronics, promotional, misc");
    console.error("  Flags:");
    console.error("    --condition  loose|good|very_good|cib|new_sealed|graded");
    console.error("    --status     in_stock|listed_shopify|listed_ebay|sold|personal_collection");
    console.error("    --price      Asking price in dollars (e.g. 29.99)");
    console.error("    --paid       Purchase price in dollars");
    console.error("    --source     Where you bought it");
    console.error("    --date       Purchase date (YYYY-MM-DD)");
    console.error("    --notes      Purchase notes");
    console.error("    --pc-id      PriceCharting product ID");
    console.error("    --upc        UPC barcode");
    console.error("    --qty        Quantity (default 1)");
    console.error('    --metadata   JSON string e.g. \'{"platform":"N64"}\'');
    process.exit(1);
  }

  const insert: ProductInsert = {
    title,
    category: category as ProductInsert["category"],
  };

  if (flags.condition) insert.condition = flags.condition as ProductInsert["condition"];
  if (flags.status) insert.inventory_status = flags.status as ProductInsert["inventory_status"];
  if (flags.price) insert.current_price = parseDollars(flags.price);
  if (flags.paid) insert.purchase_price = parseDollars(flags.paid);
  if (flags.source) insert.purchase_source = flags.source;
  if (flags.date) insert.purchase_date = flags.date;
  if (flags.notes) insert.purchase_notes = flags.notes;
  if (flags["pc-id"]) insert.pricecharting_id = flags["pc-id"];
  if (flags.upc) insert.upc = flags.upc;
  if (flags.qty) insert.quantity = parseInt(flags.qty, 10);
  if (flags.metadata) insert.metadata = JSON.parse(flags.metadata);

  const { data, error } = await supabase
    .from("products")
    .insert(insert)
    .select()
    .single();

  if (error) {
    console.error("Insert failed:", error.message);
    process.exit(1);
  }

  console.log("Added:");
  printProduct(data as Product);
}

function printUsage(): void {
  console.log("Collection manager - query and add to your inventory\n");
  console.log("Usage:");
  console.log('  npm run collection -- search "query"        Search by title');
  console.log("  npm run collection -- get <uuid>            Get by ID");
  console.log("  npm run collection -- category video_game   List by category");
  console.log("  npm run collection -- list                  List all");
  console.log('  npm run collection -- add "Title" category  Add a product');
  console.log("  npm run collection -- add                   Show add help");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printUsage();
    process.exit(0);
  }

  const command = args[0];
  const rest = args.slice(1);

  switch (command) {
    case "search":
      if (!rest[0]) {
        console.error("Provide a search term.");
        process.exit(1);
      }
      await searchCollection(rest[0]);
      break;
    case "get":
      if (!rest[0]) {
        console.error("Provide a product ID.");
        process.exit(1);
      }
      await getById(rest[0]);
      break;
    case "category":
      if (!rest[0]) {
        console.error("Provide a category name.");
        process.exit(1);
      }
      await listByCategory(rest[0]);
      break;
    case "list":
      await listAll();
      break;
    case "add":
      await addProduct(rest);
      break;
    default:
      // Treat as a search query for convenience
      await searchCollection(command);
      break;
  }
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
