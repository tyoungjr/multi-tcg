import type {
  PriceChartingProduct,
  PriceChartingSearchResult,
  PriceChartingOffer,
  PriceChartingOffersResult,
  PriceChartingOfferDetails,
  OfferPublishParams,
  OfferPublishResult,
  OfferShipResult,
  OfferEndResult,
  OfferRefundResult,
  OfferFeedbackResult,
} from "../types/pricecharting";

const BASE_URL = "https://www.pricecharting.com/api";

function getApiKey(): string {
  const key = process.env.PRICECHARTING_API_KEY;
  if (!key) {
    throw new Error(
      "Missing PRICECHARTING_API_KEY in environment. Add it to your .env file."
    );
  }
  return key;
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

let lastCallTime = 0;
const DEFAULT_DELAY_MS = 1100;

async function rateLimit(delayMs: number = DEFAULT_DELAY_MS): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < delayMs) {
    await new Promise((resolve) => setTimeout(resolve, delayMs - elapsed));
  }
  lastCallTime = Date.now();
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function apiGet<T>(
  endpoint: string,
  params: Record<string, string>
): Promise<T> {
  await rateLimit();

  const url = new URL(`${BASE_URL}/${endpoint}`);
  url.searchParams.set("t", getApiKey());
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(
      `PriceCharting API error: ${response.status} ${response.statusText}`
    );
  }

  return response.json() as Promise<T>;
}

async function apiPost<T>(
  endpoint: string,
  params: Record<string, string>
): Promise<T> {
  await rateLimit();

  const url = new URL(`${BASE_URL}/${endpoint}`);
  url.searchParams.set("t", getApiKey());

  const body = new URLSearchParams(params);
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(
      `PriceCharting API error: ${response.status} ${response.statusText}`
    );
  }

  return response.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Prices API - /api/product (single product)
// ---------------------------------------------------------------------------

export async function getProductById(
  id: string
): Promise<PriceChartingProduct> {
  const data = await apiGet<PriceChartingProduct>("product", { id });
  if (data.status === "error") {
    throw new Error(`PriceCharting product not found: id=${id}`);
  }
  return data;
}

export async function getProductByUpc(
  upc: string
): Promise<PriceChartingProduct> {
  const data = await apiGet<PriceChartingProduct>("product", { upc });
  if (data.status === "error") {
    throw new Error(`PriceCharting product not found: upc=${upc}`);
  }
  return data;
}

export async function getProductByQuery(
  query: string
): Promise<PriceChartingProduct> {
  const data = await apiGet<PriceChartingProduct>("product", { q: query });
  if (data.status === "error") {
    throw new Error(`PriceCharting product not found: q=${query}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Prices API - /api/products (multi-product search, max 20 results)
// ---------------------------------------------------------------------------

export async function searchProducts(
  query: string
): Promise<PriceChartingProduct[]> {
  const data = await apiGet<PriceChartingSearchResult>("products", {
    q: query,
  });
  if (data.status === "error") {
    return [];
  }
  return data.products ?? [];
}

// ---------------------------------------------------------------------------
// Price helper
// ---------------------------------------------------------------------------

export function getPriceForCondition(
  product: PriceChartingProduct,
  condition: "loose" | "cib" | "new_sealed" | "graded"
): number | null {
  switch (condition) {
    case "loose":
      return product["loose-price"] ?? null;
    case "cib":
      return product["cib-price"] ?? null;
    case "new_sealed":
      return product["new-price"] ?? null;
    case "graded":
      return product["graded-price"] ?? null;
    default:
      return product["loose-price"] ?? null;
  }
}

// Grade-aware price picker. For graded items, prefers the most specific tier
// available (BGS 10, then aggregate graded, then condition-17/18) and never
// falls back to loose — a graded card is fundamentally different inventory.
export function pickPriceTier(
  product: PriceChartingProduct,
  condition: string | null | undefined,
  gradingCompany?: string | null,
  gradedScore?: number | null
): number | null {
  const loose = product["loose-price"] ?? 0;
  const cib = product["cib-price"] ?? 0;
  const neu = product["new-price"] ?? 0;
  const graded = product["graded-price"] ?? 0;
  const bgs10 = product["bgs-10-price"] ?? 0;
  const cond17 = product["condition-17-price"] ?? 0;
  const cond18 = product["condition-18-price"] ?? 0;

  if (condition === "graded") {
    const company = (gradingCompany ?? "").toUpperCase();
    if (company === "BGS" && (gradedScore ?? 0) >= 10 && bgs10 > 0) return bgs10;
    if (graded > 0) return graded;
    if (cond18 > 0) return cond18;
    if (cond17 > 0) return cond17;
    if (bgs10 > 0) return bgs10;
    return null;
  }

  switch (condition) {
    case "cib":
      return cib > 0 ? cib : loose > 0 ? loose : null;
    case "new_sealed":
      return neu > 0 ? neu : loose > 0 ? loose : null;
    case "loose":
    case "good":
    case "very_good":
    default:
      return loose > 0 ? loose : null;
  }
}

// ---------------------------------------------------------------------------
// Marketplace API - /api/offers (list offers)
// ---------------------------------------------------------------------------

export type OfferStatus = "available" | "sold" | "ended" | "collection";
export type OfferSort = "name" | "starts" | "lowest-price";

export interface ListOffersParams {
  status: OfferStatus;
  seller?: string;
  buyer?: string;
  console?: string;
  "condition-id"?: string;
  genre?: string;
  id?: string;
  sort?: OfferSort;
}

export async function listOffers(
  params: ListOffersParams
): Promise<PriceChartingOffer[]> {
  const stringParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      stringParams[key] = String(value);
    }
  }

  const data = await apiGet<PriceChartingOffersResult>("offers", stringParams);
  if (data.status === "error") {
    return [];
  }
  return data.offers ?? [];
}

export async function getCollection(
  sellerId: string
): Promise<PriceChartingOffer[]> {
  return listOffers({ status: "collection", seller: sellerId });
}

// ---------------------------------------------------------------------------
// Marketplace API - /api/offer-details
// ---------------------------------------------------------------------------

export async function getOfferDetails(
  offerId: string
): Promise<PriceChartingOfferDetails> {
  const data = await apiGet<PriceChartingOfferDetails>("offer-details", {
    "offer-id": offerId,
  });
  return data;
}

// ---------------------------------------------------------------------------
// Marketplace API - /api/offer-publish (POST)
// ---------------------------------------------------------------------------

export async function publishOffer(
  params: OfferPublishParams
): Promise<OfferPublishResult> {
  const stringParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      stringParams[key] = String(value);
    }
  }

  return apiPost<OfferPublishResult>("offer-publish", stringParams);
}

export async function addToCollection(
  productId: string,
  conditionId: number,
  priceCents: number,
  costBasis?: number
): Promise<OfferPublishResult> {
  const params: OfferPublishParams = {
    product: productId,
    "price-max": priceCents,
    "condition-id": conditionId,
    "add-to-collection": "on",
  };
  if (costBasis !== undefined) {
    params["cost-basis"] = costBasis;
  }
  return publishOffer(params);
}

// ---------------------------------------------------------------------------
// Marketplace API - /api/offer-ship (POST)
// ---------------------------------------------------------------------------

export async function shipOffer(
  offerId: string,
  trackingNumber?: string
): Promise<OfferShipResult> {
  const params: Record<string, string> = { "offer-id": offerId };
  if (trackingNumber) {
    params["tracking-number"] = trackingNumber;
  }
  return apiPost<OfferShipResult>("offer-ship", params);
}

// ---------------------------------------------------------------------------
// Marketplace API - /api/offer-end (POST)
// ---------------------------------------------------------------------------

export async function endOffer(offerId: string): Promise<OfferEndResult> {
  return apiPost<OfferEndResult>("offer-end", { "offer-id": offerId });
}

// ---------------------------------------------------------------------------
// Marketplace API - /api/offer-refund (POST)
// ---------------------------------------------------------------------------

export async function refundOffer(offerId: string): Promise<OfferRefundResult> {
  return apiPost<OfferRefundResult>("offer-refund", { "offer-id": offerId });
}

// ---------------------------------------------------------------------------
// Marketplace API - /api/offer-feedback (POST)
// ---------------------------------------------------------------------------

export async function leaveFeedback(
  offerId: string,
  rating: -2 | -1 | 0 | 1 | 2,
  comment?: string
): Promise<OfferFeedbackResult> {
  const params: Record<string, string> = {
    "offer-id": offerId,
    rating: String(rating),
  };
  if (comment) {
    params.comment = comment;
  }
  return apiPost<OfferFeedbackResult>("offer-feedback", params);
}
