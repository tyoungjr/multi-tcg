export interface PriceChartingProduct {
  id: string;
  "product-name": string;
  "console-name": string;
  "loose-price": number;
  "cib-price": number;
  "new-price": number;
  "graded-price"?: number;
  "box-only-price"?: number;
  "manual-only-price"?: number;
  upc?: string;
  asin?: string;
}

export interface PriceChartingSearchResult {
  status: string;
  products: PriceChartingProduct[];
}
