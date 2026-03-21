// ---------------------------------------------------------------------------
// Shopify Admin REST API client
// ---------------------------------------------------------------------------
//
// For custom apps created in Shopify admin:
//   Settings > Apps > Develop apps > [your app] > API credentials
//   -> "Admin API access token" (reveal once, copy it)
//
// Set in .env:
//   SHOPIFY_STORE=your-store.myshopify.com
//   SHOPIFY_ACCESS_TOKEN=shpat_xxxxx
//
// API version is pinned to avoid breaking changes.
// ---------------------------------------------------------------------------

const API_VERSION = "2024-01";

function getConfig(): { store: string; token: string } {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!store || !token) {
    throw new Error(
      "Missing SHOPIFY_STORE or SHOPIFY_ACCESS_TOKEN in environment.\n" +
        "For custom apps: Shopify Admin > Settings > Apps > Develop apps > your app > API credentials\n" +
        "Reveal the Admin API access token and add it to .env"
    );
  }

  return { store, token };
}

function baseUrl(): string {
  const { store } = getConfig();
  return `https://${store}/admin/api/${API_VERSION}`;
}

function headers(): Record<string, string> {
  const { token } = getConfig();
  return {
    "X-Shopify-Access-Token": token,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

// ---------------------------------------------------------------------------
// Rate limiting - Shopify allows 40 requests per app per store
// We'll do a simple delay between calls
// ---------------------------------------------------------------------------

let lastCallTime = 0;
const MIN_DELAY_MS = 500;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < MIN_DELAY_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_DELAY_MS - elapsed));
  }
  lastCallTime = Date.now();
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

export async function shopifyGet<T>(path: string): Promise<T> {
  await rateLimit();

  const response = await fetch(`${baseUrl()}${path}`, {
    method: "GET",
    headers: headers(),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Shopify GET ${path} failed: ${response.status} - ${body.slice(0, 300)}`
    );
  }

  return response.json() as Promise<T>;
}

export async function shopifyPost<T>(
  path: string,
  body: unknown
): Promise<T> {
  await rateLimit();

  const response = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const respBody = await response.text();
    throw new Error(
      `Shopify POST ${path} failed: ${response.status} - ${respBody.slice(0, 300)}`
    );
  }

  return response.json() as Promise<T>;
}

export async function shopifyPut<T>(
  path: string,
  body: unknown
): Promise<T> {
  await rateLimit();

  const response = await fetch(`${baseUrl()}${path}`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const respBody = await response.text();
    throw new Error(
      `Shopify PUT ${path} failed: ${response.status} - ${respBody.slice(0, 300)}`
    );
  }

  return response.json() as Promise<T>;
}

export async function shopifyDelete(path: string): Promise<void> {
  await rateLimit();

  const response = await fetch(`${baseUrl()}${path}`, {
    method: "DELETE",
    headers: headers(),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Shopify DELETE ${path} failed: ${response.status} - ${body.slice(0, 300)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Pagination helper - Shopify uses Link header cursor pagination
// ---------------------------------------------------------------------------

export async function shopifyGetAll<T>(
  path: string,
  key: string
): Promise<T[]> {
  const allItems: T[] = [];
  let nextUrl: string | null = `${baseUrl()}${path}`;

  while (nextUrl) {
    await rateLimit();

    const response = await fetch(nextUrl, {
      method: "GET",
      headers: headers(),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Shopify GET failed: ${response.status} - ${body.slice(0, 300)}`
      );
    }

    const data = (await response.json()) as Record<string, T[]>;
    const items = data[key] ?? [];
    allItems.push(...items);

    // Parse Link header for next page
    const linkHeader = response.headers.get("link");
    nextUrl = null;
    if (linkHeader) {
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (nextMatch) {
        nextUrl = nextMatch[1];
      }
    }
  }

  return allItems;
}
