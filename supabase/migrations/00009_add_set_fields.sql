-- Add set_name and set_number fields for trading cards.
-- Stored as free text now; can be normalized into a `sets` table later if filtering needs grow.

ALTER TABLE products ADD COLUMN IF NOT EXISTS set_name TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS set_number TEXT;

CREATE INDEX IF NOT EXISTS idx_products_set_name ON products (set_name) WHERE set_name IS NOT NULL;
