-- Products indexes
CREATE INDEX idx_products_category ON products(category);
CREATE INDEX idx_products_status ON products(inventory_status);
CREATE INDEX idx_products_pricecharting_id ON products(pricecharting_id);
CREATE INDEX idx_products_shopify_product_id ON products(shopify_product_id);
CREATE INDEX idx_products_upc ON products(upc);
CREATE INDEX idx_products_metadata ON products USING GIN (metadata);

-- Price history indexes
CREATE INDEX idx_price_history_product_id ON price_history(product_id);
CREATE INDEX idx_price_history_recorded_at ON price_history(recorded_at);

-- Product images indexes
CREATE INDEX idx_product_images_product_id ON product_images(product_id);
