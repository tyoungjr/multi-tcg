import { supabase } from "./lib/supabase";
import type { Product } from "./types/database";

async function smokeTest(): Promise<void> {
  console.log("Connecting to Supabase...");

  const { data, error } = await supabase
    .from("products")
    .select("id, title, category, inventory_status, current_price")
    .limit(10);

  if (error) {
    console.error("Query failed:", error.message);
    process.exit(1);
  }

  const products = data as Pick<
    Product,
    "id" | "title" | "category" | "inventory_status" | "current_price"
  >[];

  console.log(`Connected. Found ${products.length} product(s).`);

  for (const p of products) {
    const price = p.current_price
      ? `$${(p.current_price / 100).toFixed(2)}`
      : "no price";
    console.log(`  - [${p.category}] ${p.title} (${price})`);
  }

  console.log("Smoke test passed.");
}

smokeTest();
