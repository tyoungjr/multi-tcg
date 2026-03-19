CREATE TABLE price_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  source price_source NOT NULL,
  price_cents INTEGER NOT NULL,
  condition product_condition,
  raw_data JSONB,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
