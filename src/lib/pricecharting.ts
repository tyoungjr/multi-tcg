import type {
  PriceChartingProduct,
  PriceChartingSearchResult,
} from "../types/pricecharting";

const BASE_URL = "https://www.pricecharting.com/api";

function getApiKey(): string {
  const key = process.env.PRICECHARTING_API_KEY;
  if (!key) {
    throw new Error(
      "Missing PRICECHARTING_API_KEY in environment. Add it to your .env file."
    );
  }
  return key;
}

let lastCallTime = 0;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < 1100) {
    await new Promise((resolve) => setTimeout(resolve, 1100 - elapsed));
  }
  lastCallTime = Date.now();
}

async function apiGet<T>(
  endpoint: string,
  params: Record<string, string>
): Promise<T> {
  await rateLimit();

  const url = new URL(`${BASE_URL}/${endpoint}`);
  url.searchParams.set("t", getApiKey());
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(
      `PriceCharting API error: ${response.status} ${response.statusText}`
    );
  }

  return response.json() as Promise<T>;
}

interface SingleProductResponse extends PriceChartingProduct {
  status: string;
}

export async function getProductById(
  id: string
): Promise<PriceChartingProduct> {
  const data = await apiGet<SingleProductResponse>("product", { id });
  if (data.status === "error") {
    throw new Error(`PriceCharting product not found: id=${id}`);
  }
  return data;
}

export async function getProductByUpc(
  upc: string
): Promise<PriceChartingProduct> {
  const data = await apiGet<SingleProductResponse>("product", { upc });
  if (data.status === "error") {
    throw new Error(`PriceCharting product not found: upc=${upc}`);
  }
  return data;
}

export async function searchProducts(
  query: string,
  consoleName?: string
): Promise<PriceChartingProduct[]> {
  const params: Record<string, string> = { q: query };
  if (consoleName) {
    params["console-name"] = consoleName;
  }

  const data = await apiGet<PriceChartingSearchResult>("products", params);
  if (data.status === "error") {
    return [];
  }
  return data.products ?? [];
}

export function getPriceForCondition(
  product: PriceChartingProduct,
  condition: "loose" | "cib" | "new_sealed" | "graded"
): number | null {
  switch (condition) {
    case "loose":
      return product["loose-price"] ?? null;
    case "cib":
      return product["cib-price"] ?? null;
    case "new_sealed":
      return product["new-price"] ?? null;
    case "graded":
      return product["graded-price"] ?? null;
    default:
      return product["loose-price"] ?? null;
  }
}
