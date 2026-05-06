// Compose a Bundle (deck/bundle/lot) from a parsed input source. Today only
// .ydk is supported; future ingestion paths (paste-list, scryfall import) will
// land here too. The preview function is pure-read and the create function
// persists rows; both share the same matching pipeline.

import { supabase } from "../lib/supabase";
import { parseDeck, groupYdk, uniquePasscodes } from "./ydk-parser";
import type { YdkParsed, YdkSection } from "./ydk-parser";
import {
  lookupCardsByPasscode,
  pickCheapestPrinting,
  pickUsPriceCents,
  isStaple,
  getBanlistStatus,
} from "./ygoprodeck";
import type { BanlistFormat, YgoCard } from "./ygoprodeck";
import type {
  BundleGame,
  BundleInsert,
  BundleItemInsert,
  BundleItemPriceSource,
  BundleKind,
} from "../types/database";

export interface CreateBundleOptions {
  title: string;
  kind?: BundleKind;
  game?: BundleGame;
  format?: string | null;
  source?: string | null;
  source_url?: string | null;
  pilot?: string | null;
  description?: string | null;
  is_meta?: boolean;
}

export interface PreviewItem {
  passcode: string;
  card_name: string;
  quantity: number;
  section: YdkSection;
  // Inventory match
  product_id: string | null;
  in_stock: boolean;
  // Pricing
  unit_price_cents: number | null;
  price_source: BundleItemPriceSource | null;
  line_total_cents: number; // unit_price_cents * quantity (0 if no price)
  // Display
  set_name: string | null;
  set_number: string | null;
  image_url: string | null;
  // YGOPRODeck attributes (denormalized for filtering / warnings)
  is_staple: boolean;
  archetype: string | null;
  card_type: string | null;
  banlist_status: string | null;
}

export interface PreviewSummary {
  total_items: number;          // sum of quantities
  unique_cards: number;         // distinct passcodes
  in_stock_items: number;       // sum of qty for in-stock cards
  in_stock_total_cents: number;
  missing_total_cents: number;
  staple_count: number;         // unique cards flagged staple by YGOPRODeck
  archetypes: string[];         // sorted, deduped archetypes present
  banlist_warnings: BanlistWarning[];
  unresolved_passcodes: string[]; // not found in YGOPRODeck
  unknown_directives: string[];   // surfaced from parser
}

export interface BanlistWarning {
  passcode: string;
  card_name: string;
  status: string; // "Banned" | "Limited" | "Semi-Limited"
  quantity: number;
}

export interface BundlePreview {
  parsed: YdkParsed;
  items: PreviewItem[];
  summary: PreviewSummary;
}

// Fuzzy similarity threshold for card-name -> products.title matching.
// 0.4 tolerates minor punctuation/article differences while rejecting unrelated cards.
const FUZZY_THRESHOLD = 0.4;

// Map a freeform bundle.format string to a YGOPRODeck banlist key. Unknown
// formats fall back to TCG, which is what most users care about.
function banlistFormatFor(format: string | null | undefined): BanlistFormat {
  const f = (format ?? "").toLowerCase();
  if (f.includes("ocg")) return "ocg";
  if (f.includes("goat")) return "goat";
  return "tcg";
}

// Build a PreviewItem + the per-card lookups shared by preview/recompute. The
// `existingDisplay` lets recompute fall back to the row's saved name when the
// API can't resolve a passcode (e.g. brand-new card not yet in their DB).
async function buildItemRow(
  passcode: string,
  quantity: number,
  section: YdkSection,
  card: YgoCard | undefined,
  banlistFormat: BanlistFormat,
  existingDisplay?: { card_name?: string }
): Promise<PreviewItem> {
  const cardName = card?.name ?? existingDisplay?.card_name ?? `Unknown card #${passcode}`;
  // Cheapest printing (per YGOPRODeck's deck-pricer convention). Falls back
  // to the first printing if none have a usable set_price.
  const printing = card ? pickCheapestPrinting(card) : null;
  const setRef = printing?.set ?? card?.card_sets?.[0];

  const matched = card ? await matchInventory(passcode, card.name) : null;

  let unit_price_cents: number | null = null;
  let price_source: BundleItemPriceSource | null = null;
  if (matched) {
    unit_price_cents = matched.current_price ?? matched.market_price ?? null;
    price_source = unit_price_cents !== null ? "self" : null;
  }
  if (unit_price_cents === null && card) {
    // Aggregated TCGplayer market price tracks the cheapest live listing
    // across printings — closer to real buy-low than any single printing's
    // cached set_price. Cheapest printing's set_price is the fallback.
    unit_price_cents = pickUsPriceCents(card) ?? printing?.unit_price_cents ?? null;
    if (unit_price_cents !== null) price_source = "ygoprodeck";
  }

  return {
    passcode,
    card_name: cardName,
    quantity,
    section,
    product_id: matched?.id ?? null,
    in_stock: !!matched && (matched.quantity ?? 0) > 0,
    unit_price_cents,
    price_source,
    line_total_cents: (unit_price_cents ?? 0) * quantity,
    set_name: setRef?.set_name ?? null,
    set_number: setRef?.set_code ?? null,
    // image_url left null on import — user prefers their own product photos
    // (matched product images come from the products table at render time).
    image_url: null,
    is_staple: card ? isStaple(card) : false,
    archetype: card?.archetype ?? null,
    card_type: card?.type ?? null,
    banlist_status: card ? getBanlistStatus(card, banlistFormat) : null,
  };
}

function summarize(items: PreviewItem[], parsed: YdkParsed, missingPasscodes: string[]): PreviewSummary {
  const archetypeSet = new Set<string>();
  const banlistWarnings: BanlistWarning[] = [];
  let stapleCount = 0;
  for (const it of items) {
    if (it.archetype) archetypeSet.add(it.archetype);
    if (it.is_staple) stapleCount += 1;
    if (it.banlist_status) {
      banlistWarnings.push({
        passcode: it.passcode,
        card_name: it.card_name,
        status: it.banlist_status,
        quantity: it.quantity,
      });
    }
  }

  return {
    total_items: items.reduce((n, it) => n + it.quantity, 0),
    unique_cards: items.length,
    in_stock_items: items.filter((it) => it.in_stock).reduce((n, it) => n + it.quantity, 0),
    in_stock_total_cents: items
      .filter((it) => it.product_id !== null)
      .reduce((n, it) => n + it.line_total_cents, 0),
    missing_total_cents: items
      .filter((it) => it.product_id === null)
      .reduce((n, it) => n + it.line_total_cents, 0),
    staple_count: stapleCount,
    archetypes: [...archetypeSet].sort(),
    banlist_warnings: banlistWarnings,
    unresolved_passcodes: missingPasscodes,
    unknown_directives: parsed.unknownDirectives,
  };
}

export interface PreviewOptions {
  format?: string | null; // bundle format ("TCG"/"OCG"/"Goat") — selects banlist
}

export async function previewBundleFromYdk(
  ydkText: string,
  options: PreviewOptions = {}
): Promise<BundlePreview> {
  const parsed = parseDeck(ydkText);
  const passcodes = uniquePasscodes(parsed);
  const lookup = await lookupCardsByPasscode(passcodes);
  const banlistFormat = banlistFormatFor(options.format);

  const grouped = groupYdk(parsed);
  const items: PreviewItem[] = [];

  for (const section of ["main", "extra", "side"] as const) {
    for (const { passcode, quantity } of grouped[section]) {
      const card = lookup.cards.get(passcode);
      const item = await buildItemRow(passcode, quantity, section, card, banlistFormat);
      items.push(item);
    }
  }

  const summary = summarize(items, parsed, lookup.missingPasscodes);
  return { parsed, items, summary };
}

export interface CreateBundleResult {
  bundle_id: string;
  preview: BundlePreview;
}

export async function createBundleFromYdk(
  ydkText: string,
  options: CreateBundleOptions
): Promise<CreateBundleResult> {
  const preview = await previewBundleFromYdk(ydkText, { format: options.format });

  const bundleInsert: BundleInsert = {
    title: options.title,
    kind: options.kind ?? "deck",
    game: options.game ?? "yugioh",
    format: options.format ?? null,
    source: options.source ?? null,
    source_url: options.source_url ?? null,
    pilot: options.pilot ?? null,
    description: options.description ?? null,
    is_meta: options.is_meta ?? false,
    staple_count: preview.summary.staple_count,
    archetypes: preview.summary.archetypes,
    total_items: preview.summary.total_items,
    in_stock_items: preview.summary.in_stock_items,
    in_stock_total_cents: preview.summary.in_stock_total_cents,
    missing_total_cents: preview.summary.missing_total_cents,
    metadata: {
      ydk_unknown_directives: preview.summary.unknown_directives,
      ydk_unresolved_passcodes: preview.summary.unresolved_passcodes,
    },
  };

  const { data: bundle, error: bundleErr } = await supabase
    .from("bundles")
    .insert(bundleInsert)
    .select("id")
    .single();

  if (bundleErr || !bundle) {
    throw new Error(`Failed to insert bundle: ${bundleErr?.message ?? "unknown error"}`);
  }

  const bundleId: string = bundle.id;
  const now = new Date().toISOString();
  const itemsInsert: BundleItemInsert[] = preview.items.map((it, idx) => ({
    bundle_id: bundleId,
    product_id: it.product_id,
    konami_id: it.passcode,
    card_name: it.card_name,
    set_name: it.set_name,
    set_number: it.set_number,
    image_url: it.image_url,
    quantity: it.quantity,
    position: idx,
    section: it.section,
    unit_price_cents: it.unit_price_cents,
    price_source: it.price_source,
    price_updated_at: it.unit_price_cents !== null ? now : null,
    is_staple: it.is_staple,
    archetype: it.archetype,
    card_type: it.card_type,
    banlist_status: it.banlist_status,
  }));

  if (itemsInsert.length > 0) {
    const { error: itemsErr } = await supabase.from("bundle_items").insert(itemsInsert);
    if (itemsErr) {
      throw new Error(`Failed to insert bundle_items: ${itemsErr.message}`);
    }
  }

  return { bundle_id: bundleId, preview };
}

// ---------------------------------------------------------------------------
// Recompute: re-run YGOPRODeck lookup + inventory match + price pick on an
// existing bundle. Updates each bundle_item in place and rewrites the
// denormalized aggregates on the bundles row. Returns updated summary.
// is_meta is preserved (it's a human-curated flag, not derived).
// ---------------------------------------------------------------------------

export interface RecomputeResult {
  bundle_id: string;
  summary: PreviewSummary;
}

interface ExistingItemRow {
  id: string;
  konami_id: string | null;
  card_name: string;
  quantity: number;
  section: string | null;
  position: number | null;
}

interface BundleHeaderRow {
  format: string | null;
}

export async function recomputeBundle(bundleId: string): Promise<RecomputeResult> {
  const { data: bundleRow, error: hdrErr } = await supabase
    .from("bundles")
    .select("format")
    .eq("id", bundleId)
    .single();
  if (hdrErr || !bundleRow) {
    throw new Error(`Failed to read bundle: ${hdrErr?.message ?? "not found"}`);
  }
  const banlistFormat = banlistFormatFor((bundleRow as BundleHeaderRow).format);

  const { data: existing, error: itemsErr } = await supabase
    .from("bundle_items")
    .select("id, konami_id, card_name, quantity, section, position")
    .eq("bundle_id", bundleId)
    .order("position", { ascending: true });

  if (itemsErr) {
    throw new Error(`Failed to read bundle_items: ${itemsErr.message}`);
  }

  const items = (existing ?? []) as ExistingItemRow[];
  const passcodes = [...new Set(items.map((it) => it.konami_id).filter((p): p is string => !!p))];
  const lookup = passcodes.length > 0
    ? await lookupCardsByPasscode(passcodes)
    : { cards: new Map<string, YgoCard>(), missingPasscodes: [] as string[] };

  const previewItems: PreviewItem[] = [];
  const now = new Date().toISOString();

  for (const it of items) {
    const card = it.konami_id ? lookup.cards.get(it.konami_id) : undefined;
    const sectionStr = (it.section as YdkSection) ?? "main";
    const built = await buildItemRow(
      it.konami_id ?? "",
      it.quantity,
      sectionStr,
      card,
      banlistFormat,
      { card_name: it.card_name }
    );
    previewItems.push(built);

    const update: Partial<BundleItemInsert> = {
      product_id: built.product_id,
      card_name: built.card_name,
      set_name: built.set_name,
      set_number: built.set_number,
      // Don't clobber a user-snapped image; recompute leaves image_url alone.
      unit_price_cents: built.unit_price_cents,
      price_source: built.price_source,
      price_updated_at: built.unit_price_cents !== null ? now : null,
      is_staple: built.is_staple,
      archetype: built.archetype,
      card_type: built.card_type,
      banlist_status: built.banlist_status,
    };

    const { error: updErr } = await supabase
      .from("bundle_items")
      .update(update)
      .eq("id", it.id);
    if (updErr) {
      throw new Error(`Failed to update bundle_item ${it.id}: ${updErr.message}`);
    }
  }

  // Use the same summarizer the preview path uses, with an empty parsed shell
  // since we don't reparse a .ydk on recompute.
  const summary = summarize(
    previewItems,
    { main: [], extra: [], side: [], unknownDirectives: [] },
    lookup.missingPasscodes
  );

  const { error: bundleErr } = await supabase
    .from("bundles")
    .update({
      total_items: summary.total_items,
      in_stock_items: summary.in_stock_items,
      in_stock_total_cents: summary.in_stock_total_cents,
      missing_total_cents: summary.missing_total_cents,
      staple_count: summary.staple_count,
      archetypes: summary.archetypes,
    })
    .eq("id", bundleId);
  if (bundleErr) {
    throw new Error(`Failed to update bundle aggregates: ${bundleErr.message}`);
  }

  return { bundle_id: bundleId, summary };
}

// ---------------------------------------------------------------------------
// Matching: passcode -> product
// ---------------------------------------------------------------------------

interface MatchedProduct {
  id: string;
  current_price: number | null;
  market_price: number | null;
  quantity: number | null;
}

async function matchInventory(passcode: string, cardName: string): Promise<MatchedProduct | null> {
  // 1) Exact konami_id match in metadata (preferred — set when we scan YGO cards).
  const exact = await supabase
    .from("products")
    .select("id, current_price, market_price, quantity")
    .eq("metadata->>konami_id", passcode)
    .limit(1)
    .maybeSingle();

  if (exact.data) {
    return {
      id: exact.data.id as string,
      current_price: exact.data.current_price as number | null,
      market_price: exact.data.market_price as number | null,
      quantity: exact.data.quantity as number | null,
    };
  }

  // 2) Fuzzy name match via the search_products_fuzzy RPC (pg_trgm).
  const fuzzy = await supabase.rpc("search_products_fuzzy", {
    search_query: cardName,
    similarity_threshold: FUZZY_THRESHOLD,
    max_results: 1,
  });

  if (fuzzy.error || !fuzzy.data || fuzzy.data.length === 0) return null;

  const row = fuzzy.data[0] as {
    id: string;
    current_price: number | null;
    market_price: number | null;
    quantity: number | null;
  };
  return {
    id: row.id,
    current_price: row.current_price,
    market_price: row.market_price,
    quantity: row.quantity,
  };
}
