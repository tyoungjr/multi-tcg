-- Physical location / box label for each inventory item. Freeform text so the
-- user can stamp anything ("Tin A slot 3", "Binder 2 p7", "Top shelf box").
-- pg_trgm is already enabled by 00007 — trigram index keeps fuzzy lookups
-- ("show me everything in tin a") fast as inventory grows.

ALTER TABLE products
  ADD COLUMN location TEXT;

CREATE INDEX idx_products_location_trgm
  ON products USING GIN (location gin_trgm_ops)
  WHERE location IS NOT NULL;
