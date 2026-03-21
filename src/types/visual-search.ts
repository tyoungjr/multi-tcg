// ---------------------------------------------------------------------------
// Claude Vision - Item Identification
// ---------------------------------------------------------------------------

export interface IdentificationResult {
  title: string;
  category: string;
  description: string;
  confidence: "high" | "medium" | "low";

  // Structured details Claude extracts
  details: {
    game?: string;
    set?: string;
    card_number?: string;
    rarity?: string;
    variant?: string;
    platform?: string;
    region?: string;
    year?: number;
    brand?: string;
    character?: string;
    manufacturer?: string;
    condition_estimate?: string;
    grading_company?: string;
    grade?: number;
    [key: string]: unknown;
  };

  // Search queries to use for pricing lookups
  search_queries: {
    primary: string;
    ebay: string;
  };

  raw_response: string;
}

// ---------------------------------------------------------------------------
// eBay Sold Listings
// ---------------------------------------------------------------------------

export interface EbaySoldListing {
  title: string;
  price_cents: number;
  currency: string;
  sold_date: string;
  condition: string;
  url: string;
  image_url?: string;
  shipping_cents?: number;
}

export interface EbayPriceEstimate {
  query: string;
  listings: EbaySoldListing[];
  average_price_cents: number;
  median_price_cents: number;
  low_price_cents: number;
  high_price_cents: number;
  sample_size: number;
}

// ---------------------------------------------------------------------------
// PriceCharting match (from identification -> PC search)
// ---------------------------------------------------------------------------

export interface PriceChartingMatch {
  pricecharting_id: string;
  product_name: string;
  console_name: string;
  loose_price_cents: number;
  cib_price_cents: number;
  new_price_cents: number;
  graded_price_cents?: number;
}

// ---------------------------------------------------------------------------
// Unified Visual Search Result
// ---------------------------------------------------------------------------

export interface VisualSearchResult {
  identification: IdentificationResult;
  pricecharting?: PriceChartingMatch;
  pc_candidates?: PriceChartingMatch[];
  ebay_prices?: EbayPriceEstimate;
  google_lens_prices?: {
    query_description: string;
    results: Array<{
      title: string;
      price_cents: number;
      source: string;
      url: string;
      currency: string;
    }>;
    average_price_cents: number;
    median_price_cents: number;
    low_price_cents: number;
    high_price_cents: number;
    sample_size: number;
  };
  suggested_market_price_cents?: number;
  price_source: string;
}
