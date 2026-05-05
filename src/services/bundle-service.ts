// Compose a Bundle (deck/bundle/lot) from a parsed input source. Today only
// .ydk is supported; future ingestion paths (paste-list, scryfall import) will
// land here too. The preview function is pure-read and the create function
// persists rows; both share the same matching pipeline.

import { supabase } from "../lib/supabase";
import { parseDeck, groupYdk, uniquePasscodes } from "./ydk-parser";
import type { YdkParsed, YdkSection } from "./ydk-parser";
import { lookupCardsByPasscode, pickCheapestPrinting, pickUsPriceCents } from "./ygoprodeck";
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
}

export interface PreviewSummary {
  total_items: number;          // sum of quantities
  unique_cards: number;         // distinct passcodes
  in_stock_items: number;       // sum of qty for in-stock cards
  in_stock_total_cents: number;
  missing_total_cents: number;
  unresolved_passcodes: string[]; // not found in YGOPRODeck
  unknown_directives: string[];   // surfaced from parser
}

export interface BundlePreview {
  parsed: YdkParsed;
  items: PreviewItem[];
  summary: PreviewSummary;
}

// Fuzzy similarity threshold for card-name -> products.title matching.
// 0.4 tolerates minor punctuation/article differences while rejecting unrelated cards.
const FUZZY_THRESHOLD = 0.4;

export async function previewBundleFromYdk(ydkText: string): Promise<BundlePreview> {
  const parsed = parseDeck(ydkText);
  const passcodes = uniquePasscodes(parsed);
  const lookup = await lookupCardsByPasscode(passcodes);

  const grouped = groupYdk(parsed);
  const items: PreviewItem[] = [];

  for (const section of ["main", "extra", "side"] as const) {
    for (const { passcode, quantity } of grouped[section]) {
      const card = lookup.cards.get(passcode);
      const cardName = card?.name ?? `Unknown card #${passcode}`;
      // Cheapest printing (per YGOPRODeck's deck-pricer convention). Falls back
      // to the first printing if none have a usable set_price.
      const printing = card ? pickCheapestPrinting(card) : null;
      const setRef = printing?.set ?? card?.card_sets?.[0];
      const imageUrl = card?.card_images?.[0]?.image_url ?? null;

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

      items.push({
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
        image_url: imageUrl,
      });
    }
  }

  const summary: PreviewSummary = {
    total_items: items.reduce((n, it) => n + it.quantity, 0),
    unique_cards: items.length,
    in_stock_items: items.filter((it) => it.in_stock).reduce((n, it) => n + it.quantity, 0),
    in_stock_total_cents: items
      .filter((it) => it.product_id !== null)
      .reduce((n, it) => n + it.line_total_cents, 0),
    missing_total_cents: items
      .filter((it) => it.product_id === null)
      .reduce((n, it) => n + it.line_total_cents, 0),
    unresolved_passcodes: lookup.missingPasscodes,
    unknown_directives: parsed.unknownDirectives,
  };

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
  const preview = await previewBundleFromYdk(ydkText);

  const bundleInsert: BundleInsert = {
    title: options.title,
    kind: options.kind ?? "deck",
    game: options.game ?? "yugioh",
    format: options.format ?? null,
    source: options.source ?? null,
    source_url: options.source_url ?? null,
    pilot: options.pilot ?? null,
    description: options.description ?? null,
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

export async function recomputeBundle(bundleId: string): Promise<RecomputeResult> {
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
    : { cards: new Map(), missingPasscodes: [] as string[] };

  let totalItems = 0;
  let inStockItems = 0;
  let inStockTotal = 0;
  let missingTotal = 0;
  const now = new Date().toISOString();

  for (const it of items) {
    const card = it.konami_id ? lookup.cards.get(it.konami_id) : undefined;
    const printing = card ? pickCheapestPrinting(card) : null;
    const setRef = printing?.set ?? card?.card_sets?.[0];
    const matched = card ? await matchInventory(it.konami_id ?? "", card.name) : null;

    let unit_price_cents: number | null = null;
    let price_source: BundleItemPriceSource | null = null;
    if (matched) {
      unit_price_cents = matched.current_price ?? matched.market_price ?? null;
      price_source = unit_price_cents !== null ? "self" : null;
    }
    if (unit_price_cents === null && card) {
      unit_price_cents = pickUsPriceCents(card) ?? printing?.unit_price_cents ?? null;
      if (unit_price_cents !== null) price_source = "ygoprodeck";
    }

    totalItems += it.quantity;
    const inStock = !!matched && (matched.quantity ?? 0) > 0;
    if (inStock) inStockItems += it.quantity;
    const lineTotal = (unit_price_cents ?? 0) * it.quantity;
    if (matched?.id) inStockTotal += lineTotal;
    else missingTotal += lineTotal;

    const update: Partial<BundleItemInsert> = {
      product_id: matched?.id ?? null,
      card_name: card?.name ?? it.card_name,
      set_name: setRef?.set_name ?? null,
      set_number: setRef?.set_code ?? null,
      image_url: card?.card_images?.[0]?.image_url ?? null,
      unit_price_cents,
      price_source,
      price_updated_at: unit_price_cents !== null ? now : null,
    };

    const { error: updErr } = await supabase
      .from("bundle_items")
      .update(update)
      .eq("id", it.id);
    if (updErr) {
      throw new Error(`Failed to update bundle_item ${it.id}: ${updErr.message}`);
    }
  }

  const summary: PreviewSummary = {
    total_items: totalItems,
    unique_cards: items.length,
    in_stock_items: inStockItems,
    in_stock_total_cents: inStockTotal,
    missing_total_cents: missingTotal,
    unresolved_passcodes: lookup.missingPasscodes,
    unknown_directives: [],
  };

  const { error: bundleErr } = await supabase
    .from("bundles")
    .update({
      total_items: totalItems,
      in_stock_items: inStockItems,
      in_stock_total_cents: inStockTotal,
      missing_total_cents: missingTotal,
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
