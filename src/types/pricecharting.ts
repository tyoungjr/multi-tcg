// ---------------------------------------------------------------------------
// Prices API
// ---------------------------------------------------------------------------

export interface PriceChartingProduct {
  status?: string;
  id: string;
  "product-name": string;
  "console-name": string;
  "release-date"?: string;
  genre?: string;
  "sales-volume"?: string;

  // Prices (cents)
  "loose-price": number;
  "cib-price": number;
  "new-price": number;
  "graded-price"?: number;
  "box-only-price"?: number;
  "manual-only-price"?: number;
  "gamestop-price"?: number;

  // Retail buy/sell
  "retail-loose-buy"?: number;
  "retail-loose-sell"?: number;
  "retail-cib-buy"?: number;
  "retail-cib-sell"?: number;
  "retail-new-buy"?: number;
  "retail-new-sell"?: number;

  // Card/comic grading prices
  "bgs-10-price"?: number;
  "condition-17-price"?: number;
  "condition-18-price"?: number;

  // Identifiers
  upc?: string;
  asin?: string;
  epid?: string;
}

export interface PriceChartingSearchResult {
  status: string;
  products: PriceChartingProduct[];
}

// ---------------------------------------------------------------------------
// Marketplace API - Offers
// ---------------------------------------------------------------------------

export interface PriceChartingOffer {
  "offer-id": string;
  "offer-url": string;
  "offer-status": string;
  "is-sold": boolean;
  "is-ended": boolean;
  "is-shipped": boolean;
  "is-available": boolean;
  "is-collection": boolean;

  "product-name": string;
  "console-name": string;
  id?: string;
  price: number;
  "condition-string": string;
  "include-string"?: string;

  "started-time"?: string;
  "sale-time"?: string;
  "ended-time"?: string;
  "shipped-time"?: string;

  "cert-id"?: string;
  "grade-co-id"?: string;
  "cost-basis"?: number;
  sku?: string;
  quantity?: number;
  "has-pictures"?: boolean;
}

export interface PriceChartingOffersResult {
  status: string;
  offers: PriceChartingOffer[];
}

// ---------------------------------------------------------------------------
// Marketplace API - Offer Details (includes buyer/shipping info)
// ---------------------------------------------------------------------------

export interface PriceChartingOfferDetails extends PriceChartingOffer {
  "max-price"?: number;
  "min-price"?: number;
  "is-refunded"?: boolean;
  "is-price-descending"?: boolean;
  "refunded-time"?: string;

  // Buyer info (only on sold offers)
  "buyer-email"?: string;
  "shipping-name"?: string;
  "shipping-line1"?: string;
  "shipping-line2"?: string;
  "shipping-city"?: string;
  "shipping-state"?: string;
  "shipping-zip"?: string;
  "shipping-country"?: string;
  "shipping-premium"?: boolean;

  // Feedback
  "buyer-left-feedback"?: boolean;
  "seller-left-feedback"?: boolean;
  "tracking-number"?: string;
}

// ---------------------------------------------------------------------------
// Marketplace API - Offer Publish
// ---------------------------------------------------------------------------

export interface OfferPublishParams {
  // Product identification (at least one required)
  product?: string;
  upc?: string;
  asin?: string;
  epid?: string;
  "offer-id"?: string;

  // Required
  "price-max": number;
  "condition-id": number;

  // Optional
  "price-min"?: number;
  "cost-basis"?: number;
  sku?: string;
  description?: string;
  quantity?: number;
  "add-to-collection"?: "on";

  // Condition tags
  pristine?: "on";
  broken?: "on";
  scratch?: "on";
  stickers?: "on";
  tear?: "on";
  writing?: "on";

  // Photos (URLs)
  photo1?: string;
  photo2?: string;
  photo3?: string;
  photo4?: string;
  photo5?: string;
  photo6?: string;
}

export interface OfferPublishResult {
  status: string;
  "offer-id": string;
  "offer-url": string;
  "offer-status": string;
  "product-name": string;
  "console-name": string;
  price: number;
  "condition-string": string;
  "include-string"?: string;
  "start-time": string;
  "cost-basis"?: number;
  sku?: string;
  quantity?: number;
  "has-pictures"?: boolean;
  "is-collection"?: boolean;
}

// ---------------------------------------------------------------------------
// Marketplace API - Simple responses
// ---------------------------------------------------------------------------

export interface OfferShipResult {
  status: string;
  "offer-id": string;
  "is-shipped": boolean;
  "shipped-time": string;
  "tracking-number"?: string;
}

export interface OfferEndResult {
  status: string;
  "offer-id": string;
  "is-ended": boolean;
  "ended-time": string;
}

export interface OfferRefundResult {
  status: string;
  "offer-id": string;
  "is-refunded": boolean;
  "refunded-time": string;
}

export interface OfferFeedbackResult {
  status: string;
  "offer-id": string;
  rating: number;
  comment?: string;
}

// ---------------------------------------------------------------------------
// Reference: Condition IDs
// ---------------------------------------------------------------------------

export const CONDITION_IDS = {
  // Video Games
  loose: 1,
  new_sealed: 2,
  cib: 3,
  graded: 5,
  box_only: 6,
  manual_only: 7,
  item_and_box: 8,
  item_and_manual: 9,
  box_and_manual: 10,
  graded_cib: 13,
} as const;
