CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Core
  title TEXT NOT NULL,
  category product_category NOT NULL,
  description TEXT,
  condition product_condition,
  graded_score NUMERIC(4, 1),
  grading_company TEXT,

  -- Status
  inventory_status inventory_status NOT NULL DEFAULT 'in_stock',

  -- External IDs
  pricecharting_id TEXT,
  shopify_product_id TEXT,
  shopify_variant_id TEXT,
  ebay_listing_id TEXT,
  upc TEXT,
  asin TEXT,

  -- Acquisition
  purchase_price INTEGER,
  purchase_date DATE,
  purchase_source TEXT,
  purchase_notes TEXT,

  -- Pricing (cents)
  current_price INTEGER,
  market_price INTEGER,

  -- Flexible metadata
  metadata JSONB DEFAULT '{}'::jsonb,

  quantity INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
