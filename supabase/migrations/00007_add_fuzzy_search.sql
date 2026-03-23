-- Enable trigram extension for fuzzy search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Create trigram index on product titles for fast fuzzy matching
CREATE INDEX idx_products_title_trgm ON products USING GIN (title gin_trgm_ops);

-- Create a helper function for fuzzy product search
-- Returns products ordered by similarity score (best match first)
CREATE OR REPLACE FUNCTION search_products_fuzzy(
  search_query TEXT,
  similarity_threshold REAL DEFAULT 0.15,
  max_results INTEGER DEFAULT 20
)
RETURNS TABLE (
  id UUID,
  title TEXT,
  category product_category,
  condition product_condition,
  inventory_status inventory_status,
  current_price INTEGER,
  market_price INTEGER,
  pricecharting_id TEXT,
  metadata JSONB,
  quantity INTEGER,
  similarity_score REAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.id,
    p.title,
    p.category,
    p.condition,
    p.inventory_status,
    p.current_price,
    p.market_price,
    p.pricecharting_id,
    p.metadata,
    p.quantity,
    similarity(p.title, search_query) AS similarity_score
  FROM products p
  WHERE
    similarity(p.title, search_query) > similarity_threshold
    OR p.title ILIKE '%' || search_query || '%'
  ORDER BY
    similarity(p.title, search_query) DESC,
    p.title ASC
  LIMIT max_results;
END;
$$ LANGUAGE plpgsql;
