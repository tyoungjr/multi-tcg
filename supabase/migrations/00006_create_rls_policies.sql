-- Enable RLS on all tables
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_images ENABLE ROW LEVEL SECURITY;

-- Service role has full access (used by our backend)
-- These policies allow the service_role key to do everything
CREATE POLICY "Service role full access on products"
  ON products FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role full access on price_history"
  ON price_history FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role full access on product_images"
  ON product_images FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Anon/authenticated can read products (for Shopify storefront)
CREATE POLICY "Public read access on products"
  ON products FOR SELECT
  USING (true);

CREATE POLICY "Public read access on product_images"
  ON product_images FOR SELECT
  USING (true);
