import type {
  EbaySoldListing,
  EbayPriceEstimate,
} from "../types/visual-search";

// ---------------------------------------------------------------------------
// eBay Browse API - Sold/Completed Listings
// ---------------------------------------------------------------------------
//
// Uses eBay Browse API (v1) which requires an OAuth app token.
// For sold listings we use the search endpoint with filter=buyingOptions:{FIXED_PRICE|AUCTION}
// and the itemEndDate filter to get recently completed items.
//
// Alternatively, eBay Finding API (legacy) has findCompletedItems.
// We support both - Browse API preferred, Finding API as fallback.
// ---------------------------------------------------------------------------

function getCredentials(): { appId: string; certId: string } {
  const appId = process.env.EBAY_APP_ID;
  const certId = process.env.EBAY_CERT_ID;
  if (!appId || !certId) {
    throw new Error(
      "Missing EBAY_APP_ID or EBAY_CERT_ID in environment. " +
        "Register at developer.ebay.com and add credentials to .env"
    );
  }
  return { appId, certId };
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAppToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }

  const { appId, certId } = getCredentials();
  const credentials = Buffer.from(`${appId}:${certId}`).toString("base64");

  const response = await fetch(
    "https://api.ebay.com/identity/v1/oauth2/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${credentials}`,
      },
      body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
    }
  );

  if (!response.ok) {
    throw new Error(`eBay OAuth failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };

  cachedToken = {
    token: data.access_token,
    // Expire 5 min early to be safe
    expiresAt: Date.now() + (data.expires_in - 300) * 1000,
  };

  return cachedToken.token;
}

interface BrowseSearchResponse {
  total: number;
  itemSummaries?: Array<{
    title: string;
    itemId: string;
    price: { value: string; currency: string };
    condition: string;
    itemWebUrl: string;
    image?: { imageUrl: string };
    itemEndDate?: string;
    shippingOptions?: Array<{
      shippingCost?: { value: string; currency: string };
    }>;
  }>;
}

export async function searchSoldListings(
  query: string,
  limit: number = 20
): Promise<EbayPriceEstimate> {
  const token = await getAppToken();

  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
    sort: "-endDate",
    // Filter to completed/sold items
    filter: "conditions:{NEW|LIKE_NEW|VERY_GOOD|GOOD|ACCEPTABLE},buyingOptions:{FIXED_PRICE|AUCTION}",
  });

  const response = await fetch(
    `https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        "Content-Type": "application/json",
      },
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`eBay Browse API error: ${response.status} - ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as BrowseSearchResponse;
  const items = data.itemSummaries ?? [];

  const listings: EbaySoldListing[] = items.map((item) => {
    const priceDollars = parseFloat(item.price.value);
    const shippingDollars = item.shippingOptions?.[0]?.shippingCost
      ? parseFloat(item.shippingOptions[0].shippingCost.value)
      : 0;

    return {
      title: item.title,
      price_cents: Math.round(priceDollars * 100),
      currency: item.price.currency,
      sold_date: item.itemEndDate ?? "",
      condition: item.condition ?? "",
      url: item.itemWebUrl,
      image_url: item.image?.imageUrl,
      shipping_cents: Math.round(shippingDollars * 100),
    };
  });

  return buildEstimate(query, listings);
}

// ---------------------------------------------------------------------------
// Finding API fallback (findCompletedItems) - works without Browse API access
// ---------------------------------------------------------------------------

interface FindingResponse {
  findCompletedItemsResponse?: Array<{
    searchResult?: Array<{
      item?: Array<{
        title: string[];
        viewItemURL: string[];
        sellingStatus: Array<{
          currentPrice: Array<{
            __value__: string;
            "@currencyId": string;
          }>;
          sellingState: string[];
        }>;
        listingInfo: Array<{
          endTime: string[];
        }>;
        condition?: Array<{
          conditionDisplayName: string[];
        }>;
        galleryURL?: string[];
      }>;
    }>;
  }>;
}

export async function searchCompletedListings(
  query: string,
  limit: number = 20
): Promise<EbayPriceEstimate> {
  const { appId } = getCredentials();

  const params = new URLSearchParams({
    "OPERATION-NAME": "findCompletedItems",
    "SERVICE-VERSION": "1.13.0",
    "SECURITY-APPNAME": appId,
    "RESPONSE-DATA-FORMAT": "JSON",
    keywords: query,
    "paginationInput.entriesPerPage": String(limit),
    "sortOrder": "EndTimeSoonest",
    "itemFilter(0).name": "SoldItemsOnly",
    "itemFilter(0).value": "true",
  });

  const response = await fetch(
    `https://svcs.ebay.com/services/search/FindingService/v1?${params}`
  );

  if (!response.ok) {
    throw new Error(`eBay Finding API error: ${response.status}`);
  }

  const data = (await response.json()) as FindingResponse;
  const items =
    data.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item ?? [];

  const listings: EbaySoldListing[] = items.map((item) => {
    const priceStr =
      item.sellingStatus[0].currentPrice[0].__value__;
    const priceDollars = parseFloat(priceStr);

    return {
      title: item.title[0],
      price_cents: Math.round(priceDollars * 100),
      currency:
        item.sellingStatus[0].currentPrice[0]["@currencyId"] ?? "USD",
      sold_date: item.listingInfo[0].endTime[0],
      condition: item.condition?.[0]?.conditionDisplayName?.[0] ?? "",
      url: item.viewItemURL[0],
      image_url: item.galleryURL?.[0],
    };
  });

  return buildEstimate(query, listings);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildEstimate(
  query: string,
  listings: EbaySoldListing[]
): EbayPriceEstimate {
  if (listings.length === 0) {
    return {
      query,
      listings: [],
      average_price_cents: 0,
      median_price_cents: 0,
      low_price_cents: 0,
      high_price_cents: 0,
      sample_size: 0,
    };
  }

  const prices = listings
    .map((l) => l.price_cents + (l.shipping_cents ?? 0))
    .sort((a, b) => a - b);

  const sum = prices.reduce((acc, p) => acc + p, 0);
  const mid = Math.floor(prices.length / 2);
  const median =
    prices.length % 2 === 0
      ? Math.round((prices[mid - 1] + prices[mid]) / 2)
      : prices[mid];

  return {
    query,
    listings,
    average_price_cents: Math.round(sum / prices.length),
    median_price_cents: median,
    low_price_cents: prices[0],
    high_price_cents: prices[prices.length - 1],
    sample_size: prices.length,
  };
}

export async function getEbayPrices(
  query: string,
  limit: number = 20
): Promise<EbayPriceEstimate> {
  // Try Browse API first, fall back to Finding API
  try {
    return await searchSoldListings(query, limit);
  } catch {
    try {
      return await searchCompletedListings(query, limit);
    } catch (err) {
      throw new Error(
        `Both eBay APIs failed for "${query}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
