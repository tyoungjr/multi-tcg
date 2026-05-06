-- Bundle meta tagging + per-card YGOPRODeck attributes.
--
-- Adds is_meta as a human-curated flag on bundles for ad targeting / sourcing
-- priority. Also adds derived aggregates (staple_count, archetypes) that we
-- compute from the YGOPRODeck card data on import/recompute.
--
-- On bundle_items, denormalizes the attributes most useful for filtering and
-- warnings: is_staple, archetype, card_type, banlist_status. Heavier card
-- attributes (atk/def/level/race/attribute) stay in metadata JSONB to avoid
-- column bloat — promote later if filter UI demands them.

ALTER TABLE bundles
  ADD COLUMN is_meta BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN staple_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN archetypes TEXT[] NOT NULL DEFAULT '{}'::text[];

CREATE INDEX idx_bundles_is_meta ON bundles (is_meta) WHERE is_meta = true;
CREATE INDEX idx_bundles_archetypes ON bundles USING GIN (archetypes);

ALTER TABLE bundle_items
  ADD COLUMN is_staple BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN archetype TEXT,
  ADD COLUMN card_type TEXT,                 -- e.g. 'Effect Monster', 'XYZ Monster', 'Spell Card'
  ADD COLUMN banlist_status TEXT;            -- 'Banned' | 'Limited' | 'Semi-Limited' (NULL when unrestricted)

CREATE INDEX idx_bundle_items_is_staple ON bundle_items (is_staple) WHERE is_staple = true;
CREATE INDEX idx_bundle_items_banlist ON bundle_items (banlist_status) WHERE banlist_status IS NOT NULL;

