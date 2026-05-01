-- Bundles: groups of cards/products sold together (decks, lots, multi-item bundles).
-- Supports PARTIAL bundles: bundle_items.product_id is nullable so we can list cards
-- we don't yet stock, with a cached market price from PriceCharting / YGOPRODeck.

CREATE TYPE bundle_kind AS ENUM ('deck', 'bundle', 'lot');
CREATE TYPE bundle_game AS ENUM ('yugioh', 'pokemon', 'mtg', 'onepiece', 'digimon', 'sports', 'other');

CREATE TABLE bundles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  kind bundle_kind NOT NULL DEFAULT 'bundle',
  game bundle_game,
  format TEXT,                  -- e.g. 'TCG', 'OCG', 'Standard', 'Modern'
  description TEXT,
  source TEXT,                  -- e.g. 'Pittsboro WCQ Top 8'
  source_url TEXT,
  pilot TEXT,                   -- e.g. 'Jose Angel Fajardo'

  -- Denormalized aggregates (recomputed on item changes for fast list queries)
  total_items INTEGER NOT NULL DEFAULT 0,
  in_stock_items INTEGER NOT NULL DEFAULT 0,
  in_stock_total_cents INTEGER NOT NULL DEFAULT 0,
  missing_total_cents INTEGER NOT NULL DEFAULT 0,

  -- Channel sync
  shopify_product_id TEXT,
  shopify_variant_id TEXT,
  shopify_synced_at TIMESTAMPTZ,
  ebay_listing_id TEXT,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER bundles_updated_at
  BEFORE UPDATE ON bundles
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

CREATE TABLE bundle_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id UUID NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,

  -- Card identification (any combination — product_id is the in-stock link)
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  pricecharting_id TEXT,
  konami_id TEXT,               -- Konami passcode (8-digit) for YGO

  -- Denormalized display fields so missing cards still render
  card_name TEXT NOT NULL,
  set_name TEXT,
  set_number TEXT,
  image_url TEXT,

  -- Bundle-specific
  quantity INTEGER NOT NULL DEFAULT 1,
  position INTEGER,              -- ordering within the bundle / section
  section TEXT,                  -- 'main' | 'extra' | 'side' for ydk decks

  -- Cached pricing
  unit_price_cents INTEGER,      -- price per single card
  price_source TEXT,             -- 'self' | 'pricecharting' | 'ebay_sold' | 'ygoprodeck' | 'manual'
  price_updated_at TIMESTAMPTZ,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bundle_items_bundle ON bundle_items (bundle_id);
CREATE INDEX idx_bundle_items_product ON bundle_items (product_id) WHERE product_id IS NOT NULL;
CREATE INDEX idx_bundle_items_konami ON bundle_items (konami_id) WHERE konami_id IS NOT NULL;
CREATE INDEX idx_bundles_kind ON bundles (kind);
CREATE INDEX idx_bundles_game ON bundles (game) WHERE game IS NOT NULL;
