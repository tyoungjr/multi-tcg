// YGOPRODeck card-info wrapper. Free API, no auth required.
// Docs: https://ygoprodeck.com/api-guide/
// Endpoint: https://db.ygoprodeck.com/api/v7/cardinfo.php
//
// Behavior with unknown passcodes:
// - If ALL requested IDs are invalid, the API returns { error: "..." } (HTTP 400).
// - If SOME are valid, it returns just the valid cards in `data[]`.
// We compare requested vs returned to surface missing passcodes to the caller.
//
// We always request &misc=yes so each card's `misc_info[]` is populated with
// staple status, format list, MD rarity, etc. The extra payload is small.
//
// Rate limits (per https://ygoprodeck.com/api-guide/):
//   20 req/sec — exceed and the IP is blacklisted for 1 hour. We cap at 18/sec
//   on a rolling window and back off on 429/503.

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

// Populated when &misc=yes is passed. Fields are sparsely populated by the API,
// so most are optional.
export interface YgoCardMiscInfo {
  beta_name?: string;
  views?: number;
  viewsweek?: number;
  upvotes?: number;
  downvotes?: number;
  formats?: string[];
  tcg_date?: string;
  ocg_date?: string;
  konami_id?: number;
  has_effect?: number;
  md_rarity?: string; // Master Duel rarity, useful for MD3 imports
  staple?: string;    // typically "Yes" when present, omitted otherwise
  treated_as?: string;
}

export interface YgoBanlistInfo {
  ban_tcg?: string;
  ban_ocg?: string;
  ban_goat?: string;
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
  misc_info?: YgoCardMiscInfo[];
  banlist_info?: YgoBanlistInfo;
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
  const url = `${BASE_URL}?id=${passcodes.join(",")}&misc=yes`;
  const resp = await fetchWithBackoff(url);

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

// ---------------------------------------------------------------------------
// Rate limiting + retry. YGOPRODeck blacklists IPs for 1 hour at >20 req/sec
// so we cap at 18/sec on a rolling-window token bucket. On 429 (rate limit) or
// 503 (transient) we honor Retry-After when present, else exponential backoff
// with jitter. Module-level state — shared by every caller in the process.
// ---------------------------------------------------------------------------

const RATE_LIMIT_PER_SEC = 18;
const RATE_WINDOW_MS = 1000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;
const requestTimestamps: number[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireSlot(): Promise<void> {
  // Drop timestamps that have aged out of the window, then either grab a slot
  // or sleep until the oldest one expires.
  while (true) {
    const now = Date.now();
    while (requestTimestamps.length > 0 && requestTimestamps[0] < now - RATE_WINDOW_MS) {
      requestTimestamps.shift();
    }
    if (requestTimestamps.length < RATE_LIMIT_PER_SEC) {
      requestTimestamps.push(now);
      return;
    }
    const waitMs = requestTimestamps[0] + RATE_WINDOW_MS - now + 5;
    await sleep(Math.max(waitMs, 10));
  }
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = parseInt(value, 10);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return null;
}

async function fetchWithBackoff(url: string): Promise<Response> {
  let lastResponse: Response | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await acquireSlot();
    const resp = await fetch(url);
    if (resp.status !== 429 && resp.status !== 503) return resp;
    lastResponse = resp;
    if (attempt === MAX_RETRIES) return resp;
    const retryAfter = parseRetryAfterMs(resp.headers.get("retry-after"));
    const backoff = retryAfter ?? BASE_BACKOFF_MS * Math.pow(2, attempt);
    const jitter = Math.random() * 200;
    await sleep(backoff + jitter);
  }
  // Unreachable: loop returns or exhausts. Satisfies the type checker.
  return lastResponse ?? new Response(null, { status: 599 });
}

// ---------------------------------------------------------------------------
// Convenience extractors
// ---------------------------------------------------------------------------

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

// True when YGOPRODeck has flagged this card as a deckbuilding staple.
// The misc_info `staple` field is "Yes" when present and omitted otherwise.
export function isStaple(card: YgoCard): boolean {
  const misc = card.misc_info?.[0];
  return misc?.staple?.toLowerCase() === "yes";
}

export type BanlistFormat = "tcg" | "ocg" | "goat";

// Returns the card's banlist status for the given format ("Banned"/"Limited"/
// "Semi-Limited"), or null when unrestricted.
export function getBanlistStatus(
  card: YgoCard,
  format: BanlistFormat = "tcg"
): string | null {
  const info = card.banlist_info;
  if (!info) return null;
  const key = format === "tcg" ? "ban_tcg" : format === "ocg" ? "ban_ocg" : "ban_goat";
  return info[key] ?? null;
}
