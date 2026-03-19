CREATE TABLE product_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  storage_path TEXT,
  url TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  alt_text TEXT,
  visual_search_result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
