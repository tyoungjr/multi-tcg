-- Add shopify_synced_at to track when a product was last pushed to Shopify.
-- Only products where updated_at > shopify_synced_at need re-pushing.

ALTER TABLE products ADD COLUMN IF NOT EXISTS shopify_synced_at timestamptz;

-- Index to quickly find products that need syncing
CREATE INDEX IF NOT EXISTS idx_products_sync_stale
  ON products (updated_at, shopify_synced_at)
  WHERE shopify_product_id IS NOT NULL;
