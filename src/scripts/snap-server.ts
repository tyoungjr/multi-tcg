import dotenv from "dotenv";
dotenv.config();

import { createServer, IncomingMessage, ServerResponse } from "http";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { join, basename, extname } from "path";
import { networkInterfaces } from "os";
import {
  visualSearchFromFile,
} from "../services/visual-search";
import type { SearchOptions } from "../services/visual-search";
import type { VisualSearchResult, PriceChartingMatch } from "../types/visual-search";
import type { Product, ProductInsert, ProductCategory, ProductCondition } from "../types/database";
import { supabase } from "../lib/supabase";
import { pushProductToShopify } from "../services/shopify-sync";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.SNAP_SERVER_PORT ?? "3457", 10);
const INBOX_DIR = process.env.SNAP_INBOX_DIR ?? "inbox";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatPrice(cents: number | undefined | null): string {
  if (!cents || cents === 0) return "-";
  return `$${(cents / 100).toFixed(2)}`;
}

function getLocalIp(): string {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "localhost";
}

// ---------------------------------------------------------------------------
// Parse multipart form data (minimal, no deps)
// ---------------------------------------------------------------------------

function parseMultipart(
  body: Buffer,
  contentType: string
): { filename: string; data: Buffer } | null {
  const boundaryMatch = contentType.match(/boundary=(.+)/);
  if (!boundaryMatch) return null;

  const boundary = boundaryMatch[1];
  const boundaryBuf = Buffer.from(`--${boundary}`);

  const start = body.indexOf(boundaryBuf) + boundaryBuf.length;
  const end = body.indexOf(boundaryBuf, start);
  if (start < 0 || end < 0) return null;

  const part = body.subarray(start, end);

  // Find the double CRLF that separates headers from body
  const headerEnd = part.indexOf("\r\n\r\n");
  if (headerEnd < 0) return null;

  const headers = part.subarray(0, headerEnd).toString();
  const fileData = part.subarray(headerEnd + 4, part.length - 2); // strip trailing \r\n

  const filenameMatch = headers.match(/filename="([^"]+)"/);
  const filename = filenameMatch?.[1] ?? `snap-${Date.now()}.jpg`;

  return { filename, data: fileData };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Identify + price pipeline
// ---------------------------------------------------------------------------

interface SnapResult {
  identification: {
    title: string;
    category: string;
    confidence: string;
    description: string;
    details: Record<string, unknown>;
  };
  pricecharting?: PriceChartingMatch;
  pc_candidates?: PriceChartingMatch[];
  suggested_market_price_cents?: number;
  price_source: string;
  file_path: string;
}

async function identifyImage(filePath: string): Promise<SnapResult> {
  const options: SearchOptions = {};
  const result = await visualSearchFromFile(filePath, options);

  return {
    identification: {
      title: result.identification.title,
      category: result.identification.category,
      confidence: result.identification.confidence,
      description: result.identification.description,
      details: result.identification.details,
    },
    pricecharting: result.pricecharting,
    pc_candidates: result.pc_candidates,
    suggested_market_price_cents: result.suggested_market_price_cents,
    price_source: result.price_source,
    file_path: filePath,
  };
}

// ---------------------------------------------------------------------------
// Save + list
// ---------------------------------------------------------------------------

interface SaveRequest {
  file_path: string;
  title: string;
  category: string;
  condition: string;
  price_cents: number;
  status: string;
  notes?: string;
  quantity: number;
  pricecharting_id?: string;
  market_price_cents?: number;
  description?: string;
  metadata?: Record<string, unknown>;
  list_on_shopify: boolean;
}

async function saveAndList(req: SaveRequest): Promise<{
  product_id: string;
  shopify_product_id?: string;
  shopify_url?: string;
  error?: string;
}> {
  const insert: ProductInsert = {
    title: req.title,
    category: req.category as ProductCategory,
    condition: (req.condition as ProductCondition) || "loose",
    inventory_status: req.list_on_shopify ? "listed_shopify" : (req.status as ProductInsert["inventory_status"]) ?? "in_stock",
    current_price: req.price_cents > 0 ? req.price_cents : undefined,
    market_price: req.market_price_cents,
    quantity: req.quantity || 1,
    description: req.description,
    metadata: req.metadata ?? {},
  };

  if (req.pricecharting_id) {
    insert.pricecharting_id = req.pricecharting_id;
  }
  if (req.notes) {
    insert.purchase_notes = req.notes;
  }

  const { data, error } = await supabase
    .from("products")
    .insert(insert)
    .select("*")
    .single();

  if (error) {
    return { product_id: "", error: error.message };
  }

  const product = data as Product;

  // Upload image to Supabase Storage
  try {
    const fileData = readFileSync(req.file_path);
    const fileName = basename(req.file_path);
    const ext = extname(req.file_path).toLowerCase();
    const contentType =
      ext === ".png" ? "image/png" :
      ext === ".webp" ? "image/webp" :
      "image/jpeg";

    const storagePath = `products/${product.id}/${fileName}`;

    const { error: uploadError } = await supabase.storage
      .from("product-images")
      .upload(storagePath, fileData, { contentType, upsert: true });

    if (!uploadError) {
      const { data: urlData } = supabase.storage
        .from("product-images")
        .getPublicUrl(storagePath);

      await supabase.from("product_images").insert({
        product_id: product.id,
        storage_path: storagePath,
        url: urlData.publicUrl,
        is_primary: true,
      });
    }
  } catch {
    // Non-critical
  }

  const result: { product_id: string; shopify_product_id?: string; shopify_url?: string; error?: string } = {
    product_id: product.id,
  };

  // Push to Shopify if requested
  if (req.list_on_shopify && process.env.SHOPIFY_ACCESS_TOKEN) {
    // Re-fetch to get the image URL attached
    const { data: freshProduct } = await supabase
      .from("products")
      .select("*")
      .eq("id", product.id)
      .single();

    if (freshProduct) {
      const pushResult = await pushProductToShopify(freshProduct as Product);
      if (pushResult.success) {
        result.shopify_product_id = pushResult.shopifyProductId;
        const store = process.env.SHOPIFY_STORE ?? "";
        result.shopify_url = `https://${store}/admin/products/${pushResult.shopifyProductId}`;
      } else {
        result.error = pushResult.error;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Camera page HTML
// ---------------------------------------------------------------------------

function getCameraPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <title>Snap & Sell</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, system-ui, sans-serif;
      background: #111;
      color: #eee;
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
    }
    .header {
      padding: 12px 16px;
      background: #1a1a1a;
      border-bottom: 1px solid #333;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .header h1 { font-size: 18px; font-weight: 600; }
    .status-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #4ade80;
    }

    /* States */
    .screen { display: none; flex: 1; flex-direction: column; }
    .screen.active { display: flex; }

    /* Capture screen */
    #capture-screen { align-items: center; justify-content: center; gap: 20px; padding: 20px; }
    .snap-btn {
      width: 120px; height: 120px; border-radius: 50%;
      background: #2563eb; border: 4px solid #60a5fa;
      color: white; font-size: 16px; font-weight: 600;
      cursor: pointer; transition: all 0.15s;
      display: flex; align-items: center; justify-content: center;
    }
    .snap-btn:active { transform: scale(0.92); background: #1d4ed8; }
    .snap-hint { color: #888; font-size: 14px; }
    input[type="file"] { display: none; }

    /* Loading screen */
    #loading-screen { align-items: center; justify-content: center; gap: 16px; }
    .spinner {
      width: 48px; height: 48px; border: 4px solid #333;
      border-top-color: #2563eb; border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loading-text { color: #aaa; font-size: 14px; }

    /* Result screen */
    #result-screen { padding: 16px; gap: 12px; overflow-y: auto; }
    .card {
      background: #1a1a1a; border: 1px solid #333;
      border-radius: 8px; padding: 14px;
    }
    .card h2 { font-size: 16px; margin-bottom: 8px; }
    .card .detail { font-size: 13px; color: #aaa; margin: 4px 0; }
    .card .price { font-size: 20px; font-weight: 700; color: #4ade80; }

    /* PC candidates */
    .pc-list { list-style: none; }
    .pc-list li {
      padding: 10px; margin: 4px 0; background: #222;
      border: 2px solid transparent; border-radius: 6px;
      cursor: pointer; font-size: 13px;
    }
    .pc-list li.selected { border-color: #2563eb; background: #1e293b; }
    .pc-list li .pc-price { color: #4ade80; float: right; }

    /* Form */
    .form-group { margin: 8px 0; }
    .form-group label { display: block; font-size: 12px; color: #888; margin-bottom: 4px; }
    .form-group input, .form-group select {
      width: 100%; padding: 10px; font-size: 16px;
      background: #222; border: 1px solid #444; border-radius: 6px;
      color: #eee; outline: none;
    }
    .form-group input:focus, .form-group select:focus { border-color: #2563eb; }

    /* Buttons */
    .btn-row { display: flex; gap: 8px; margin-top: 8px; }
    .btn {
      flex: 1; padding: 14px; border: none; border-radius: 8px;
      font-size: 15px; font-weight: 600; cursor: pointer;
    }
    .btn-primary { background: #2563eb; color: white; }
    .btn-primary:active { background: #1d4ed8; }
    .btn-success { background: #16a34a; color: white; }
    .btn-success:active { background: #15803d; }
    .btn-secondary { background: #333; color: #eee; }
    .btn-secondary:active { background: #444; }
    .btn:disabled { opacity: 0.5; }

    /* Success */
    .success-banner {
      background: #16a34a; color: white; padding: 14px;
      border-radius: 8px; text-align: center; font-weight: 600;
    }
    .success-banner a { color: white; text-decoration: underline; }

    /* Preview image */
    .preview-img {
      width: 100%; max-height: 200px; object-fit: contain;
      border-radius: 8px; background: #000;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="status-dot"></div>
    <h1>Snap & Sell</h1>
  </div>

  <!-- Screen 1: Capture -->
  <div id="capture-screen" class="screen active">
    <button class="snap-btn" id="snap-btn">SNAP</button>
    <p class="snap-hint">Tap to photograph an item</p>
    <input type="file" id="file-input" accept="image/*" capture="environment">
  </div>

  <!-- Screen 2: Loading -->
  <div id="loading-screen" class="screen">
    <div class="spinner"></div>
    <div class="loading-text" id="loading-text">Uploading...</div>
  </div>

  <!-- Screen 3: Result + save/list -->
  <div id="result-screen" class="screen">
    <img class="preview-img" id="preview-img">

    <div class="card" id="id-card">
      <h2 id="id-title"></h2>
      <div class="detail" id="id-category"></div>
      <div class="detail" id="id-description"></div>
      <div class="detail" id="id-details"></div>
    </div>

    <!-- PriceCharting candidates -->
    <div class="card" id="pc-card" style="display:none">
      <h2>PriceCharting Match</h2>
      <ul class="pc-list" id="pc-list"></ul>
    </div>

    <div class="card">
      <div class="price" id="suggested-price"></div>
      <div class="detail" id="price-source"></div>
    </div>

    <!-- Save form -->
    <div class="card">
      <h2>List This Item</h2>
      <div class="form-group">
        <label>Title</label>
        <input id="f-title" type="text">
      </div>
      <div class="form-group">
        <label>Listing Price ($)</label>
        <input id="f-price" type="number" step="0.01" inputmode="decimal">
      </div>
      <div class="form-group">
        <label>Condition</label>
        <select id="f-condition">
          <option value="loose">Loose</option>
          <option value="good">Good</option>
          <option value="very_good">Very Good</option>
          <option value="cib">CIB</option>
          <option value="new_sealed">New / Sealed</option>
          <option value="graded">Graded</option>
        </select>
      </div>
      <div class="form-group">
        <label>Quantity</label>
        <input id="f-qty" type="number" value="1" inputmode="numeric">
      </div>
      <div class="form-group">
        <label>Notes (optional)</label>
        <input id="f-notes" type="text" placeholder="e.g. display box only">
      </div>

      <div class="btn-row">
        <button class="btn btn-primary" id="save-btn">Save Only</button>
        <button class="btn btn-success" id="list-btn">Save + Shopify</button>
      </div>
      <div class="btn-row">
        <button class="btn btn-secondary" id="skip-btn">Skip</button>
      </div>
    </div>

    <!-- Success message -->
    <div id="success-msg" style="display:none"></div>
  </div>

  <script>
    // State
    let currentResult = null;
    let currentFilePath = null;
    let selectedPcId = null;
    let selectedPcPrice = null;

    // Screens
    const screens = {
      capture: document.getElementById('capture-screen'),
      loading: document.getElementById('loading-screen'),
      result: document.getElementById('result-screen'),
    };

    function showScreen(name) {
      Object.values(screens).forEach(s => s.classList.remove('active'));
      screens[name].classList.add('active');
    }

    // Snap button triggers file input
    document.getElementById('snap-btn').onclick = () => {
      document.getElementById('file-input').click();
    };

    // File selected -> upload
    document.getElementById('file-input').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      showScreen('loading');
      document.getElementById('loading-text').textContent = 'Uploading...';

      const formData = new FormData();
      formData.append('photo', file);

      try {
        document.getElementById('loading-text').textContent = 'Identifying...';
        const resp = await fetch('/api/identify', { method: 'POST', body: formData });
        const data = await resp.json();

        if (data.error) {
          alert('Error: ' + data.error);
          showScreen('capture');
          return;
        }

        currentResult = data;
        currentFilePath = data.file_path;
        showResult(data);
        showScreen('result');
      } catch (err) {
        alert('Upload failed: ' + err.message);
        showScreen('capture');
      }

      // Reset input so same file can be re-selected
      e.target.value = '';
    };

    function formatCents(cents) {
      if (!cents || cents <= 0) return '-';
      return '$' + (cents / 100).toFixed(2);
    }

    function showResult(data) {
      const id = data.identification;

      // Preview image
      document.getElementById('preview-img').src = '/api/preview/' + encodeURIComponent(data.file_path);

      // Identification
      document.getElementById('id-title').textContent = id.title;
      document.getElementById('id-category').textContent = id.category + ' | ' + id.confidence + ' confidence';
      document.getElementById('id-description').textContent = id.description;

      const details = [];
      const d = id.details;
      if (d.game) details.push(d.game);
      if (d.set) details.push(d.set);
      if (d.card_number) details.push('#' + d.card_number);
      if (d.rarity) details.push(d.rarity);
      if (d.platform) details.push(d.platform);
      if (d.region) details.push(d.region);
      if (d.condition_estimate) details.push('Condition: ' + d.condition_estimate);
      document.getElementById('id-details').textContent = details.join(' | ');

      // PriceCharting candidates
      const pcCard = document.getElementById('pc-card');
      const pcList = document.getElementById('pc-list');
      pcList.innerHTML = '';
      selectedPcId = null;
      selectedPcPrice = null;

      if (data.pc_candidates && data.pc_candidates.length > 0) {
        pcCard.style.display = '';
        data.pc_candidates.forEach((c, i) => {
          const li = document.createElement('li');
          const price = c.loose_price_cents || c.cib_price_cents || c.new_price_cents;
          li.innerHTML = c.product_name + ' (' + c.console_name + ')<span class="pc-price">' + formatCents(price) + '</span>';
          li.dataset.id = c.pricecharting_id;
          li.dataset.price = price;

          // Auto-select the matched one
          if (data.pricecharting && c.pricecharting_id === data.pricecharting.pricecharting_id) {
            li.classList.add('selected');
            selectedPcId = c.pricecharting_id;
            selectedPcPrice = price;
          }

          li.onclick = () => {
            pcList.querySelectorAll('li').forEach(x => x.classList.remove('selected'));
            li.classList.add('selected');
            selectedPcId = c.pricecharting_id;
            selectedPcPrice = parseInt(c.loose_price_cents || c.cib_price_cents || c.new_price_cents);
            // Update suggested price
            document.getElementById('suggested-price').textContent = formatCents(selectedPcPrice);
            document.getElementById('f-price').value = (selectedPcPrice / 100).toFixed(2);
          };

          pcList.appendChild(li);
        });
      } else {
        pcCard.style.display = 'none';
      }

      // Suggested price
      const suggestedCents = data.suggested_market_price_cents || 0;
      document.getElementById('suggested-price').textContent = formatCents(suggestedCents);
      document.getElementById('price-source').textContent = 'Source: ' + data.price_source;

      // Pre-fill form
      document.getElementById('f-title').value = id.title;
      document.getElementById('f-price').value = suggestedCents > 0 ? (suggestedCents / 100).toFixed(2) : '';
      document.getElementById('f-condition').value = mapCondition(id.details.condition_estimate);
      document.getElementById('f-qty').value = '1';
      document.getElementById('f-notes').value = '';
      document.getElementById('success-msg').style.display = 'none';
    }

    function mapCondition(estimate) {
      if (!estimate) return 'loose';
      const map = { 'mint': 'new_sealed', 'near mint': 'cib', 'lightly played': 'good', 'moderately played': 'good', 'heavily played': 'loose', 'damaged': 'loose' };
      return map[estimate.toLowerCase()] || 'loose';
    }

    // Save / List buttons
    document.getElementById('save-btn').onclick = () => doSave(false);
    document.getElementById('list-btn').onclick = () => doSave(true);
    document.getElementById('skip-btn').onclick = () => {
      showScreen('capture');
    };

    async function doSave(listOnShopify) {
      const priceStr = document.getElementById('f-price').value;
      const priceCents = Math.round(parseFloat(priceStr || '0') * 100);

      if (listOnShopify && priceCents <= 0) {
        alert('Set a listing price to push to Shopify');
        return;
      }

      const btns = document.querySelectorAll('.btn');
      btns.forEach(b => b.disabled = true);

      try {
        const body = {
          file_path: currentFilePath,
          title: document.getElementById('f-title').value,
          category: currentResult.identification.category,
          condition: document.getElementById('f-condition').value,
          price_cents: priceCents,
          status: 'in_stock',
          notes: document.getElementById('f-notes').value || undefined,
          quantity: parseInt(document.getElementById('f-qty').value) || 1,
          pricecharting_id: selectedPcId || undefined,
          market_price_cents: currentResult.suggested_market_price_cents || undefined,
          description: currentResult.identification.description,
          metadata: currentResult.identification.details,
          list_on_shopify: listOnShopify,
        };

        const resp = await fetch('/api/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        const result = await resp.json();

        if (result.error) {
          alert('Save failed: ' + result.error);
          return;
        }

        const msg = document.getElementById('success-msg');
        if (listOnShopify && result.shopify_product_id) {
          msg.innerHTML = '<div class="success-banner">Listed on Shopify!<br><a href="' + result.shopify_url + '" target="_blank">View in admin</a></div>';
        } else {
          msg.innerHTML = '<div class="success-banner">Saved to inventory</div>';
        }
        msg.style.display = '';

        // Back to capture after short delay
        setTimeout(() => showScreen('capture'), 2000);
      } catch (err) {
        alert('Error: ' + err.message);
      } finally {
        btns.forEach(b => b.disabled = false);
      }
    }
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = req.url ?? "/";

  // CORS for local network
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Serve camera page
  if (url === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(getCameraPage());
    return;
  }

  // Upload + identify
  if (url === "/api/identify" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const contentType = req.headers["content-type"] ?? "";
      const file = parseMultipart(body, contentType);

      if (!file || file.data.length === 0) {
        sendJson(res, 400, { error: "No image received" });
        return;
      }

      if (!existsSync(INBOX_DIR)) {
        mkdirSync(INBOX_DIR, { recursive: true });
      }

      const timestamp = Date.now();
      const safeName = file.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = join(INBOX_DIR, `${timestamp}-${safeName}`);
      writeFileSync(filePath, file.data);

      console.log(`Received: ${safeName} (${(file.data.length / 1024).toFixed(0)}KB)`);
      console.log("Identifying...");

      const result = await identifyImage(filePath);

      console.log(`  -> ${result.identification.title} (${result.identification.confidence})`);
      if (result.pricecharting) {
        console.log(`  -> PC: ${result.pricecharting.product_name} - ${formatPrice(result.pricecharting.loose_price_cents)}`);
      }
      console.log(`  -> Price: ${formatPrice(result.suggested_market_price_cents)} (${result.price_source})`);

      sendJson(res, 200, result);
    } catch (err) {
      console.error("Identify failed:", err);
      sendJson(res, 500, { error: err instanceof Error ? err.message : "Unknown error" });
    }
    return;
  }

  // Save + optionally list
  if (url === "/api/save" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const saveReq = JSON.parse(body.toString()) as SaveRequest;

      console.log(`Saving: ${saveReq.title} at ${formatPrice(saveReq.price_cents)}${saveReq.list_on_shopify ? " + Shopify" : ""}`);

      const result = await saveAndList(saveReq);

      if (result.error) {
        console.error(`  Failed: ${result.error}`);
      } else {
        console.log(`  Saved: ${result.product_id}`);
        if (result.shopify_product_id) {
          console.log(`  Listed on Shopify: ${result.shopify_product_id}`);
        }
      }

      sendJson(res, 200, result);
    } catch (err) {
      console.error("Save failed:", err);
      sendJson(res, 500, { error: err instanceof Error ? err.message : "Unknown error" });
    }
    return;
  }

  // Serve preview images
  if (url.startsWith("/api/preview/") && req.method === "GET") {
    try {
      const filePath = decodeURIComponent(url.slice("/api/preview/".length));
      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const data = readFileSync(filePath);
      const ext = filePath.toLowerCase();
      const mime = ext.endsWith(".png") ? "image/png" : ext.endsWith(".webp") ? "image/webp" : "image/jpeg";
      res.writeHead(200, { "Content-Type": mime, "Cache-Control": "max-age=3600" });
      res.end(data);
    } catch {
      res.writeHead(500);
      res.end("Error");
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

function main(): void {
  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error("Request error:", err);
      res.writeHead(500);
      res.end("Internal error");
    });
  });

  server.listen(PORT, "0.0.0.0", () => {
    const ip = getLocalIp();
    console.log(`\nSnap & Sell server running!\n`);
    console.log(`  Local:   http://localhost:${PORT}`);
    console.log(`  Phone:   http://${ip}:${PORT}\n`);
    console.log(`Open the phone URL in your browser, tap SNAP, and start listing.\n`);
  });
}

main();
