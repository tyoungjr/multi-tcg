import { identifyFromFile, identifyFromUrl } from "./item-identifier";
import { searchProducts, getProductByQuery } from "../lib/pricecharting";
import { getEbayPrices } from "./ebay-pricing";
import { getGoogleLensPrices } from "./google-lens-pricing";
import { supabase } from "../lib/supabase";
import type { PriceChartingProduct } from "../types/pricecharting";
import type {
  IdentificationResult,
  PriceChartingMatch,
  VisualSearchResult,
} from "../types/visual-search";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SearchOptions {
  /** Skip PriceCharting and go straight to fallbacks */
  skipPriceCharting?: boolean;
  /** Skip eBay fallback */
  skipEbay?: boolean;
  /** Skip Google Lens fallback */
  skipGoogleLens?: boolean;
  /** Only identify, no pricing at all */
  identifyOnly?: boolean;
  /** Extra context for Claude Vision */
  additionalContext?: string;
  /** Pick a specific PriceCharting result by index (0-based) instead of auto-match */
  pcPick?: number;
}

// ---------------------------------------------------------------------------
// Step 2: Try PriceCharting
// ---------------------------------------------------------------------------

interface PcSearchResult {
  selected: PriceChartingMatch | null;
  candidates: PriceChartingMatch[];
}

async function tryPriceCharting(
  identification: IdentificationResult,
  pickIndex?: number
): Promise<PcSearchResult> {
  const query = identification.search_queries.primary;
  console.log(`  Searching PriceCharting: "${query}"...`);

  // Try multi-result search first
  const results = await searchProducts(query);

  if (results.length > 0) {
    const candidates = results.map(pcProductToMatch);

    // Show all candidates
    console.log(`  Found ${results.length} PriceCharting result(s):`);
    for (let i = 0; i < results.length; i++) {
      const p = results[i];
      const loose = p["loose-price"] ? `$${(p["loose-price"] / 100).toFixed(2)}` : "-";
      const marker = (pickIndex !== undefined && pickIndex === i) ? " <<<" :
        (pickIndex === undefined && i === 0) ? "" : "";
      console.log(`    [${i}] ${p["product-name"]} (${p["console-name"]}) - Loose: ${loose}${marker}`);
    }

    // Pick: explicit index, or auto-match
    let selected: PriceChartingMatch;
    if (pickIndex !== undefined && pickIndex < candidates.length) {
      selected = candidates[pickIndex];
      console.log(`  Using pick #${pickIndex}: ${selected.product_name}`);
    } else {
      const best = pickBestPcMatch(results, identification);
      if (best) {
        selected = pcProductToMatch(best);
        const idx = results.indexOf(best);
        console.log(`  Auto-matched #${idx}: ${selected.product_name}`);
      } else {
        selected = candidates[0];
        console.log(`  Defaulting to #0: ${selected.product_name}`);
      }
    }

    return { selected, candidates };
  }

  // Fallback: single-product text search
  try {
    const single = await getProductByQuery(query);
    console.log(`  PriceCharting hit (single): ${single["product-name"]} (${single["console-name"]})`);
    const match = pcProductToMatch(single);
    return { selected: match, candidates: [match] };
  } catch {
    // No match
  }

  console.log("  PriceCharting: no match found");
  return { selected: null, candidates: [] };
}

function pcProductToMatch(product: PriceChartingProduct): PriceChartingMatch {
  return {
    pricecharting_id: String(product.id),
    product_name: product["product-name"],
    console_name: product["console-name"],
    loose_price_cents: product["loose-price"] ?? 0,
    cib_price_cents: product["cib-price"] ?? 0,
    new_price_cents: product["new-price"] ?? 0,
    graded_price_cents: product["graded-price"],
  };
}

function pickBestPcMatch(
  results: PriceChartingProduct[],
  identification: IdentificationResult
): PriceChartingProduct | null {
  const title = identification.title.toLowerCase();
  const set = identification.details.set?.toLowerCase();
  const cardNum = identification.details.card_number?.toLowerCase();

  let bestScore = 0;
  let bestMatch: PriceChartingProduct | null = null;

  for (const product of results) {
    let score = 0;
    const pcName = product["product-name"].toLowerCase();
    const pcConsole = product["console-name"].toLowerCase();

    const titleWords = title.split(/\s+/);
    for (const word of titleWords) {
      if (word.length > 2 && pcName.includes(word)) score += 2;
    }

    if (set && pcConsole.includes(set)) score += 5;
    if (cardNum && pcName.includes(cardNum)) score += 10;

    if (score > bestScore) {
      bestScore = score;
      bestMatch = product;
    }
  }

  return bestScore >= 4 ? bestMatch : results[0];
}

// ---------------------------------------------------------------------------
// Step 3: Fallbacks (eBay + Google Lens, only when PriceCharting misses)
// ---------------------------------------------------------------------------

function hasEbayCredentials(): boolean {
  return !!(process.env.EBAY_APP_ID && process.env.EBAY_CERT_ID);
}

async function fetchFallbackPricing(
  result: VisualSearchResult,
  imageUrl: string | null,
  options: SearchOptions
): Promise<void> {
  console.log("  PriceCharting miss - trying fallback sources...");

  const promises: Promise<void>[] = [];

  // eBay sold listings
  if (!options.skipEbay && hasEbayCredentials()) {
    promises.push(
      getEbayPrices(result.identification.search_queries.ebay)
        .then((ebay) => {
          result.ebay_prices = ebay;
        })
        .catch((err) => {
          console.warn(
            `  eBay pricing failed: ${err instanceof Error ? err.message : err}`
          );
        })
    );
  } else if (!options.skipEbay) {
    console.log("  eBay skipped (no credentials configured)");
  }

  // Google Lens (needs an image URL)
  if (!options.skipGoogleLens && imageUrl) {
    promises.push(
      getGoogleLensPrices(imageUrl)
        .then((lens) => {
          result.google_lens_prices = lens;
        })
        .catch((err) => {
          console.warn(
            `  Google Lens pricing failed: ${err instanceof Error ? err.message : err}`
          );
        })
    );
  } else if (!options.skipGoogleLens && !imageUrl) {
    console.log("  Google Lens skipped (no image URL available - use a URL or upload to Supabase Storage)");
  }

  await Promise.all(promises);
}

// ---------------------------------------------------------------------------
// Upload local file to Supabase Storage for Google Lens
// ---------------------------------------------------------------------------

async function uploadForLens(filePath: string): Promise<string | null> {
  try {
    const { readFileSync } = await import("fs");
    const { basename, extname } = await import("path");

    const fileName = `lens-temp/${Date.now()}-${basename(filePath)}`;
    const fileData = readFileSync(filePath);
    const ext = extname(filePath).toLowerCase();
    const contentType =
      ext === ".png" ? "image/png" :
      ext === ".webp" ? "image/webp" :
      ext === ".gif" ? "image/gif" :
      "image/jpeg";

    const { error } = await supabase.storage
      .from("product-images")
      .upload(fileName, fileData, { contentType, upsert: true });

    if (error) {
      // Bucket may not exist yet - this is non-critical
      return null;
    }

    const { data: urlData } = supabase.storage
      .from("product-images")
      .getPublicUrl(fileName);

    return urlData.publicUrl;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Price selection
// ---------------------------------------------------------------------------

function resolvePricing(result: VisualSearchResult): void {
  // Priority: PriceCharting > eBay sold > Google Lens

  if (result.pricecharting) {
    const pc = result.pricecharting;
    const price = pc.loose_price_cents || pc.cib_price_cents || pc.new_price_cents;
    if (price > 0) {
      result.suggested_market_price_cents = price;
      result.price_source = "pricecharting";
      return;
    }
  }

  const ebayMedian = result.ebay_prices?.median_price_cents;
  if (ebayMedian && ebayMedian > 0) {
    result.suggested_market_price_cents = ebayMedian;
    result.price_source = "ebay_sold";
    return;
  }

  const lensMedian = result.google_lens_prices?.median_price_cents;
  if (lensMedian && lensMedian > 0) {
    result.suggested_market_price_cents = lensMedian;
    result.price_source = "google_lens";
    return;
  }

  result.price_source = "identification_only";
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

async function runPipeline(
  identification: IdentificationResult,
  imageUrl: string | null,
  options: SearchOptions,
  localFilePath?: string
): Promise<VisualSearchResult> {
  const result: VisualSearchResult = {
    identification,
    price_source: "identification_only",
  };

  if (options.identifyOnly) {
    return result;
  }

  // Step 2: Try PriceCharting first
  if (!options.skipPriceCharting) {
    try {
      const pcResult = await tryPriceCharting(identification, options.pcPick);
      result.pricecharting = pcResult.selected ?? undefined;
      result.pc_candidates = pcResult.candidates.length > 1 ? pcResult.candidates : undefined;
    } catch (err) {
      console.warn(
        `  PriceCharting search failed: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  // Step 3: Only hit fallbacks if PriceCharting missed
  const pcHasPrice =
    result.pricecharting &&
    (result.pricecharting.loose_price_cents > 0 ||
      result.pricecharting.cib_price_cents > 0 ||
      result.pricecharting.new_price_cents > 0);

  if (!pcHasPrice) {
    // Lazy upload for Google Lens - only when we actually need fallback
    let lensUrl = imageUrl;
    if (!lensUrl && localFilePath && !options.skipGoogleLens) {
      lensUrl = await uploadForLens(localFilePath);
    }
    await fetchFallbackPricing(result, lensUrl, options);
  }

  resolvePricing(result);

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function visualSearchFromFile(
  filePath: string,
  options?: SearchOptions
): Promise<VisualSearchResult> {
  const opts = options ?? {};

  console.log("Step 1: Identifying item from image...");
  const identification = await identifyFromFile(filePath, opts.additionalContext);
  console.log(`  Identified: ${identification.title} (${identification.confidence} confidence)`);

  // Pass filePath so we can lazy-upload for Google Lens only if needed
  return runPipeline(identification, null, opts, filePath);
}

export async function visualSearchFromUrl(
  imageUrl: string,
  options?: SearchOptions
): Promise<VisualSearchResult> {
  const opts = options ?? {};

  console.log("Step 1: Identifying item from image URL...");
  const identification = await identifyFromUrl(imageUrl, opts.additionalContext);
  console.log(`  Identified: ${identification.title} (${identification.confidence} confidence)`);

  return runPipeline(identification, imageUrl, opts);
}
