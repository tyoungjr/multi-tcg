// YGOPRODeck card-info wrapper. Free API, no auth required.
// Docs: https://ygoprodeck.com/api-guide/
// Endpoint: https://db.ygoprodeck.com/api/v7/cardinfo.php
//
// Behavior with unknown passcodes:
// - If ALL requested IDs are invalid, the API returns { error: "..." } (HTTP 400).
// - If SOME are valid, it returns just the valid cards in `data[]`.
// We compare requested vs returned to surface missing passcodes to the caller.

const BASE_URL = "https://db.ygoprodeck.com/api/v7/cardinfo.php";
// API allows up to ~250 IDs per call before URL gets unwieldy. We chunk at 200
// to stay safely under typical proxy URL limits.
const BATCH_SIZE = 200;

export interface YgoCardSet {
  set_name: string;
  set_code: string;
  set_rarity: string;
  set_rarity_code?: string;
  set_price: string; // dollar string
}

export interface YgoCardPrice {
  cardmarket_price: string;
  tcgplayer_price: string;
  ebay_price: string;
  amazon_price: string;
  coolstuffinc_price: string;
}

export interface YgoCardImage {
  id: number;
  image_url: string;
  image_url_small: string;
  image_url_cropped: string;
}

export interface YgoCard {
  id: number;
  name: string;
  type: string;
  frameType?: string;
  desc: string;
  race?: string;
  archetype?: string;
  attribute?: string;
  atk?: number;
  def?: number;
  level?: number;
  card_sets?: YgoCardSet[];
  card_images?: YgoCardImage[];
  card_prices?: YgoCardPrice[];
}

interface YgoApiResponse {
  data?: YgoCard[];
  error?: string;
}

export interface YgoLookupResult {
  // Map of passcode -> card. Use string keys for consistency with .ydk passcode strings.
  cards: Map<string, YgoCard>;
  missingPasscodes: string[];
}

// Fetch card info for a list of passcodes. Returns a map keyed by passcode
// (as string) plus a list of passcodes the API didn't recognize.
export async function lookupCardsByPasscode(
  passcodes: string[]
): Promise<YgoLookupResult> {
  const unique = [...new Set(passcodes)];
  const cards = new Map<string, YgoCard>();

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const chunk = unique.slice(i, i + BATCH_SIZE);
    const batch = await fetchBatch(chunk);
    for (const card of batch) {
      cards.set(String(card.id), card);
    }
  }

  const missingPasscodes = unique.filter((p) => !cards.has(p));
  return { cards, missingPasscodes };
}

async function fetchBatch(passcodes: string[]): Promise<YgoCard[]> {
  if (passcodes.length === 0) return [];
  const url = `${BASE_URL}?id=${passcodes.join(",")}`;
  const resp = await fetch(url);

  // 400 with `{ error }` typically means none of the IDs matched. Treat as empty.
  if (resp.status === 400) {
    const body = (await resp.json().catch(() => ({}))) as YgoApiResponse;
    if (body.error) return [];
    throw new Error(`YGOPRODeck error 400: ${JSON.stringify(body)}`);
  }
  if (!resp.ok) {
    throw new Error(`YGOPRODeck error: ${resp.status} ${resp.statusText}`);
  }

  const body = (await resp.json()) as YgoApiResponse;
  return body.data ?? [];
}

// Convert a YGOPRODeck price string ("12.50") to cents. Returns null when missing
// or when the API returns "0" / "0.00" (it does this for cards with no prices).
export function priceStringToCents(s: string | undefined): number | null {
  if (!s) return null;
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

// Pick the most representative US-market price for a card. TCGplayer first,
// then eBay, then Amazon. (cardmarket is EUR — skipped.)
export function pickUsPriceCents(card: YgoCard): number | null {
  const p = card.card_prices?.[0];
  if (!p) return null;
  return (
    priceStringToCents(p.tcgplayer_price) ??
    priceStringToCents(p.ebay_price) ??
    priceStringToCents(p.amazon_price)
  );
}

export interface ChosenPrinting {
  set: YgoCardSet;
  unit_price_cents: number;
}

// Pick the cheapest printing of this card that has a usable price. Mirrors
// YGOPRODeck's deck-pricer behavior — gives a realistic "shop around" total
// rather than overcharging for the most expensive variant.
export function pickCheapestPrinting(card: YgoCard): ChosenPrinting | null {
  if (!card.card_sets || card.card_sets.length === 0) return null;
  let best: ChosenPrinting | null = null;
  for (const set of card.card_sets) {
    const cents = priceStringToCents(set.set_price);
    if (cents === null) continue;
    if (best === null || cents < best.unit_price_cents) {
      best = { set, unit_price_cents: cents };
    }
  }
  return best;
}
