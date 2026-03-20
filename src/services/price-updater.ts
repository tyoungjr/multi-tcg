import { supabase } from "../lib/supabase";
import {
  getProductById,
  searchProducts,
  getPriceForCondition,
} from "../lib/pricecharting";
import type { PriceChartingProduct } from "../types/pricecharting";
import type { Product, ProductCondition } from "../types/database";

export interface PriceUpdateResult {
  productId: string;
  title: string;
  previousMarketPrice: number | null;
  newMarketPrice: number | null;
  source: string;
  success: boolean;
  error?: string;
}

export async function updateProductPrice(
  product: Product
): Promise<PriceUpdateResult> {
  const result: PriceUpdateResult = {
    productId: product.id,
    title: product.title,
    previousMarketPrice: product.market_price,
    newMarketPrice: null,
    source: "pricecharting",
    success: false,
  };

  try {
    let pcProduct: PriceChartingProduct | null = null;

    if (product.pricecharting_id) {
      pcProduct = await getProductById(product.pricecharting_id);
    } else if (product.upc) {
      try {
        pcProduct = await getProductById(product.upc);
      } catch {
        // UPC not found, fall through
      }
    }

    if (!pcProduct) {
      result.error = "No PriceCharting ID or UPC linked";
      return result;
    }

    const condition = mapCondition(product.condition);
    const priceCents = getPriceForCondition(pcProduct, condition);

    if (priceCents === null || priceCents === 0) {
      result.error = `No price available for condition: ${condition}`;
      return result;
    }

    // Update market_price on the product
    const { error: updateError } = await supabase
      .from("products")
      .update({ market_price: priceCents })
      .eq("id", product.id);

    if (updateError) {
      result.error = `DB update failed: ${updateError.message}`;
      return result;
    }

    // Record in price_history
    const { error: historyError } = await supabase
      .from("price_history")
      .insert({
        product_id: product.id,
        source: "pricecharting",
        price_cents: priceCents,
        condition: product.condition,
        raw_data: pcProduct as unknown as Record<string, unknown>,
      });

    if (historyError) {
      result.error = `Price history insert failed: ${historyError.message}`;
      return result;
    }

    result.newMarketPrice = priceCents;
    result.success = true;
    return result;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  }
}

export async function updateAllPrices(): Promise<PriceUpdateResult[]> {
  const { data: products, error } = await supabase
    .from("products")
    .select("*")
    .not("pricecharting_id", "is", null);

  if (error) {
    throw new Error(`Failed to fetch products: ${error.message}`);
  }

  const results: PriceUpdateResult[] = [];

  for (const product of products as Product[]) {
    const result = await updateProductPrice(product);
    results.push(result);
    console.log(
      `  ${result.success ? "OK" : "SKIP"} ${result.title}: ${
        result.success
          ? `$${((result.newMarketPrice ?? 0) / 100).toFixed(2)}`
          : result.error
      }`
    );
  }

  return results;
}

export async function linkProductToPriceCharting(
  productId: string,
  query: string,
  consoleName?: string
): Promise<PriceChartingProduct[]> {
  return searchProducts(query, consoleName);
}

export async function confirmPriceChartingLink(
  productId: string,
  pricechartingId: string
): Promise<void> {
  const { error } = await supabase
    .from("products")
    .update({ pricecharting_id: pricechartingId })
    .eq("id", productId);

  if (error) {
    throw new Error(`Failed to link product: ${error.message}`);
  }
}

function mapCondition(
  condition: ProductCondition | null
): "loose" | "cib" | "new_sealed" | "graded" {
  switch (condition) {
    case "new_sealed":
      return "new_sealed";
    case "cib":
      return "cib";
    case "graded":
      return "graded";
    case "loose":
    case "good":
    case "very_good":
    default:
      return "loose";
  }
}
