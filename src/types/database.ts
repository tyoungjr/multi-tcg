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
