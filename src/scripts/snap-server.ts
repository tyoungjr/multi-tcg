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
import type { PriceChartingMatch } from "../types/visual-search";
import type { Product, ProductInsert, ProductCategory, ProductCondition } from "../types/database";
import { supabase } from "../lib/supabase";
import { pushProductToShopify } from "../services/shopify-sync";
import { getProductById } from "../lib/pricecharting";

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

// ---------------------------------------------------------------------------
// Batch job queue (in-memory)
// ---------------------------------------------------------------------------

interface BatchJob {
  id: string;
  status: "processing" | "done" | "error";
  file_path: string;
  result?: SnapResult;
  error?: string;
  created_at: number;
  saved?: boolean;
}

const jobQueue = new Map<string, BatchJob>();

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

function enqueuePhoto(filePath: string): string {
  const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const job: BatchJob = { id, status: "processing", file_path: filePath, created_at: Date.now() };
  jobQueue.set(id, job);

  identifyImage(filePath)
    .then((result) => {
      job.status = "done";
      job.result = result;
      console.log(`  [batch] Done: ${result.identification.title}`);
    })
    .catch((err) => {
      job.status = "error";
      job.error = err instanceof Error ? err.message : "Unknown error";
      console.error(`  [batch] Failed: ${id}`, err);
    });

  return id;
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
  grading_company?: string | null;
  graded_score?: number | null;
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
    grading_company: req.grading_company ?? null,
    graded_score: req.graded_score ?? null,
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

    if (uploadError) {
      console.warn(`  Image upload failed: ${uploadError.message}`);
    } else {
      const { data: urlData } = supabase.storage
        .from("product-images")
        .getPublicUrl(storagePath);

      console.log(`  Image uploaded: ${urlData.publicUrl}`);

      const { error: imgRecordError } = await supabase.from("product_images").insert({
        product_id: product.id,
        storage_path: storagePath,
        url: urlData.publicUrl,
        is_primary: true,
      });

      if (imgRecordError) {
        console.warn(`  Image record insert failed: ${imgRecordError.message}`);
      }
    }
  } catch (err) {
    console.warn(`  Image processing error: ${err instanceof Error ? err.message : err}`);
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
  <div class="header" style="display:flex;gap:12px;align-items:center;">
    <div class="status-dot"></div>
    <h1 style="flex:1">Snap & Sell</h1>
    <a href="/inventory" style="color:#60a5fa;font-size:13px;text-decoration:none;padding:6px 12px;background:#222;border-radius:4px;">Inventory</a>
    <a href="/batch" style="color:#60a5fa;font-size:13px;text-decoration:none;padding:6px 12px;background:#222;border-radius:4px;">Batch</a>
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
      <h2>PriceCharting Match <span id="pc-count" style="font-size:12px;color:#888;font-weight:normal;"></span></h2>
      <input id="pc-filter" type="text" placeholder="Filter candidates..."
        style="width:100%;padding:8px;margin:6px 0;font-size:14px;background:#222;border:1px solid #444;border-radius:6px;color:#eee;">
      <ul class="pc-list" id="pc-list"></ul>
      <div id="pc-pager" style="display:none;justify-content:space-between;align-items:center;margin-top:8px;">
        <button id="pc-prev" class="btn btn-secondary" style="flex:0 0 auto;padding:8px 14px;">Prev</button>
        <span id="pc-page-info" style="font-size:12px;color:#aaa;"></span>
        <button id="pc-next" class="btn btn-secondary" style="flex:0 0 auto;padding:8px 14px;">Next</button>
      </div>
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
      <div class="form-group" id="f-grading-row" style="display:none">
        <label>Grading</label>
        <div style="display:flex;gap:6px;">
          <select id="f-grading-company" style="flex:1;padding:10px;font-size:16px;background:#222;border:1px solid #444;border-radius:6px;color:#eee;">
            <option value="">Grader...</option>
            <option value="PSA">PSA</option>
            <option value="BGS">BGS</option>
            <option value="CGC">CGC</option>
            <option value="SGC">SGC</option>
          </select>
          <input id="f-grade" type="number" step="0.5" inputmode="decimal" placeholder="Grade (e.g. 10)"
            style="width:140px;padding:10px;font-size:16px;background:#222;border:1px solid #444;border-radius:6px;color:#eee;">
        </div>
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
        // Auto-select the matched candidate up front
        if (data.pricecharting) {
          selectedPcId = data.pricecharting.pricecharting_id;
          selectedPcPrice = data.pricecharting.loose_price_cents || data.pricecharting.cib_price_cents || data.pricecharting.new_price_cents;
        }
        initPcPaging(data.pc_candidates);
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
      document.getElementById('f-grading-company').value = id.details.grading_company || '';
      document.getElementById('f-grade').value = id.details.psa_grade || id.details.bgs_grade || id.details.cgc_grade || '';
      toggleGradingRow();
      document.getElementById('success-msg').style.display = 'none';
    }

    function toggleGradingRow() {
      const cond = document.getElementById('f-condition').value;
      document.getElementById('f-grading-row').style.display = cond === 'graded' ? '' : 'none';
    }
    document.getElementById('f-condition').onchange = toggleGradingRow;

    function mapCondition(estimate) {
      if (!estimate) return 'loose';
      const map = { 'mint': 'new_sealed', 'near mint': 'cib', 'lightly played': 'good', 'moderately played': 'good', 'heavily played': 'loose', 'damaged': 'loose' };
      return map[estimate.toLowerCase()] || 'loose';
    }

    // PriceCharting candidate pagination
    const PC_PER_PAGE = 5;
    let pcAll = [];
    let pcFiltered = [];
    let pcPage = 0;

    function initPcPaging(candidates) {
      pcAll = candidates;
      pcFiltered = candidates;
      pcPage = 0;
      document.getElementById('pc-filter').value = '';
      document.getElementById('pc-count').textContent = '(' + candidates.length + ')';
      renderPcPage();
    }

    function renderPcPage() {
      const list = document.getElementById('pc-list');
      const pager = document.getElementById('pc-pager');
      const total = pcFiltered.length;
      const pages = Math.max(1, Math.ceil(total / PC_PER_PAGE));
      pcPage = Math.min(pcPage, pages - 1);
      const start = pcPage * PC_PER_PAGE;
      const slice = pcFiltered.slice(start, start + PC_PER_PAGE);

      list.innerHTML = '';
      slice.forEach(c => {
        const li = document.createElement('li');
        const price = c.loose_price_cents || c.cib_price_cents || c.new_price_cents;
        li.innerHTML = c.product_name + ' (' + c.console_name + ')<span class="pc-price">' + formatCents(price) + '</span>';
        li.dataset.id = c.pricecharting_id;
        li.dataset.price = price;
        if (c.pricecharting_id === selectedPcId) li.classList.add('selected');

        li.onclick = () => {
          document.querySelectorAll('#pc-list li').forEach(x => x.classList.remove('selected'));
          li.classList.add('selected');
          selectedPcId = c.pricecharting_id;
          selectedPcPrice = parseInt(c.loose_price_cents || c.cib_price_cents || c.new_price_cents);
          document.getElementById('suggested-price').textContent = formatCents(selectedPcPrice);
          document.getElementById('f-price').value = selectedPcPrice > 0 ? (selectedPcPrice / 100).toFixed(2) : '';
          document.getElementById('f-title').value = c.product_name;
        };
        list.appendChild(li);
      });

      if (total > PC_PER_PAGE) {
        pager.style.display = 'flex';
        document.getElementById('pc-page-info').textContent = 'Page ' + (pcPage + 1) + ' of ' + pages + ' (' + total + ')';
        document.getElementById('pc-prev').disabled = pcPage === 0;
        document.getElementById('pc-next').disabled = pcPage >= pages - 1;
      } else {
        pager.style.display = 'none';
      }
    }

    document.getElementById('pc-prev').onclick = () => { if (pcPage > 0) { pcPage--; renderPcPage(); } };
    document.getElementById('pc-next').onclick = () => { pcPage++; renderPcPage(); };
    document.getElementById('pc-filter').oninput = (e) => {
      const q = e.target.value.toLowerCase().trim();
      pcFiltered = !q ? pcAll : pcAll.filter(c =>
        (c.product_name + ' ' + c.console_name).toLowerCase().includes(q)
      );
      pcPage = 0;
      renderPcPage();
    };

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

      const condition = document.getElementById('f-condition').value;
      const gradeStr = document.getElementById('f-grade').value;
      const gradingCompany = document.getElementById('f-grading-company').value;

      try {
        const body = {
          file_path: currentFilePath,
          title: document.getElementById('f-title').value,
          category: currentResult.identification.category,
          condition,
          price_cents: priceCents,
          status: 'in_stock',
          notes: document.getElementById('f-notes').value || undefined,
          quantity: parseInt(document.getElementById('f-qty').value) || 1,
          pricecharting_id: selectedPcId || undefined,
          market_price_cents: currentResult.suggested_market_price_cents || undefined,
          description: currentResult.identification.description,
          metadata: currentResult.identification.details,
          grading_company: condition === 'graded' ? (gradingCompany || null) : null,
          graded_score: condition === 'graded' && gradeStr ? parseFloat(gradeStr) : null,
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
// Batch queue page
// ---------------------------------------------------------------------------

function getBatchPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <title>Batch Queue - Snap & Sell</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, system-ui, sans-serif;
      background: #111; color: #eee;
      min-height: 100dvh;
      padding-bottom: 80px;
    }
    .header {
      padding: 12px 16px;
      background: #1a1a1a;
      border-bottom: 1px solid #333;
      position: sticky; top: 0; z-index: 10;
    }
    .header-nav { display: flex; gap: 8px; margin-bottom: 8px; }
    .header-nav a {
      color: #60a5fa; text-decoration: none; font-size: 13px;
      padding: 4px 8px; background: #222; border-radius: 4px;
    }
    .header-nav a.active { background: #2563eb; color: white; }
    .snap-row {
      display: flex; gap: 10px; align-items: center; margin-top: 4px;
    }
    .snap-btn-sm {
      padding: 12px 24px; background: #2563eb; border: none;
      border-radius: 8px; color: white; font-size: 15px; font-weight: 600;
      cursor: pointer; flex-shrink: 0;
    }
    .snap-btn-sm:active { background: #1d4ed8; }
    .snap-btn-sm:disabled { opacity: 0.5; }
    .snap-status { font-size: 13px; color: #aaa; }
    .badge {
      display: inline-block; background: #f59e0b; color: #111;
      font-size: 11px; font-weight: 700; border-radius: 10px;
      padding: 1px 7px; margin-left: 6px; vertical-align: middle;
    }
    input[type="file"] { display: none; }

    .queue { padding: 8px; }
    .empty { text-align: center; padding: 60px 20px; color: #666; font-size: 15px; }

    .job-card {
      background: #1a1a1a; border: 1px solid #333;
      border-radius: 8px; margin-bottom: 8px; overflow: hidden;
    }
    .job-card.processing { border-left: 3px solid #f59e0b; }
    .job-card.done { border-left: 3px solid #4ade80; }
    .job-card.error { border-left: 3px solid #ef4444; }

    /* Processing */
    .proc-inner {
      display: flex; align-items: center; gap: 12px; padding: 14px;
    }
    .spinner-sm {
      width: 24px; height: 24px; border: 3px solid #333;
      border-top-color: #f59e0b; border-radius: 50%;
      animation: spin 0.8s linear infinite; flex-shrink: 0;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .proc-name { font-size: 13px; color: #888; }

    /* Error */
    .err-inner { padding: 14px; display: flex; justify-content: space-between; align-items: center; }
    .err-msg { font-size: 13px; color: #ef4444; }

    /* Done */
    .done-inner { padding: 12px; }
    .done-row { display: flex; gap: 10px; align-items: flex-start; }
    .job-thumb {
      width: 72px; height: 72px; object-fit: cover;
      border-radius: 6px; background: #000; flex-shrink: 0;
    }
    .done-fields { flex: 1; display: flex; flex-direction: column; gap: 6px; }
    .done-fields input, .done-fields select {
      width: 100%; padding: 8px; font-size: 15px;
      background: #222; border: 1px solid #444; border-radius: 6px;
      color: #eee; outline: none;
    }
    .done-fields input:focus, .done-fields select:focus { border-color: #2563eb; }
    .price-row { display: flex; gap: 6px; }
    .price-row input { flex: 1; }
    .price-row select { flex: 1; }

    .skip-btn {
      padding: 6px 12px; background: #333; border: none;
      border-radius: 6px; color: #aaa; font-size: 12px; cursor: pointer;
      flex-shrink: 0; align-self: flex-start;
    }
    .skip-btn:active { background: #444; }

    /* PC candidates */
    .pc-label { font-size: 11px; color: #666; margin: 8px 0 4px; }
    .pc-candidates { display: flex; flex-direction: column; gap: 3px; }
    .pc-item {
      padding: 8px 10px; background: #222; border: 2px solid transparent;
      border-radius: 5px; cursor: pointer; font-size: 12px; color: #ccc;
      display: flex; justify-content: space-between; align-items: center;
    }
    .pc-item.selected { border-color: #2563eb; background: #1e293b; color: #fff; }
    .pc-price { color: #4ade80; margin-left: 8px; flex-shrink: 0; }

    /* Bottom bar */
    .bottom-bar {
      position: fixed; bottom: 0; left: 0; right: 0;
      background: #1a1a1a; border-top: 1px solid #333;
      padding: 12px 16px; display: flex; gap: 8px; z-index: 10;
    }
    .bottom-bar button {
      flex: 1; padding: 14px; border: none; border-radius: 8px;
      font-size: 14px; font-weight: 600; cursor: pointer;
    }
    .btn-save { background: #2563eb; color: white; }
    .btn-save:active { background: #1d4ed8; }
    .btn-shopify { background: #16a34a; color: white; }
    .btn-shopify:active { background: #15803d; }
    .btn-save:disabled, .btn-shopify:disabled { opacity: 0.4; }

    .result-banner {
      margin: 8px; padding: 12px; border-radius: 8px;
      background: #16a34a; color: white; font-size: 14px; font-weight: 600;
      text-align: center; display: none;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-nav">
      <a href="/">Snap</a>
      <a href="/inventory">Inventory</a>
      <a href="/batch" class="active">Batch <span id="proc-badge" class="badge" style="display:none"></span></a>
    </div>
    <div class="snap-row">
      <button class="snap-btn-sm" id="snap-btn">SNAP</button>
      <span class="snap-status" id="snap-status">Snap items one by one, review all at once</span>
    </div>
    <input type="file" id="file-input" accept="image/*" capture="environment">
  </div>

  <div class="result-banner" id="result-banner"></div>
  <div class="queue" id="queue-list"></div>

  <div class="bottom-bar">
    <button class="btn-save" id="save-btn" disabled>Save All to DB</button>
    <button class="btn-shopify" id="shopify-btn" disabled>Save + Shopify</button>
  </div>

  <script>
    const jobData = {};       // job_id -> full job from server
    const knownIds = new Set();
    let pollTimer = null;

    // -----------------------------------------------------------------------
    // Snap
    // -----------------------------------------------------------------------

    document.getElementById('snap-btn').onclick = () => {
      document.getElementById('file-input').click();
    };

    document.getElementById('file-input').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      e.target.value = '';

      const btn = document.getElementById('snap-btn');
      btn.disabled = true;
      document.getElementById('snap-status').textContent = 'Uploading...';

      const fd = new FormData();
      fd.append('photo', file);

      try {
        const resp = await fetch('/api/queue', { method: 'POST', body: fd });
        const { job_id, file_path } = await resp.json();

        knownIds.add(job_id);
        jobData[job_id] = { id: job_id, status: 'processing', file_path };
        prependCard(job_id, file.name);
        document.getElementById('snap-status').textContent = 'Queued! Snap another.';
      } catch (err) {
        document.getElementById('snap-status').textContent = 'Upload failed: ' + err.message;
      } finally {
        btn.disabled = false;
      }
    };

    // -----------------------------------------------------------------------
    // Card rendering
    // -----------------------------------------------------------------------

    function escHtml(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    function formatCents(c) {
      if (!c || c <= 0) return '-';
      return '$' + (c / 100).toFixed(2);
    }
    function mapCond(est) {
      if (!est) return 'loose';
      const m = { 'mint':'new_sealed','near mint':'cib','lightly played':'good','moderately played':'good','heavily played':'loose','damaged':'loose' };
      return m[est.toLowerCase()] || 'loose';
    }
    function selOpt(val, target) {
      return val === target ? 'selected' : '';
    }

    function prependCard(jobId, filename) {
      const list = document.getElementById('queue-list');
      const div = document.createElement('div');
      div.id = 'job-' + jobId;
      div.className = 'job-card processing';
      div.dataset.status = 'processing';
      div.innerHTML = '<div class="proc-inner"><div class="spinner-sm"></div><div class="proc-name">Identifying ' + escHtml(filename) + '...</div></div>';
      list.insertBefore(div, list.firstChild);
      renderEmpty();
      updateCounts();
    }

    function settleCard(job) {
      const card = document.getElementById('job-' + job.id);
      if (!card) return;
      if (card.dataset.status === 'done' || card.dataset.status === 'error') return;

      card.dataset.status = job.status;

      if (job.status === 'error') {
        card.className = 'job-card error';
        card.innerHTML = '<div class="err-inner"><span class="err-msg">Error: ' + escHtml(job.error) + '</span><button class="skip-btn" onclick="removeCard(\\'' + job.id + '\\')">Dismiss</button></div>';
        return;
      }

      card.className = 'job-card done';
      const id = job.result.identification;
      const pc = job.result.pricecharting;
      const candidates = job.result.pc_candidates || [];
      const price = job.result.suggested_market_price_cents || 0;
      const condVal = mapCond(id.details ? id.details.condition_estimate : null);
      const thumb = '/api/preview/' + encodeURIComponent(job.file_path);

      let pcHtml = '';
      if (candidates.length > 0) {
        pcHtml = '<div class="pc-label">PriceCharting match - tap to change:</div><div class="pc-candidates" id="pcc-' + job.id + '">' +
          '<div class="pc-item" data-id="" data-price="0" onclick="selectPc(this,\\'' + job.id + '\\')"><span style="color:#888">None - use manual title</span><span class="pc-price">-</span></div>' +
          candidates.map(c => {
            const p = c.loose_price_cents || c.cib_price_cents || c.new_price_cents || 0;
            const sel = pc && c.pricecharting_id === pc.pricecharting_id ? ' selected' : '';
            return '<div class="pc-item' + sel + '" data-id="' + escHtml(c.pricecharting_id) + '" data-price="' + p + '" onclick="selectPc(this,\\'' + job.id + '\\')"><span>' + escHtml(c.product_name) + ' (' + escHtml(c.console_name) + ')</span><span class="pc-price">' + formatCents(p) + '</span></div>';
          }).join('') +
        '</div>';
      }

      card.innerHTML =
        '<div class="done-inner">' +
          '<div class="done-row">' +
            '<img class="job-thumb" src="' + thumb + '" loading="lazy">' +
            '<div class="done-fields">' +
              '<input id="title-' + job.id + '" type="text" value="' + escHtml(id.title) + '">' +
              '<div class="price-row">' +
                '<input id="price-' + job.id + '" type="number" step="0.01" inputmode="decimal" placeholder="Price $" value="' + (price > 0 ? (price / 100).toFixed(2) : '') + '">' +
                '<select id="cond-' + job.id + '">' +
                  '<option value="loose" ' + selOpt(condVal,'loose') + '>Loose</option>' +
                  '<option value="good" ' + selOpt(condVal,'good') + '>Good</option>' +
                  '<option value="very_good" ' + selOpt(condVal,'very_good') + '>Very Good</option>' +
                  '<option value="cib" ' + selOpt(condVal,'cib') + '>CIB</option>' +
                  '<option value="new_sealed" ' + selOpt(condVal,'new_sealed') + '>New/Sealed</option>' +
                  '<option value="graded" ' + selOpt(condVal,'graded') + '>Graded</option>' +
                '</select>' +
              '</div>' +
            '</div>' +
            '<button class="skip-btn" onclick="removeCard(\\'' + job.id + '\\')">Skip</button>' +
          '</div>' +
          pcHtml +
        '</div>';
    }

    function selectPc(el, jobId) {
      const container = document.getElementById('pcc-' + jobId);
      container.querySelectorAll('.pc-item').forEach(x => x.classList.remove('selected'));
      el.classList.add('selected');
      const price = parseInt(el.dataset.price) || 0;
      const priceEl = document.getElementById('price-' + jobId);
      const titleEl = document.getElementById('title-' + jobId);
      if (price > 0) {
        priceEl.value = (price / 100).toFixed(2);
      }
      // Update title to match selected candidate (grab text before the price span)
      const nameSpan = el.querySelector('span');
      if (nameSpan && el.dataset.id) {
        titleEl.value = nameSpan.textContent;
      }
    }

    function removeCard(jobId) {
      const card = document.getElementById('job-' + jobId);
      if (card) card.remove();
      fetch('/api/queue/' + encodeURIComponent(jobId), { method: 'DELETE' }).catch(() => {});
      delete jobData[jobId];
      knownIds.delete(jobId);
      renderEmpty();
      updateCounts();
    }

    function renderEmpty() {
      const list = document.getElementById('queue-list');
      const hasDone = list.querySelector('.job-card.done, .job-card.processing');
      if (!hasDone) {
        list.innerHTML = '<div class="empty">Snap items above to add them to the queue</div>';
      }
    }

    function updateCounts() {
      const processing = document.querySelectorAll('.job-card.processing').length;
      const done = document.querySelectorAll('.job-card.done').length;
      const badge = document.getElementById('proc-badge');
      if (processing > 0) {
        badge.textContent = processing + ' processing';
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
      document.getElementById('save-btn').disabled = done === 0;
      document.getElementById('shopify-btn').disabled = done === 0;
    }

    // -----------------------------------------------------------------------
    // Polling
    // -----------------------------------------------------------------------

    async function poll() {
      try {
        const resp = await fetch('/api/queue');
        const jobs = await resp.json();
        for (const job of jobs) {
          if (job.saved) continue;
          jobData[job.id] = job;
          if (!knownIds.has(job.id)) {
            knownIds.add(job.id);
            const filename = job.file_path.split(/[\\/]/).pop() || job.id;
            prependCard(job.id, filename);
          }
          if (job.status !== 'processing') {
            settleCard(job);
          }
        }
        updateCounts();
      } catch (e) { /* ignore */ }
    }

    poll();
    pollTimer = setInterval(poll, 2000);

    // -----------------------------------------------------------------------
    // Save
    // -----------------------------------------------------------------------

    document.getElementById('save-btn').onclick = () => doSaveAll(false);
    document.getElementById('shopify-btn').onclick = () => doSaveAll(true);

    async function doSaveAll(listOnShopify) {
      const cards = document.querySelectorAll('.job-card.done');
      if (cards.length === 0) return;

      const items = [];
      for (const card of cards) {
        const jobId = card.id.replace('job-', '');
        const job = jobData[jobId];
        if (!job || !job.result) continue;

        const title = document.getElementById('title-' + jobId).value.trim();
        const priceStr = document.getElementById('price-' + jobId).value;
        const priceCents = Math.round(parseFloat(priceStr || '0') * 100);
        const condition = document.getElementById('cond-' + jobId).value;
        const selectedPc = card.querySelector('.pc-item.selected');
        const pcId = selectedPc ? selectedPc.dataset.id : (job.result.pricecharting ? job.result.pricecharting.pricecharting_id : undefined);

        if (!title) continue;

        if (listOnShopify && priceCents <= 0) {
          alert('Set a price for "' + title + '" before pushing to Shopify');
          return;
        }

        items.push({
          job_id: jobId,
          file_path: job.file_path,
          title,
          category: job.result.identification.category,
          condition,
          price_cents: priceCents,
          status: 'in_stock',
          quantity: 1,
          pricecharting_id: pcId || undefined,
          market_price_cents: job.result.suggested_market_price_cents || undefined,
          description: job.result.identification.description,
          metadata: job.result.identification.details,
          list_on_shopify: listOnShopify,
        });
      }

      if (items.length === 0) return;

      document.getElementById('save-btn').disabled = true;
      document.getElementById('shopify-btn').disabled = true;
      document.getElementById('snap-status').textContent = 'Saving ' + items.length + ' items...';

      try {
        const resp = await fetch('/api/batch-save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items }),
        });
        const results = await resp.json();

        let saved = 0, failed = 0;
        for (const r of results) {
          if (r.error) {
            failed++;
          } else {
            saved++;
            removeCard(r.job_id);
            if (jobData[r.job_id]) jobData[r.job_id].saved = true;
          }
        }

        const banner = document.getElementById('result-banner');
        const shopifyNote = listOnShopify ? ' and listed on Shopify' : '';
        banner.textContent = saved + ' item' + (saved !== 1 ? 's' : '') + ' saved' + shopifyNote + (failed > 0 ? ' (' + failed + ' failed)' : '') + '.';
        banner.style.display = '';
        setTimeout(() => { banner.style.display = 'none'; }, 4000);

        document.getElementById('snap-status').textContent = 'Done! Snap more items.';
      } catch (err) {
        alert('Save failed: ' + err.message);
      } finally {
        updateCounts();
      }
    }

    renderEmpty();
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Inventory browse page
// ---------------------------------------------------------------------------

function getInventoryPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <title>Inventory - Snap & Sell</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, system-ui, sans-serif;
      background: #111; color: #eee;
      min-height: 100dvh;
    }
    .header {
      padding: 12px 16px;
      background: #1a1a1a;
      border-bottom: 1px solid #333;
      position: sticky; top: 0; z-index: 10;
    }
    .header h1 { font-size: 18px; font-weight: 600; margin-bottom: 8px; }
    .header-nav { display: flex; gap: 8px; margin-bottom: 8px; }
    .header-nav a {
      color: #60a5fa; text-decoration: none; font-size: 13px;
      padding: 4px 8px; background: #222; border-radius: 4px;
    }
    .header-nav a.active { background: #2563eb; color: white; }
    .search-row { display: flex; gap: 8px; }
    .search-row input {
      flex: 1; padding: 10px; font-size: 16px;
      background: #222; border: 1px solid #444; border-radius: 6px;
      color: #eee; outline: none;
    }
    .search-row input:focus { border-color: #2563eb; }
    .search-row select {
      padding: 10px; font-size: 14px;
      background: #222; border: 1px solid #444; border-radius: 6px;
      color: #eee;
    }
    .filter-row {
      display: flex; gap: 8px; margin-top: 8px; align-items: center;
    }
    .filter-row label { font-size: 13px; color: #aaa; display: flex; align-items: center; gap: 4px; }
    .filter-row input[type="checkbox"] { width: 18px; height: 18px; }

    .list { padding: 8px; }
    .item {
      display: flex; gap: 12px; padding: 12px;
      background: #1a1a1a; border: 1px solid #333;
      border-radius: 8px; margin-bottom: 8px;
      cursor: pointer; transition: border-color 0.15s;
    }
    .item:active { border-color: #2563eb; }
    .item.has-photo { border-left: 3px solid #4ade80; }
    .item-thumb {
      width: 60px; height: 60px; border-radius: 6px;
      background: #333; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      font-size: 24px; color: #666; overflow: hidden;
    }
    .item-thumb img { width: 100%; height: 100%; object-fit: cover; }
    .item-info { flex: 1; min-width: 0; }
    .item-title { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .item-meta { font-size: 12px; color: #888; margin-top: 2px; }
    .item-price { font-size: 14px; color: #4ade80; font-weight: 600; margin-top: 4px; }
    .item-nophoto { font-size: 11px; color: #f59e0b; margin-top: 2px; }

    .loading { text-align: center; padding: 40px; color: #888; }
    .load-more {
      display: block; width: 100%; padding: 14px;
      background: #222; border: 1px solid #444; border-radius: 8px;
      color: #eee; font-size: 14px; cursor: pointer; margin: 8px;
    }

    /* Photo modal */
    .modal-overlay {
      display: none; position: fixed; inset: 0;
      background: rgba(0,0,0,0.85); z-index: 20;
      flex-direction: column; align-items: center; justify-content: center;
      padding: 20px;
    }
    .modal-overlay.active { display: flex; }
    .modal-card {
      background: #1a1a1a; border-radius: 12px;
      padding: 20px; width: 100%; max-width: 400px;
    }
    .modal-card h2 { font-size: 16px; margin-bottom: 4px; }
    .modal-card .detail { font-size: 13px; color: #aaa; margin-bottom: 12px; }
    .modal-card .snap-btn {
      width: 100%; padding: 16px; border: none; border-radius: 8px;
      background: #2563eb; color: white; font-size: 16px;
      font-weight: 600; cursor: pointer;
    }
    .modal-card .snap-btn:active { background: #1d4ed8; }
    .modal-card .cancel-btn {
      width: 100%; padding: 12px; border: none; border-radius: 8px;
      background: #333; color: #eee; font-size: 14px;
      cursor: pointer; margin-top: 8px;
    }
    .modal-card .success {
      background: #16a34a; color: white; padding: 12px;
      border-radius: 8px; text-align: center; font-weight: 600;
      margin-top: 12px;
    }
    .modal-preview {
      width: 100%; max-height: 200px; object-fit: contain;
      border-radius: 8px; background: #000; margin-bottom: 12px;
    }
    input.modal-file { display: none; }
    .count-bar {
      padding: 8px 16px; font-size: 12px; color: #888;
      display: flex; justify-content: space-between;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-nav">
      <a href="/">Snap New</a>
      <a href="/inventory" class="active">Inventory</a>
    </div>
    <h1>Inventory</h1>
    <div class="search-row">
      <input type="text" id="search" placeholder="Search items...">
      <select id="category-filter">
        <option value="">All</option>
        <option value="trading_card">Cards</option>
        <option value="video_game">Games</option>
        <option value="console_hardware">Consoles</option>
        <option value="accessory">Accessories</option>
        <option value="coin">Coins</option>
        <option value="comic">Comics</option>
        <option value="toy">Toys</option>
        <option value="misc">Misc</option>
      </select>
    </div>
    <div class="filter-row">
      <label><input type="checkbox" id="no-photo-filter"> Needs photo</label>
    </div>
  </div>

  <div class="count-bar">
    <span id="count-text">Loading...</span>
    <span id="photo-count"></span>
  </div>

  <div class="list" id="item-list"></div>
  <button class="load-more" id="load-more" style="display:none">Load more</button>
  <div class="loading" id="loading">Loading...</div>

  <!-- Photo attach modal -->
  <div class="modal-overlay" id="modal">
    <div class="modal-card" style="max-height:90vh;overflow-y:auto;">
      <h2 id="modal-title"></h2>
      <div class="detail" id="modal-detail"></div>
      <img class="modal-preview" id="modal-preview" style="display:none">

      <!-- Edit form -->
      <div style="margin:12px 0;padding-top:12px;border-top:1px solid #333;">
        <div style="font-size:12px;color:#888;margin-bottom:6px;">Edit</div>
        <div style="display:flex;gap:6px;margin-bottom:6px;">
          <input id="edit-price" type="number" step="0.01" inputmode="decimal" placeholder="Price $"
            style="flex:1;padding:8px;font-size:14px;background:#222;border:1px solid #444;border-radius:6px;color:#eee;">
          <input id="edit-qty" type="number" inputmode="numeric" placeholder="Qty"
            style="width:70px;padding:8px;font-size:14px;background:#222;border:1px solid #444;border-radius:6px;color:#eee;">
        </div>
        <select id="edit-condition"
          style="width:100%;padding:8px;font-size:14px;background:#222;border:1px solid #444;border-radius:6px;color:#eee;margin-bottom:6px;">
          <option value="">Condition...</option>
          <option value="loose">Loose</option>
          <option value="good">Good</option>
          <option value="very_good">Very Good</option>
          <option value="cib">CIB</option>
          <option value="new_sealed">New/Sealed</option>
          <option value="graded">Graded</option>
        </select>
        <select id="edit-status"
          style="width:100%;padding:8px;font-size:14px;background:#222;border:1px solid #444;border-radius:6px;color:#eee;margin-bottom:6px;">
          <option value="in_stock">In Stock</option>
          <option value="listed_shopify">Listed Shopify</option>
          <option value="listed_ebay">Listed eBay</option>
          <option value="listed_multi">Listed Multi</option>
          <option value="sold">Sold</option>
          <option value="personal_collection">Personal</option>
        </select>
        <div id="grading-row" style="display:none;gap:6px;margin-bottom:6px;">
          <select id="edit-grading-company"
            style="flex:1;padding:8px;font-size:14px;background:#222;border:1px solid #444;border-radius:6px;color:#eee;">
            <option value="">Grader...</option>
            <option value="PSA">PSA</option>
            <option value="BGS">BGS</option>
            <option value="CGC">CGC</option>
            <option value="SGC">SGC</option>
          </select>
          <input id="edit-grade" type="number" step="0.5" inputmode="decimal" placeholder="Grade"
            style="width:90px;padding:8px;font-size:14px;background:#222;border:1px solid #444;border-radius:6px;color:#eee;">
        </div>
        <input id="edit-notes" type="text" placeholder="Notes / purchase info"
          style="width:100%;padding:8px;font-size:14px;background:#222;border:1px solid #444;border-radius:6px;color:#eee;margin-bottom:6px;">
        <button class="snap-btn" id="modal-refresh-price"
          style="background:#2563eb;margin-bottom:6px;">Get Latest PC Price</button>
        <div id="pc-price-breakdown" style="display:none;font-size:12px;color:#aaa;margin-bottom:8px;padding:8px;background:#222;border-radius:6px;"></div>
        <button class="snap-btn" id="modal-save" style="background:#16a34a;">Save Changes</button>
      </div>

      <button class="snap-btn" id="modal-snap">Take Photo</button>
      <input type="file" class="modal-file" id="modal-file" accept="image/*" capture="environment">
      <div id="modal-success" style="display:none"></div>
      <button class="cancel-btn" id="modal-cancel">Cancel</button>
      <button class="cancel-btn" id="modal-delete" style="background:#dc2626;color:white;margin-top:4px;">Delete Item</button>
    </div>
  </div>

  <script>
    let currentPage = 1;
    let allProducts = [];
    let searchTimeout = null;
    let selectedProductId = null;
    // Track which products have photos (loaded per page)
    const photoStatus = {};

    const list = document.getElementById('item-list');
    const loading = document.getElementById('loading');
    const loadMore = document.getElementById('load-more');
    const countText = document.getElementById('count-text');

    async function loadProducts(page, append) {
      if (!append) {
        list.innerHTML = '';
        loading.style.display = '';
      }

      const q = document.getElementById('search').value;
      const cat = document.getElementById('category-filter').value;
      const noPhoto = document.getElementById('no-photo-filter').checked ? '1' : '0';

      const params = new URLSearchParams({ page: String(page), q, category: cat, no_photo: noPhoto });
      const resp = await fetch('/api/inventory?' + params);
      const data = await resp.json();

      loading.style.display = 'none';

      if (!append) allProducts = [];
      allProducts = allProducts.concat(data.products);

      // Check which products have images
      if (data.products.length > 0) {
        const ids = data.products.map(p => p.id);
        const imgResp = await fetch('/api/product-images?ids=' + ids.join(','));
        const imgData = await imgResp.json();
        for (const [id, urls] of Object.entries(imgData)) {
          photoStatus[id] = urls;
        }
      }

      for (const p of data.products) {
        const hasPhoto = photoStatus[p.id] && photoStatus[p.id].length > 0;
        const imgUrl = hasPhoto ? photoStatus[p.id][0] : null;
        const price = p.current_price || p.market_price;

        const item = document.createElement('div');
        item.className = 'item' + (hasPhoto ? ' has-photo' : '');
        item.innerHTML =
          '<div class="item-thumb">' +
            (imgUrl ? '<img src="' + imgUrl + '">' : '?') +
          '</div>' +
          '<div class="item-info">' +
            '<div class="item-title">' + escHtml(p.title) + '</div>' +
            '<div class="item-meta">' + p.category.replace('_', ' ') + (p.condition ? ' | ' + p.condition.replace('_', ' ') : '') + '</div>' +
            (price ? '<div class="item-price">$' + (price / 100).toFixed(2) + '</div>' : '') +
            (!hasPhoto ? '<div class="item-nophoto">No photo</div>' : '') +
          '</div>';

        item.onclick = () => openModal(p, imgUrl);
        list.appendChild(item);
      }

      const shown = allProducts.length;
      const total = data.total ?? shown;
      countText.textContent = shown + ' of ' + total + ' items';

      loadMore.style.display = shown < total ? '' : 'none';
    }

    function escHtml(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // Search debounce
    document.getElementById('search').oninput = () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => { currentPage = 1; loadProducts(1, false); }, 300);
    };
    document.getElementById('category-filter').onchange = () => { currentPage = 1; loadProducts(1, false); };
    document.getElementById('no-photo-filter').onchange = () => { currentPage = 1; loadProducts(1, false); };
    loadMore.onclick = () => { currentPage++; loadProducts(currentPage, true); };

    // Modal
    function openModal(product, existingImg) {
      selectedProductId = product.id;
      document.getElementById('modal-title').textContent = product.title;
      const price = product.current_price || product.market_price;
      document.getElementById('modal-detail').textContent =
        product.category.replace('_', ' ') +
        (price ? ' | $' + (price / 100).toFixed(2) : '');

      const preview = document.getElementById('modal-preview');
      if (existingImg) {
        preview.src = existingImg;
        preview.style.display = '';
      } else {
        preview.style.display = 'none';
      }

      // Pre-fill edit form
      document.getElementById('edit-price').value = product.current_price ? (product.current_price / 100).toFixed(2) : '';
      document.getElementById('edit-qty').value = product.quantity ?? 1;
      document.getElementById('edit-condition').value = product.condition ?? '';
      document.getElementById('edit-status').value = product.inventory_status ?? 'in_stock';
      document.getElementById('edit-notes').value = product.purchase_notes ?? '';
      document.getElementById('edit-grading-company').value = product.grading_company ?? '';
      document.getElementById('edit-grade').value = product.graded_score ?? '';

      const gradingRow = document.getElementById('grading-row');
      gradingRow.style.display = product.condition === 'graded' ? 'flex' : 'none';

      document.getElementById('modal-success').style.display = 'none';
      document.getElementById('modal-snap').textContent = existingImg ? 'Replace Photo' : 'Take Photo';
      document.getElementById('modal-save').textContent = 'Save Changes';
      document.getElementById('modal-save').disabled = false;
      document.getElementById('pc-price-breakdown').style.display = 'none';

      // Disable refresh if there's no PC id on this product
      const refreshBtn = document.getElementById('modal-refresh-price');
      if (product.pricecharting_id) {
        refreshBtn.disabled = false;
        refreshBtn.title = '';
        refreshBtn.style.opacity = '1';
      } else {
        refreshBtn.disabled = true;
        refreshBtn.title = 'No PriceCharting ID on this item';
        refreshBtn.style.opacity = '0.5';
      }
      document.getElementById('modal').classList.add('active');
    }

    // Show grading fields only when condition is graded
    document.getElementById('edit-condition').onchange = (e) => {
      document.getElementById('grading-row').style.display = e.target.value === 'graded' ? 'flex' : 'none';
    };

    document.getElementById('modal-refresh-price').onclick = async () => {
      if (!selectedProductId) return;
      const btn = document.getElementById('modal-refresh-price');
      const breakdown = document.getElementById('pc-price-breakdown');
      btn.textContent = 'Fetching from PriceCharting...';
      btn.disabled = true;

      try {
        const resp = await fetch('/api/product/' + selectedProductId + '/refresh-price', { method: 'POST' });
        const r = await resp.json();

        if (r.error) {
          breakdown.style.display = '';
          breakdown.style.color = '#f87171';
          breakdown.textContent = r.error;
          return;
        }

        // Fill price field with the suggested price (matches condition)
        if (r.suggested_cents > 0) {
          document.getElementById('edit-price').value = (r.suggested_cents / 100).toFixed(2);
        }

        const fmt = c => c > 0 ? '$' + (c / 100).toFixed(2) : '-';
        breakdown.style.color = '#aaa';
        breakdown.innerHTML =
          '<strong style="color:#4ade80;">Updated to ' + fmt(r.suggested_cents) + '</strong> (avg ' + fmt(r.average_cents) + ')<br>' +
          'Loose: ' + fmt(r.loose_cents) + ' | CIB: ' + fmt(r.cib_cents) + ' | New: ' + fmt(r.new_cents) + ' | Graded: ' + fmt(r.graded_cents);
        breakdown.style.display = '';
      } catch (err) {
        breakdown.style.display = '';
        breakdown.style.color = '#f87171';
        breakdown.textContent = 'Error: ' + err.message;
      } finally {
        btn.textContent = 'Get Latest PC Price';
        btn.disabled = false;
      }
    };

    document.getElementById('modal-save').onclick = async () => {
      if (!selectedProductId) return;

      const btn = document.getElementById('modal-save');
      btn.textContent = 'Saving...';
      btn.disabled = true;

      const priceStr = document.getElementById('edit-price').value;
      const priceCents = priceStr ? Math.round(parseFloat(priceStr) * 100) : null;
      const gradeStr = document.getElementById('edit-grade').value;
      const condition = document.getElementById('edit-condition').value;

      const body = {
        current_price: priceCents,
        quantity: parseInt(document.getElementById('edit-qty').value) || 1,
        condition: condition || null,
        inventory_status: document.getElementById('edit-status').value,
        purchase_notes: document.getElementById('edit-notes').value || null,
        grading_company: condition === 'graded' ? (document.getElementById('edit-grading-company').value || null) : null,
        graded_score: condition === 'graded' && gradeStr ? parseFloat(gradeStr) : null,
      };

      try {
        const resp = await fetch('/api/product/' + selectedProductId, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const result = await resp.json();

        if (result.error) {
          alert('Save failed: ' + result.error);
        } else {
          document.getElementById('modal-success').innerHTML = '<div class="success">Saved</div>';
          document.getElementById('modal-success').style.display = '';
          setTimeout(() => {
            document.getElementById('modal').classList.remove('active');
            currentPage = 1;
            loadProducts(1, false);
          }, 900);
        }
      } catch (err) {
        alert('Error: ' + err.message);
      } finally {
        btn.textContent = 'Save Changes';
        btn.disabled = false;
      }
    };

    document.getElementById('modal-cancel').onclick = () => {
      document.getElementById('modal').classList.remove('active');
    };

    document.getElementById('modal-delete').onclick = async () => {
      if (!selectedProductId) return;
      if (!confirm('Delete this item from inventory? This cannot be undone.')) return;

      document.getElementById('modal-delete').textContent = 'Deleting...';
      document.getElementById('modal-delete').disabled = true;

      try {
        const resp = await fetch('/api/product/' + selectedProductId, { method: 'DELETE' });
        const result = await resp.json();

        if (result.error) {
          alert('Delete failed: ' + result.error);
        } else {
          document.getElementById('modal').classList.remove('active');
          currentPage = 1;
          loadProducts(1, false);
        }
      } catch (err) {
        alert('Error: ' + err.message);
      } finally {
        document.getElementById('modal-delete').textContent = 'Delete Item';
        document.getElementById('modal-delete').disabled = false;
      }
    };

    document.getElementById('modal-snap').onclick = () => {
      document.getElementById('modal-file').click();
    };

    document.getElementById('modal-file').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file || !selectedProductId) return;

      document.getElementById('modal-snap').textContent = 'Uploading...';
      document.getElementById('modal-snap').disabled = true;

      const formData = new FormData();
      formData.append('photo', file);

      try {
        const resp = await fetch('/api/attach-photo?product_id=' + selectedProductId, {
          method: 'POST',
          body: formData,
        });
        const result = await resp.json();

        if (result.error) {
          alert('Failed: ' + result.error);
        } else {
          // Update preview + photo cache; leave modal open so edits can still be saved
          const preview = document.getElementById('modal-preview');
          preview.src = result.image_url + '?t=' + Date.now();
          preview.style.display = '';

          document.getElementById('modal-success').innerHTML =
            '<div class="success">Photo attached. Don\\'t forget to Save Changes if you edited fields.</div>';
          document.getElementById('modal-success').style.display = '';

          photoStatus[selectedProductId] = [result.image_url];
        }
      } catch (err) {
        alert('Error: ' + err.message);
      } finally {
        document.getElementById('modal-snap').textContent = 'Replace Photo';
        document.getElementById('modal-snap').disabled = false;
        e.target.value = '';
      }
    };

    // Initial load
    loadProducts(1, false);
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

  // API: get image URLs for a batch of product IDs
  if (url.startsWith("/api/product-images") && req.method === "GET") {
    try {
      const params = new URL(url, `http://localhost:${PORT}`).searchParams;
      const ids = (params.get("ids") ?? "").split(",").filter(Boolean);

      if (ids.length === 0) {
        sendJson(res, 200, {});
        return;
      }

      const { data: images } = await supabase
        .from("product_images")
        .select("product_id, url")
        .in("product_id", ids)
        .order("is_primary", { ascending: false });

      const result: Record<string, string[]> = {};
      for (const img of images ?? []) {
        if (img.url) {
          if (!result[img.product_id]) result[img.product_id] = [];
          result[img.product_id].push(img.url);
        }
      }

      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : "Unknown error" });
    }
    return;
  }

  // Inventory browse page
  if (url === "/inventory" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(getInventoryPage());
    return;
  }

  // API: list inventory (with optional search, filter by no-photo)
  if (url.startsWith("/api/inventory") && req.method === "GET") {
    try {
      const params = new URL(url, `http://localhost:${PORT}`).searchParams;
      const search = params.get("q") ?? "";
      const noPhoto = params.get("no_photo") === "1";
      const category = params.get("category") ?? "";
      const page = parseInt(params.get("page") ?? "1", 10);
      const limit = 30;
      const offset = (page - 1) * limit;

      let query = supabase
        .from("products")
        .select("id, title, category, condition, inventory_status, current_price, market_price, quantity, metadata, pricecharting_id, purchase_notes, grading_company, graded_score", { count: "exact" });

      if (search) {
        query = query.ilike("title", `%${search}%`);
      }
      if (category) {
        query = query.eq("category", category);
      }

      query = query.order("title").range(offset, offset + limit - 1);

      const { data: products, count, error } = await query;

      if (error) {
        sendJson(res, 500, { error: error.message });
        return;
      }

      // If filtering for no-photo, check which products have images
      let filtered = products ?? [];
      if (noPhoto && filtered.length > 0) {
        const ids = filtered.map((p: { id: string }) => p.id);
        const { data: images } = await supabase
          .from("product_images")
          .select("product_id")
          .in("product_id", ids);

        const hasImage = new Set((images ?? []).map((i: { product_id: string }) => i.product_id));
        filtered = filtered.filter((p: { id: string }) => !hasImage.has(p.id));
      }

      sendJson(res, 200, { products: filtered, total: count, page, limit });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : "Unknown error" });
    }
    return;
  }

  // API: attach photo to existing product
  if (url.startsWith("/api/attach-photo") && req.method === "POST") {
    try {
      const body = await readBody(req);
      const contentType = req.headers["content-type"] ?? "";
      const file = parseMultipart(body, contentType);

      if (!file || file.data.length === 0) {
        sendJson(res, 400, { error: "No image received" });
        return;
      }

      // Product ID is in the filename convention: {productId}_photo.jpg
      // Or passed as a query param
      const urlObj = new URL(req.url ?? "/", `http://localhost:${PORT}`);
      const productId = urlObj.searchParams.get("product_id");

      if (!productId) {
        sendJson(res, 400, { error: "product_id query param required" });
        return;
      }

      // Verify product exists
      const { data: product } = await supabase
        .from("products")
        .select("id, title")
        .eq("id", productId)
        .single();

      if (!product) {
        sendJson(res, 404, { error: "Product not found" });
        return;
      }

      // Save file locally
      if (!existsSync(INBOX_DIR)) {
        mkdirSync(INBOX_DIR, { recursive: true });
      }
      const safeName = file.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = join(INBOX_DIR, `${Date.now()}-${safeName}`);
      writeFileSync(filePath, file.data);

      // Upload to Supabase Storage
      const ext = extname(filePath).toLowerCase();
      const ct =
        ext === ".png" ? "image/png" :
        ext === ".webp" ? "image/webp" :
        "image/jpeg";
      const storagePath = `products/${productId}/${Date.now()}-${safeName}`;

      const { error: uploadError } = await supabase.storage
        .from("product-images")
        .upload(storagePath, file.data, { contentType: ct, upsert: true });

      if (uploadError) {
        sendJson(res, 500, { error: `Upload failed: ${uploadError.message}` });
        return;
      }

      const { data: urlData } = supabase.storage
        .from("product-images")
        .getPublicUrl(storagePath);

      // Replace existing primary image if there is one
      const { data: existingImages } = await supabase
        .from("product_images")
        .select("id, storage_path")
        .eq("product_id", productId)
        .eq("is_primary", true);

      if (existingImages && existingImages.length > 0) {
        // Remove old images from storage
        const oldPaths = existingImages
          .map((i: { storage_path: string | null }) => i.storage_path)
          .filter(Boolean) as string[];
        if (oldPaths.length > 0) {
          await supabase.storage.from("product-images").remove(oldPaths);
        }
        // Delete old image records
        const oldIds = existingImages.map((i: { id: string }) => i.id);
        await supabase.from("product_images").delete().in("id", oldIds);
      }

      const isPrimary = true;

      await supabase.from("product_images").insert({
        product_id: productId,
        storage_path: storagePath,
        url: urlData.publicUrl,
        is_primary: isPrimary,
      });

      console.log(`  Photo attached to: ${product.title}`);
      console.log(`  URL: ${urlData.publicUrl}`);

      sendJson(res, 200, {
        product_id: productId,
        image_url: urlData.publicUrl,
        is_primary: isPrimary,
      });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : "Unknown error" });
    }
    return;
  }

  // Refresh PriceCharting prices for a product
  if (/^\/api\/product\/[^/]+\/refresh-price$/.test(url) && req.method === "POST") {
    try {
      const productId = decodeURIComponent(
        url.slice("/api/product/".length, url.length - "/refresh-price".length)
      );

      const { data: product, error } = await supabase
        .from("products")
        .select("id, title, pricecharting_id, condition, current_price, market_price")
        .eq("id", productId)
        .single();

      if (error || !product) {
        sendJson(res, 404, { error: "Product not found" });
        return;
      }

      if (!product.pricecharting_id) {
        sendJson(res, 400, { error: "No pricecharting_id on this product" });
        return;
      }

      const pc = await getProductById(product.pricecharting_id);
      const loose = pc["loose-price"] ?? 0;
      const cib = pc["cib-price"] ?? 0;
      const neu = pc["new-price"] ?? 0;
      const graded = pc["graded-price"] ?? 0;

      // Prices that actually have data
      const valid = [loose, cib, neu, graded].filter((p) => p > 0);
      const average = valid.length > 0 ? Math.round(valid.reduce((a, b) => a + b, 0) / valid.length) : 0;

      // Best match for this item's stored condition
      const condMap: Record<string, number> = {
        loose,
        good: loose,
        very_good: loose,
        cib,
        new_sealed: neu,
        graded: graded || neu,
      };
      const suggested = (product.condition && condMap[product.condition]) || average;

      // Record a price history entry for future reference
      if (suggested > 0) {
        await supabase.from("price_history").insert({
          product_id: product.id,
          source: "pricecharting",
          price_cents: suggested,
          condition: product.condition ?? null,
          raw_data: { loose, cib, new: neu, graded, average },
        });
      }

      console.log(`Refreshed PC price for ${product.title}: $${(suggested / 100).toFixed(2)} (avg $${(average / 100).toFixed(2)})`);

      sendJson(res, 200, {
        product_id: product.id,
        loose_cents: loose,
        cib_cents: cib,
        new_cents: neu,
        graded_cents: graded,
        average_cents: average,
        suggested_cents: suggested,
      });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : "Unknown error" });
    }
    return;
  }

  // Update editable fields on a product
  if (url.startsWith("/api/product/") && req.method === "PATCH") {
    try {
      const productId = decodeURIComponent(url.slice("/api/product/".length));
      const body = await readBody(req);
      const patch = JSON.parse(body.toString()) as Record<string, unknown>;

      // Whitelist editable fields
      const allowed = [
        "current_price",
        "market_price",
        "quantity",
        "condition",
        "inventory_status",
        "purchase_notes",
        "grading_company",
        "graded_score",
        "description",
        "title",
        "metadata",
      ];
      const update: Record<string, unknown> = {};
      for (const key of allowed) {
        if (key in patch) update[key] = patch[key];
      }

      if (Object.keys(update).length === 0) {
        sendJson(res, 400, { error: "No editable fields provided" });
        return;
      }

      const { error } = await supabase
        .from("products")
        .update(update)
        .eq("id", productId);

      if (error) {
        sendJson(res, 500, { error: error.message });
        return;
      }

      console.log(`Updated product ${productId}: ${Object.keys(update).join(", ")}`);
      sendJson(res, 200, { updated: true, product_id: productId });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : "Unknown error" });
    }
    return;
  }

  // Delete a product from Supabase (+ images from storage)
  if (url.startsWith("/api/product/") && req.method === "DELETE") {
    try {
      const productId = decodeURIComponent(url.slice("/api/product/".length));

      // Get image storage paths to clean up
      const { data: images } = await supabase
        .from("product_images")
        .select("storage_path")
        .eq("product_id", productId);

      // Delete images from storage
      if (images && images.length > 0) {
        const paths = images
          .map((i: { storage_path: string | null }) => i.storage_path)
          .filter(Boolean) as string[];
        if (paths.length > 0) {
          await supabase.storage.from("product-images").remove(paths);
        }
      }

      // Delete image records
      await supabase.from("product_images").delete().eq("product_id", productId);

      // Delete price history
      await supabase.from("price_history").delete().eq("product_id", productId);

      // Delete the product
      const { error } = await supabase.from("products").delete().eq("id", productId);

      if (error) {
        sendJson(res, 500, { error: error.message });
        return;
      }

      console.log(`Deleted product: ${productId}`);
      sendJson(res, 200, { deleted: true, product_id: productId });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : "Unknown error" });
    }
    return;
  }

  // Batch queue page
  if (url === "/batch" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(getBatchPage());
    return;
  }

  // Enqueue a photo for background identification
  if (url === "/api/queue" && req.method === "POST") {
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

      console.log(`[batch] Queued: ${safeName} (${(file.data.length / 1024).toFixed(0)}KB)`);

      const jobId = enqueuePhoto(filePath);
      sendJson(res, 200, { job_id: jobId, file_path: filePath });
    } catch (err) {
      console.error("Queue failed:", err);
      sendJson(res, 500, { error: err instanceof Error ? err.message : "Unknown error" });
    }
    return;
  }

  // Delete a job from the queue
  if (url.startsWith("/api/queue/") && req.method === "DELETE") {
    const jobId = decodeURIComponent(url.slice("/api/queue/".length));
    const deleted = jobQueue.delete(jobId);
    console.log(`[batch] Deleted job ${jobId}: ${deleted ? "ok" : "not found"}`);
    sendJson(res, deleted ? 200 : 404, { deleted });
    return;
  }

  // Get all jobs in the queue
  if (url === "/api/queue" && req.method === "GET") {
    const jobs = Array.from(jobQueue.values())
      .sort((a, b) => b.created_at - a.created_at);
    sendJson(res, 200, jobs);
    return;
  }

  // Batch save multiple items
  if (url === "/api/batch-save" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const { items } = JSON.parse(body.toString()) as { items: (SaveRequest & { job_id: string })[] };

      if (!Array.isArray(items) || items.length === 0) {
        sendJson(res, 400, { error: "No items provided" });
        return;
      }

      console.log(`[batch] Saving ${items.length} items...`);

      const results: { job_id: string; product_id?: string; shopify_product_id?: string; error?: string }[] = [];

      for (const item of items) {
        const saveReq: SaveRequest = {
          file_path: item.file_path,
          title: item.title,
          category: item.category,
          condition: item.condition,
          price_cents: item.price_cents,
          status: item.status ?? "in_stock",
          notes: item.notes,
          quantity: item.quantity ?? 1,
          pricecharting_id: item.pricecharting_id,
          market_price_cents: item.market_price_cents,
          description: item.description,
          metadata: item.metadata,
          list_on_shopify: item.list_on_shopify,
        };

        const result = await saveAndList(saveReq);

        if (!result.error) {
          const job = jobQueue.get(item.job_id);
          if (job) job.saved = true;
          console.log(`  [batch] Saved: ${item.title} (${result.product_id})`);
          if (result.shopify_product_id) {
            console.log(`  [batch] Listed on Shopify: ${result.shopify_product_id}`);
          }
        } else {
          console.error(`  [batch] Failed: ${item.title} - ${result.error}`);
        }

        results.push({ job_id: item.job_id, ...result });
      }

      sendJson(res, 200, results);
    } catch (err) {
      console.error("Batch save failed:", err);
      sendJson(res, 500, { error: err instanceof Error ? err.message : "Unknown error" });
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
