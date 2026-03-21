// ---------------------------------------------------------------------------
// Google Lens - Visual price search
// ---------------------------------------------------------------------------
//
// Two modes:
// 1. SerpAPI (reliable, structured JSON) - needs SERPAPI_KEY, free tier = 100/month
// 2. Direct Google Lens scrape (no key needed, less reliable)
//
// For local files, we need a public URL - upload to Supabase Storage first.
// ---------------------------------------------------------------------------

export interface LensPriceResult {
  title: string;
  price_cents: number;
  source: string;
  url: string;
  currency: string;
}

export interface GoogleLensEstimate {
  query_description: string;
  results: LensPriceResult[];
  average_price_cents: number;
  median_price_cents: number;
  low_price_cents: number;
  high_price_cents: number;
  sample_size: number;
}

// ---------------------------------------------------------------------------
// SerpAPI approach (preferred)
// ---------------------------------------------------------------------------

interface SerpApiVisualMatch {
  title?: string;
  link?: string;
  source?: string;
  price?: {
    value?: string;
    extracted_value?: number;
    currency?: string;
  };
}

interface SerpApiLensResponse {
  visual_matches?: SerpApiVisualMatch[];
  knowledge_graph?: Array<{
    title?: string;
    images?: Array<{ link?: string }>;
  }>;
  error?: string;
}

async function searchViaSerpApi(
  imageUrl: string
): Promise<GoogleLensEstimate> {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    throw new Error("SERPAPI_KEY not configured");
  }

  const params = new URLSearchParams({
    engine: "google_lens",
    url: imageUrl,
    api_key: apiKey,
  });

  const response = await fetch(`https://serpapi.com/search?${params}`);

  if (!response.ok) {
    throw new Error(`SerpAPI error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as SerpApiLensResponse;

  if (data.error) {
    throw new Error(`SerpAPI error: ${data.error}`);
  }

  const matches = data.visual_matches ?? [];
  const priced = matches.filter((m) => m.price?.extracted_value);

  const results: LensPriceResult[] = priced.map((m) => ({
    title: m.title ?? "Unknown",
    price_cents: Math.round((m.price!.extracted_value ?? 0) * 100),
    source: m.source ?? "",
    url: m.link ?? "",
    currency: m.price?.currency ?? "USD",
  }));

  return buildEstimate(`Google Lens (SerpAPI)`, results);
}

// ---------------------------------------------------------------------------
// Direct scrape approach (no API key)
// ---------------------------------------------------------------------------

function parsePricesFromHtml(html: string): LensPriceResult[] {
  const results: LensPriceResult[] = [];

  // Google Lens results embed price data in various formats.
  // Look for common price patterns near product titles.
  //
  // Pattern 1: "$XX.XX" in the HTML near product links
  // Pattern 2: data attributes with price values
  // Pattern 3: structured data / JSON-LD with offers

  // Extract JSON-LD structured data (most reliable when present)
  const jsonLdMatches = html.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi
  );
  if (jsonLdMatches) {
    for (const match of jsonLdMatches) {
      try {
        const jsonStr = match
          .replace(/<script type="application\/ld\+json">/i, "")
          .replace(/<\/script>/i, "");
        const data = JSON.parse(jsonStr);
        const offers = Array.isArray(data) ? data : [data];
        for (const item of offers) {
          if (item.offers?.price || item.price) {
            const price = parseFloat(item.offers?.price ?? item.price);
            if (!isNaN(price) && price > 0) {
              results.push({
                title: item.name ?? "Unknown",
                price_cents: Math.round(price * 100),
                source: "structured_data",
                url: item.url ?? "",
                currency: item.offers?.priceCurrency ?? "USD",
              });
            }
          }
        }
      } catch {
        // JSON parse failed, skip
      }
    }
  }

  // Extract inline price patterns: "$12.34" near identifiable content
  const pricePattern =
    /\$(\d{1,6}(?:\.\d{2})?)\s*(?:<[^>]*>)*\s*(?:<[^>]*>)*([^<]{3,80})/g;
  let priceMatch;
  while ((priceMatch = pricePattern.exec(html)) !== null) {
    const price = parseFloat(priceMatch[1]);
    const nearbyText = priceMatch[2].trim();
    if (price > 0 && price < 100000 && nearbyText.length > 3) {
      results.push({
        title: nearbyText.slice(0, 80),
        price_cents: Math.round(price * 100),
        source: "google_lens_scrape",
        url: "",
        currency: "USD",
      });
    }
  }

  // Also try reverse: "title ... $12.34"
  const reversePricePattern =
    /([^<>]{3,80})\s*\$(\d{1,6}(?:\.\d{2})?)/g;
  while ((priceMatch = reversePricePattern.exec(html)) !== null) {
    const nearbyText = priceMatch[1].trim();
    const price = parseFloat(priceMatch[2]);
    if (price > 0 && price < 100000 && nearbyText.length > 3) {
      // Avoid duplicates
      const exists = results.some(
        (r) => Math.abs(r.price_cents - Math.round(price * 100)) < 2
      );
      if (!exists) {
        results.push({
          title: nearbyText.slice(0, 80),
          price_cents: Math.round(price * 100),
          source: "google_lens_scrape",
          url: "",
          currency: "USD",
        });
      }
    }
  }

  return results;
}

async function searchViaScrape(
  imageUrl: string
): Promise<GoogleLensEstimate> {
  const lensUrl = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(imageUrl)}`;

  const response = await fetch(lensUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Google Lens fetch failed: ${response.status}`);
  }

  const html = await response.text();
  const results = parsePricesFromHtml(html);

  return buildEstimate("Google Lens (scrape)", results);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildEstimate(
  queryDesc: string,
  results: LensPriceResult[]
): GoogleLensEstimate {
  if (results.length === 0) {
    return {
      query_description: queryDesc,
      results: [],
      average_price_cents: 0,
      median_price_cents: 0,
      low_price_cents: 0,
      high_price_cents: 0,
      sample_size: 0,
    };
  }

  const prices = results.map((r) => r.price_cents).sort((a, b) => a - b);
  const sum = prices.reduce((acc, p) => acc + p, 0);
  const mid = Math.floor(prices.length / 2);
  const median =
    prices.length % 2 === 0
      ? Math.round((prices[mid - 1] + prices[mid]) / 2)
      : prices[mid];

  return {
    query_description: queryDesc,
    results,
    average_price_cents: Math.round(sum / prices.length),
    median_price_cents: median,
    low_price_cents: prices[0],
    high_price_cents: prices[prices.length - 1],
    sample_size: prices.length,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getGoogleLensPrices(
  imageUrl: string
): Promise<GoogleLensEstimate> {
  // Try SerpAPI first (reliable), fall back to direct scrape
  if (process.env.SERPAPI_KEY) {
    try {
      return await searchViaSerpApi(imageUrl);
    } catch (err) {
      console.warn(
        `  SerpAPI failed, trying direct scrape: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  return searchViaScrape(imageUrl);
}

export function hasGoogleLensCapability(): boolean {
  // Scrape works without any key, SerpAPI is a bonus
  return true;
}
