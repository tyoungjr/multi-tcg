# Collectibles Inventory System

A unified inventory + listing pipeline for collectibles (trading cards, games, consoles, toys, comics, coins, etc.). Snap a photo on your phone, get it identified, priced, and listed on Shopify in seconds.

## What it does

- **Snap & Sell (PWA)** — Phone-based camera UI. Take a photo, get an AI identification + PriceCharting match + suggested price, review, and push to Shopify.
- **Batch mode** — Snap many items in rapid succession. Identifications run in the background. Review and bulk-save/list when ready.
- **Inventory browser** — Scroll your DB, attach/replace photos on existing items, edit price/condition/grading/notes, delete.
- **CSV import** — Seed the DB from a PriceCharting CSV export.
- **Shopify sync** — Push products to Shopify with images. Pulls orders (marks sold), archives stale listings (for deleted DB items), and only pushes rows that actually changed since last sync.
- **Pricing pipeline** — PriceCharting first, falls back to eBay sold listings and Google Lens only when PC misses.

## Architecture

```
┌─────────────┐      ┌─────────────────┐      ┌──────────────┐
│   Phone     │─────▶│   snap-server   │─────▶│   Supabase   │
│  (browser)  │      │ (localhost:3457)│      │  (products,  │
└─────────────┘      └────────┬────────┘      │  images, etc)│
                              │                └──────┬───────┘
                              │                       │
                ┌─────────────┼─────────────┐         │
                ▼             ▼             ▼         ▼
         ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌─────────┐
         │  Claude   │ │  Price-   │ │   eBay /  │ │ Shopify │
         │  Vision   │ │  Charting │ │   Lens    │ │  Admin  │
         └───────────┘ └───────────┘ └───────────┘ └─────────┘
```

Supabase is the single source of truth. PriceCharting is the primary pricing oracle. Shopify is a downstream destination.

## Setup

### 1. Prerequisites

- Node.js 20+ with npm
- A Supabase project (free tier paused after a week of inactivity — upgrade to Basic if you want always-on)
- API keys for the services you want to use (see `.env.example`)

### 2. Install

```bash
git clone <repo>
cd shopify-integration
npm install
cp .env.example .env
# fill in .env with your keys
```

### 3. Database

Apply the migrations to your Supabase project:

```bash
npx supabase db push
```

Migrations are in `supabase/migrations/`. They create the `products`, `product_images`, `price_history` tables, enums, indexes, RLS policies, fuzzy-search, and the `shopify_synced_at` column.

Also create a Supabase Storage bucket named **`product-images`** and set it to **public** (Shopify needs to be able to fetch the image URLs).

### 4. Shopify OAuth

Your Shopify app needs these scopes:

```
write_inventory,read_inventory,read_product_listings,
write_product_listings,read_products,write_products,read_orders
```

Add `http://localhost:3456/callback` as an allowed redirect URL in the app's distribution settings and release a new app version.

Then run:

```bash
npm run shopify:auth
```

This opens a browser, does the OAuth dance, catches the callback, and writes `SHOPIFY_ACCESS_TOKEN` back to `.env`.

## Daily usage

### Start the server

```bash
npm run snap
```

Then open the printed phone URL (e.g. `http://192.168.x.x:3457`) on your phone.

Three pages:
- `/` — single-item snap & sell (synchronous)
- `/batch` — rapid-fire batch mode (async queue)
- `/inventory` — browse/edit/delete existing items, attach photos

### Push to Shopify

```bash
npm run shopify:push              # smart sync: orders + cleanup + push-changed-only
npm run shopify:push -- --dry-run # preview
npm run shopify:push -- --force   # push everything, even unchanged
npm run shopify:push -- --no-sync # skip order pull + cleanup
npm run shopify:push -- --id <uuid>           # single product
npm run shopify:push -- --category trading_card
```

A plain `shopify:push` does three steps:
1. **Sync orders** — pulls Shopify orders, marks sold items in Supabase
2. **Cleanup** — archives any Shopify listing that was deleted from (or marked sold in) Supabase
3. **Push** — creates new products, updates changed products, skips unchanged

A product counts as "changed" when `products.updated_at > products.shopify_synced_at`. Any edit via the inventory modal bumps `updated_at` automatically.

### Other commands

```bash
npm run shopify:orders            # just pull orders (no push)
npm run pc:search -- <query>      # PriceCharting search CLI
npm run csv:import -- <file.csv>  # bulk-import a PriceCharting CSV export
npm run collection:import         # pull your PriceCharting collection via API
npm run identify -- <image.jpg>   # single-file identify CLI
npm run identify:watch            # watch a folder (OneDrive inbox) for new photos
```

## Data model

### Products

Core table. Fields worth knowing:

| Field | Purpose |
|---|---|
| `category` | `trading_card`, `video_game`, `console_hardware`, `accessory`, `arcade`, `coin`, `comic`, `toy`, `apparel`, `electronics`, `promotional`, `misc` |
| `condition` | `loose`, `good`, `very_good`, `cib`, `new_sealed`, `graded` |
| `inventory_status` | `in_stock`, `listed_shopify`, `listed_ebay`, `listed_multi`, `sold`, `personal_collection` |
| `current_price` / `market_price` | In cents |
| `pricecharting_id` | Optional PC product id |
| `shopify_product_id` | Set after first push |
| `shopify_synced_at` | Stamped after each successful push; used to skip unchanged rows |
| `metadata` | JSONB — category-specific fields (see below) |
| `quantity` | Defaults to 1 |
| `graded_score` / `grading_company` | For graded items (PSA 10, BGS 9.5, etc.) |
| `purchase_notes` | Free-text notes |

### `personal_collection`

Items you own but aren't selling. They stay in the DB (for valuation, dupe-checking, insurance) but `shopify:push` ignores them.

### Metadata (per-category JSONB)

See `src/types/metadata.ts`. All categories inherit a shared `ListingMetadata` base:

| Field | Use case |
|---|---|
| `variant` | Art/flavor/color variant (e.g. "Charizard art booster pack") |
| `product_type` | `single`, `booster_pack`, `booster_box`, `etb`, `blister`, `tin`, `bundle` |
| `pack_art` | Specific art for booster pack variants |
| `bundle` / `bundle_items` / `bundle_label` | For bundle listings |
| `promo_label` / `promo_price_cents` / `compare_at_cents` | For sales / strikethrough pricing |

Category-specific fields: `trading_card` has `game`, `set`, `rarity`, `card_number`, `foil`, grading fields, etc. See the types file.

These flow into Shopify as tags automatically.

## File layout

```
src/
  lib/
    supabase.ts           Supabase client
    shopify.ts            Shopify REST helpers (GET/POST/PUT/DELETE)
    pricecharting.ts      PriceCharting API client
    image-utils.ts        sharp wrappers
  services/
    visual-search.ts      Orchestrator: Claude Vision → PC → fallbacks
    item-identifier.ts    Claude Vision identification
    ebay-pricing.ts       eBay Browse API (sold listings)
    google-lens-pricing.ts SerpAPI / direct Lens scrape
    shopify-sync.ts       Push products, sync orders, cleanup stale listings
  scripts/
    snap-server.ts        The web server (camera/batch/inventory pages + all REST routes)
    shopify-auth.ts       OAuth flow
    shopify-push.ts       Full sync: orders → cleanup → push
    shopify-orders.ts     Just pull orders
    identify.ts           Single-file identify CLI
    identify-watch.ts     Folder-watching CLI (OneDrive inbox)
    import-csv.ts         Import PriceCharting CSV export
    import-collection.ts  Import PC collection via API
    search-pricecharting.ts PC search CLI
    update-prices.ts      Refresh prices on existing products
  types/                  TypeScript interfaces
supabase/
  migrations/             DB schema
  seed.sql                Sample data
```

## Running on a Mac mini (headless)

Plan for when you want this to run 24/7:

### 1. Clone + set up on the mini

```bash
git clone <repo>
cd shopify-integration
npm install
cp .env.example .env   # fill in, copy tokens from your dev box
```

### 2. Run as a launchd service

Create `~/Library/LaunchAgents/com.collectibles.snap.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.collectibles.snap</string>
    <key>WorkingDirectory</key>
    <string>/Users/YOU/shopify-integration</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/local/bin/npm</string>
      <string>run</string>
      <string>snap</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/YOU/shopify-integration/snap.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/YOU/shopify-integration/snap.err.log</string>
  </dict>
</plist>
```

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.collectibles.snap.plist
```

### 3. Reserve the Mac mini's LAN IP (router DHCP reservation) so the phone URL is stable.

### 4. For remote access:

- Tailscale (easiest) — add the mini + your phone to a tailnet, access `http://<mini-tailscale-ip>:3457` from anywhere
- Cloudflare Tunnel — if you want a public URL without opening ports
- Port forward 3457 — works but exposes the server

### 5. Schedule shopify:push

Add a cron-style launchd agent that runs `npm run shopify:push` once or twice a day, so orders get synced and new items flow to Shopify automatically.

## Troubleshooting

- **"Bucket not found" when saving** — Create the `product-images` bucket in Supabase Storage and make it public.
- **Shopify images show 403** — Bucket is private. Toggle it to public.
- **OAuth redirect mismatch** — Shopify app version needs releasing after adding the redirect URL.
- **eBay needs verification token** — Toggle "Exempted from Marketplace Account Deletion" in your eBay dev account.
- **Supabase project paused** — Free tier pauses after a week of inactivity. Upgrade to Basic ($25/mo) for always-on.
- **PC rate-limited** — PriceCharting client already throttles to 1.1s between calls. Lower the concurrency if you see 429s.

## Philosophy

- Supabase is the single source of truth
- Shopify is a downstream mirror
- PriceCharting is the pricing oracle; eBay + Lens only fill gaps
- Nothing auto-publishes without review (snap page, batch page, or CLI prompt)
