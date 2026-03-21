import { supabase } from "../lib/supabase";
import { shopifyPost, shopifyPut, shopifyGet, shopifyGetAll } from "../lib/shopify";
import type { Product } from "../types/database";
import type {
  ShopifyProduct,
  ShopifyProductCreate,
  ShopifyImageCreate,
  ShopifyProductResponse,
  ShopifyOrdersResponse,
  ShopifyOrder,
} from "../types/shopify";

// ---------------------------------------------------------------------------
// Product mapping: Supabase -> Shopify
// ---------------------------------------------------------------------------

function buildTags(product: Product): string {
  const tags: string[] = [];

  tags.push(product.category.replace("_", " "));

  if (product.condition) {
    tags.push(product.condition.replace("_", " "));
  }

  const meta = product.metadata as Record<string, unknown>;
  if (meta.game) tags.push(String(meta.game));
  if (meta.set) tags.push(String(meta.set));
  if (meta.platform) tags.push(String(meta.platform));
  if (meta.brand) tags.push(String(meta.brand));
  if (meta.rarity) tags.push(String(meta.rarity));

  return tags.join(", ");
}

function buildProductType(product: Product): string {
  const typeMap: Record<string, string> = {
    trading_card: "Trading Card",
    video_game: "Video Game",
    console_hardware: "Console",
    accessory: "Accessory",
    arcade: "Arcade",
    coin: "Coin",
    comic: "Comic",
    toy: "Toy",
    apparel: "Apparel",
    electronics: "Electronics",
    promotional: "Promotional",
    misc: "Miscellaneous",
  };
  return typeMap[product.category] ?? "Collectible";
}

function centsToPrice(cents: number | null): string {
  if (!cents || cents <= 0) return "0.00";
  return (cents / 100).toFixed(2);
}

async function getProductImages(
  productId: string
): Promise<ShopifyImageCreate[]> {
  const { data: images } = await supabase
    .from("product_images")
    .select("url, storage_path, alt_text, sort_order")
    .eq("product_id", productId)
    .order("sort_order");

  if (!images || images.length === 0) return [];

  const shopifyImages: ShopifyImageCreate[] = [];

  for (const img of images) {
    if (img.url) {
      shopifyImages.push({
        src: img.url,
        alt: img.alt_text ?? undefined,
        position: (img.sort_order ?? 0) + 1,
      });
    }
  }

  return shopifyImages;
}

function buildShopifyProduct(
  product: Product,
  images: ShopifyImageCreate[]
): { product: ShopifyProductCreate } {
  const price = centsToPrice(product.current_price ?? product.market_price);
  const compareAt =
    product.current_price && product.market_price && product.market_price > product.current_price
      ? centsToPrice(product.market_price)
      : undefined;

  const payload: ShopifyProductCreate = {
    title: product.title,
    body_html: product.description ?? "",
    product_type: buildProductType(product),
    tags: buildTags(product),
    status: "active",
    variants: [
      {
        price,
        compare_at_price: compareAt,
        sku: product.id,
        inventory_quantity: product.quantity,
        inventory_management: "shopify",
      },
    ],
  };

  if (images.length > 0) {
    payload.images = images;
  }

  return { product: payload };
}

// ---------------------------------------------------------------------------
// Push single product to Shopify
// ---------------------------------------------------------------------------

export interface PushResult {
  productId: string;
  title: string;
  success: boolean;
  shopifyProductId?: string;
  shopifyVariantId?: string;
  action?: "created" | "updated";
  error?: string;
}

export async function pushProductToShopify(
  product: Product
): Promise<PushResult> {
  const result: PushResult = {
    productId: product.id,
    title: product.title,
    success: false,
  };

  try {
    const images = await getProductImages(product.id);
    const payload = buildShopifyProduct(product, images);

    let shopifyProduct: ShopifyProduct;

    if (product.shopify_product_id) {
      // Update existing
      const response = await shopifyPut<ShopifyProductResponse>(
        `/products/${product.shopify_product_id}.json`,
        payload
      );
      shopifyProduct = response.product;
      result.action = "updated";
    } else {
      // Create new
      const response = await shopifyPost<ShopifyProductResponse>(
        "/products.json",
        payload
      );
      shopifyProduct = response.product;
      result.action = "created";
    }

    const variant = shopifyProduct.variants[0];

    // Update our DB with Shopify IDs
    const { error: updateError } = await supabase
      .from("products")
      .update({
        shopify_product_id: String(shopifyProduct.id),
        shopify_variant_id: variant ? String(variant.id) : null,
        inventory_status:
          product.inventory_status === "in_stock"
            ? "listed_shopify"
            : product.inventory_status,
      })
      .eq("id", product.id);

    if (updateError) {
      console.warn(`  DB update failed: ${updateError.message}`);
    }

    result.shopifyProductId = String(shopifyProduct.id);
    result.shopifyVariantId = variant ? String(variant.id) : undefined;
    result.success = true;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Push multiple products
// ---------------------------------------------------------------------------

export async function pushAllToShopify(
  filter?: { status?: string; category?: string }
): Promise<PushResult[]> {
  let query = supabase
    .from("products")
    .select("*")
    .in("inventory_status", ["in_stock", "listed_shopify"]);

  if (filter?.category) {
    query = query.eq("category", filter.category);
  }

  // Only push items that have a price
  query = query.or("current_price.gt.0,market_price.gt.0");

  const { data: products, error } = await query.order("title");

  if (error) {
    throw new Error(`Failed to fetch products: ${error.message}`);
  }

  const results: PushResult[] = [];

  for (const product of products as Product[]) {
    const r = await pushProductToShopify(product);
    const status = r.success ? (r.action === "created" ? "NEW" : "UPD") : "ERR";
    const price = product.current_price ?? product.market_price;
    console.log(
      `  ${status}  ${r.title} - $${centsToPrice(price)} ${r.error ? `(${r.error})` : ""}`
    );
    results.push(r);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Sync orders: pull Shopify orders and mark products as sold
// ---------------------------------------------------------------------------

export async function syncOrders(
  sinceDate?: string
): Promise<{ synced: number; skipped: number; errors: number }> {
  const params = new URLSearchParams({
    status: "any",
    limit: "250",
  });
  if (sinceDate) {
    params.set("created_at_min", sinceDate);
  }

  const orders = await shopifyGetAll<ShopifyOrder>(
    `/orders.json?${params}`,
    "orders"
  );

  let synced = 0;
  let skipped = 0;
  let errors = 0;

  for (const order of orders) {
    if (order.cancelled_at) {
      skipped++;
      continue;
    }

    for (const item of order.line_items) {
      if (!item.product_id) {
        skipped++;
        continue;
      }

      // Find our product by shopify_product_id
      const { data: products } = await supabase
        .from("products")
        .select("id, title, inventory_status")
        .eq("shopify_product_id", String(item.product_id))
        .limit(1);

      if (!products || products.length === 0) {
        skipped++;
        continue;
      }

      const product = products[0];

      if (product.inventory_status === "sold") {
        skipped++;
        continue;
      }

      const { error } = await supabase
        .from("products")
        .update({ inventory_status: "sold" })
        .eq("id", product.id);

      if (error) {
        console.error(`  ERR  ${product.title}: ${error.message}`);
        errors++;
      } else {
        const price = `$${item.price}`;
        console.log(`  SOLD ${product.title} - ${price} (Order ${order.name})`);

        // Record the sale in price_history
        await supabase.from("price_history").insert({
          product_id: product.id,
          source: "shopify_sale",
          price_cents: Math.round(parseFloat(item.price) * 100),
          raw_data: {
            order_id: order.id,
            order_name: order.name,
            line_item_id: item.id,
          },
        });

        synced++;
      }
    }
  }

  return { synced, skipped, errors };
}
