import dotenv from "dotenv";
dotenv.config();

import { createServer } from "http";
import { URL } from "url";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { randomBytes, createHmac } from "crypto";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = 3456;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

const SCOPES = [
  "read_products",
  "write_products",
  "read_orders",
  "read_inventory",
  "write_inventory",
].join(",");

function getCredentials(): { clientId: string; clientSecret: string; store: string } {
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  const store = process.env.SHOPIFY_STORE;

  if (!clientId || !clientSecret || !store) {
    console.error("Missing required environment variables:");
    if (!clientId) console.error("  SHOPIFY_CLIENT_ID");
    if (!clientSecret) console.error("  SHOPIFY_CLIENT_SECRET");
    if (!store) console.error("  SHOPIFY_STORE (e.g. your-store.myshopify.com)");
    console.error("\nAdd these to your .env file from your Shopify app settings.");
    process.exit(1);
  }

  return { clientId, clientSecret, store };
}

// ---------------------------------------------------------------------------
// HMAC validation
// ---------------------------------------------------------------------------

function validateHmac(
  query: Record<string, string>,
  secret: string
): boolean {
  const hmac = query.hmac;
  if (!hmac) return false;

  const entries = Object.entries(query)
    .filter(([key]) => key !== "hmac")
    .sort(([a], [b]) => a.localeCompare(b));

  const message = entries.map(([k, v]) => `${k}=${v}`).join("&");
  const computed = createHmac("sha256", secret)
    .update(message)
    .digest("hex");

  return computed === hmac;
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

async function exchangeCodeForToken(
  store: string,
  clientId: string,
  clientSecret: string,
  code: string
): Promise<string> {
  const response = await fetch(
    `https://${store}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Token exchange failed: ${response.status} - ${body}`);
  }

  const data = (await response.json()) as { access_token: string; scope: string };
  console.log(`\n  Scopes granted: ${data.scope}`);
  return data.access_token;
}

// ---------------------------------------------------------------------------
// Save token to .env
// ---------------------------------------------------------------------------

function saveTokenToEnv(token: string): void {
  const envPath = join(process.cwd(), ".env");
  let envContent = "";

  if (existsSync(envPath)) {
    envContent = readFileSync(envPath, "utf-8");
  }

  // Replace existing token or append
  if (envContent.includes("SHOPIFY_ACCESS_TOKEN=")) {
    envContent = envContent.replace(
      /SHOPIFY_ACCESS_TOKEN=.*/,
      `SHOPIFY_ACCESS_TOKEN=${token}`
    );
  } else {
    envContent += `\nSHOPIFY_ACCESS_TOKEN=${token}\n`;
  }

  writeFileSync(envPath, envContent);
  console.log("  Token saved to .env");
}

// ---------------------------------------------------------------------------
// Auth flow
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { clientId, clientSecret, store } = getCredentials();
  const nonce = randomBytes(16).toString("hex");

  const authorizeUrl =
    `https://${store}/admin/oauth/authorize` +
    `?client_id=${clientId}` +
    `&scope=${SCOPES}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&state=${nonce}`;

  console.log("Shopify OAuth Setup\n");
  console.log("1. Open this URL in your browser:\n");
  console.log(`   ${authorizeUrl}\n`);
  console.log("2. Approve the app permissions in Shopify");
  console.log(`3. You'll be redirected to localhost:${PORT} - this script will catch it\n`);
  console.log(`Waiting for callback on http://localhost:${PORT}...`);

  // Try to open browser automatically
  try {
    const { exec } = await import("child_process");
    const cmd = process.platform === "win32" ? "start" :
      process.platform === "darwin" ? "open" : "xdg-open";
    exec(`${cmd} "${authorizeUrl}"`);
    console.log("  (Browser opened automatically)\n");
  } catch {
    console.log("  (Copy the URL above and paste in your browser)\n");
  }

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

        if (url.pathname !== "/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const query: Record<string, string> = {};
        url.searchParams.forEach((v, k) => {
          query[k] = v;
        });

        // Validate state
        if (query.state !== nonce) {
          res.writeHead(400);
          res.end("Invalid state parameter");
          console.error("  State mismatch - possible CSRF attack");
          server.close();
          reject(new Error("State mismatch"));
          return;
        }

        // Validate HMAC
        if (!validateHmac(query, clientSecret)) {
          res.writeHead(400);
          res.end("Invalid HMAC");
          console.error("  HMAC validation failed");
          server.close();
          reject(new Error("HMAC validation failed"));
          return;
        }

        const code = query.code;
        if (!code) {
          res.writeHead(400);
          res.end("No authorization code received");
          server.close();
          reject(new Error("No code"));
          return;
        }

        console.log("  Authorization code received, exchanging for token...");

        const token = await exchangeCodeForToken(
          store,
          clientId,
          clientSecret,
          code
        );

        saveTokenToEnv(token);

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <html><body style="font-family: sans-serif; text-align: center; padding: 60px;">
            <h1>Shopify Connected</h1>
            <p>Access token saved to .env. You can close this tab.</p>
          </body></html>
        `);

        console.log("\n  Shopify authenticated successfully!");
        console.log(`  Token: ${token.slice(0, 12)}...`);
        console.log("\n  You can now run:");
        console.log("    npm run shopify:push");
        console.log("    npm run shopify:orders");

        server.close();
        resolve();
      } catch (err) {
        res.writeHead(500);
        res.end("Internal error");
        server.close();
        reject(err);
      }
    });

    server.listen(PORT, () => {
      // Server ready, waiting for callback
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      console.error("\n  Timed out waiting for Shopify callback.");
      server.close();
      reject(new Error("Timeout"));
    }, 5 * 60 * 1000);
  });
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
