// ---------------------------------------------------------------------------
// Shopify Admin REST API types (2024-01 and later)
// ---------------------------------------------------------------------------

// Product
export interface ShopifyProduct {
  id: number;
  title: string;
  body_html: string | null;
  vendor: string;
  product_type: string;
  handle: string;
  status: "active" | "archived" | "draft";
  tags: string;
  variants: ShopifyVariant[];
  images: ShopifyImage[];
  created_at: string;
  updated_at: string;
}

export interface ShopifyVariant {
  id: number;
  product_id: number;
  title: string;
  price: string;
  compare_at_price: string | null;
  sku: string | null;
  inventory_quantity: number;
  inventory_item_id: number;
  inventory_management: "shopify" | null;
  weight: number;
  weight_unit: string;
}

export interface ShopifyImage {
  id: number;
  product_id: number;
  position: number;
  src: string;
  alt: string | null;
  width: number;
  height: number;
}

// Product creation payloads
export interface ShopifyProductCreate {
  title: string;
  body_html?: string;
  vendor?: string;
  product_type?: string;
  tags?: string;
  status?: "active" | "archived" | "draft";
  variants?: ShopifyVariantCreate[];
  images?: ShopifyImageCreate[];
}

export interface ShopifyVariantCreate {
  title?: string;
  price: string;
  compare_at_price?: string;
  sku?: string;
  inventory_quantity?: number;
  inventory_management?: "shopify" | null;
  weight?: number;
  weight_unit?: string;
}

export interface ShopifyImageCreate {
  src?: string;
  attachment?: string; // base64 encoded image
  alt?: string;
  position?: number;
  filename?: string;
}

// Orders
export interface ShopifyOrder {
  id: number;
  name: string;
  email: string;
  financial_status: string;
  fulfillment_status: string | null;
  total_price: string;
  currency: string;
  line_items: ShopifyLineItem[];
  created_at: string;
  closed_at: string | null;
  cancelled_at: string | null;
}

export interface ShopifyLineItem {
  id: number;
  product_id: number | null;
  variant_id: number | null;
  title: string;
  quantity: number;
  price: string;
  sku: string | null;
}

// API responses
export interface ShopifyProductResponse {
  product: ShopifyProduct;
}

export interface ShopifyProductsResponse {
  products: ShopifyProduct[];
}

export interface ShopifyOrdersResponse {
  orders: ShopifyOrder[];
}
