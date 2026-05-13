export type ProductCategory =
  | "trading_card"
  | "video_game"
  | "console_hardware"
  | "accessory"
  | "arcade"
  | "coin"
  | "comic"
  | "toy"
  | "apparel"
  | "electronics"
  | "promotional"
  | "misc";

export type ProductCondition =
  | "loose"
  | "good"
  | "very_good"
  | "cib"
  | "new_sealed"
  | "graded";

export type InventoryStatus =
  | "in_stock"
  | "listed_shopify"
  | "listed_ebay"
  | "listed_multi"
  | "sold"
  | "personal_collection";

export type PriceSource =
  | "pricecharting"
  | "ebay_sold"
  | "manual"
  | "visual_search"
  | "shopify_sale";

export interface Product {
  id: string;
  title: string;
  category: ProductCategory;
  description: string | null;
  condition: ProductCondition | null;
  graded_score: number | null;
  grading_company: string | null;
  inventory_status: InventoryStatus;
  pricecharting_id: string | null;
  shopify_product_id: string | null;
  shopify_variant_id: string | null;
  ebay_listing_id: string | null;
  upc: string | null;
  asin: string | null;
  purchase_price: number | null;
  purchase_date: string | null;
  purchase_source: string | null;
  purchase_notes: string | null;
  current_price: number | null;
  market_price: number | null;
  metadata: Record<string, unknown>;
  quantity: number;
  shopify_synced_at: string | null;
  set_name: string | null;
  set_number: string | null;
  location: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProductInsert {
  title: string;
  category: ProductCategory;
  description?: string | null;
  condition?: ProductCondition | null;
  graded_score?: number | null;
  grading_company?: string | null;
  inventory_status?: InventoryStatus;
  pricecharting_id?: string | null;
  shopify_product_id?: string | null;
  shopify_variant_id?: string | null;
  ebay_listing_id?: string | null;
  upc?: string | null;
  asin?: string | null;
  purchase_price?: number | null;
  purchase_date?: string | null;
  purchase_source?: string | null;
  purchase_notes?: string | null;
  current_price?: number | null;
  market_price?: number | null;
  metadata?: Record<string, unknown>;
  quantity?: number;
  set_name?: string | null;
  set_number?: string | null;
  location?: string | null;
}

export interface PriceHistory {
  id: string;
  product_id: string;
  source: PriceSource;
  price_cents: number;
  condition: ProductCondition | null;
  raw_data: Record<string, unknown> | null;
  recorded_at: string;
}

export interface PriceHistoryInsert {
  product_id: string;
  source: PriceSource;
  price_cents: number;
  condition?: ProductCondition | null;
  raw_data?: Record<string, unknown> | null;
}

export interface ProductImage {
  id: string;
  product_id: string;
  storage_path: string | null;
  url: string | null;
  is_primary: boolean;
  sort_order: number;
  alt_text: string | null;
  visual_search_result: Record<string, unknown> | null;
  created_at: string;
}

export interface ProductImageInsert {
  product_id: string;
  storage_path?: string | null;
  url?: string | null;
  is_primary?: boolean;
  sort_order?: number;
  alt_text?: string | null;
  visual_search_result?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Bundles (decks, lots, multi-item bundles)
// ---------------------------------------------------------------------------

export type BundleKind = "deck" | "bundle" | "lot";
export type BundleGame =
  | "yugioh"
  | "pokemon"
  | "mtg"
  | "onepiece"
  | "digimon"
  | "sports"
  | "other";

export type BundleItemSection = "main" | "extra" | "side";
export type BundleItemPriceSource =
  | "self"
  | "pricecharting"
  | "ebay_sold"
  | "ygoprodeck"
  | "manual";

export type BundleBanlistStatus = "Banned" | "Limited" | "Semi-Limited";

export interface Bundle {
  id: string;
  title: string;
  kind: BundleKind;
  game: BundleGame | null;
  format: string | null;
  description: string | null;
  source: string | null;
  source_url: string | null;
  pilot: string | null;
  is_meta: boolean;
  staple_count: number;
  archetypes: string[];
  total_items: number;
  in_stock_items: number;
  in_stock_total_cents: number;
  missing_total_cents: number;
  shopify_product_id: string | null;
  shopify_variant_id: string | null;
  shopify_synced_at: string | null;
  ebay_listing_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface BundleInsert {
  title: string;
  kind?: BundleKind;
  game?: BundleGame | null;
  format?: string | null;
  description?: string | null;
  source?: string | null;
  source_url?: string | null;
  pilot?: string | null;
  is_meta?: boolean;
  staple_count?: number;
  archetypes?: string[];
  total_items?: number;
  in_stock_items?: number;
  in_stock_total_cents?: number;
  missing_total_cents?: number;
  metadata?: Record<string, unknown>;
}

export interface BundleItem {
  id: string;
  bundle_id: string;
  product_id: string | null;
  pricecharting_id: string | null;
  konami_id: string | null;
  card_name: string;
  set_name: string | null;
  set_number: string | null;
  image_url: string | null;
  quantity: number;
  position: number | null;
  section: BundleItemSection | string | null;
  unit_price_cents: number | null;
  price_source: BundleItemPriceSource | string | null;
  price_updated_at: string | null;
  is_staple: boolean;
  archetype: string | null;
  card_type: string | null;
  banlist_status: BundleBanlistStatus | string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface BundleItemInsert {
  bundle_id: string;
  product_id?: string | null;
  pricecharting_id?: string | null;
  konami_id?: string | null;
  card_name: string;
  set_name?: string | null;
  set_number?: string | null;
  image_url?: string | null;
  quantity?: number;
  position?: number | null;
  section?: BundleItemSection | string | null;
  unit_price_cents?: number | null;
  price_source?: BundleItemPriceSource | string | null;
  price_updated_at?: string | null;
  is_staple?: boolean;
  archetype?: string | null;
  card_type?: string | null;
  banlist_status?: BundleBanlistStatus | string | null;
  metadata?: Record<string, unknown>;
}
