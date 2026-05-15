#!/bin/bash
# First-time setup for a fresh clone. Idempotent — safe to re-run.
# Verifies prerequisites, installs deps, scaffolds .env, and walks the user
# through the remaining manual steps (Supabase link, Shopify OAuth).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

echo "==> Checking Node version..."
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not installed. Install Node 20+ first." >&2
  echo "       macOS: brew install node@20  (or 'nvm install 20')" >&2
  exit 1
fi
NODE_VERSION="$(node -v | sed 's/v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "ERROR: Node 20+ required, got v$NODE_VERSION" >&2
  exit 1
fi
echo "    Node v$NODE_VERSION OK"

# macOS only: sharp's native build path needs Xcode Command Line Tools.
# Prebuilt binaries usually cover this, but if npm install hits a node-gyp
# error, this is the fix.
if [ "$(uname)" = "Darwin" ]; then
  if ! xcode-select -p >/dev/null 2>&1; then
    echo "==> Installing Xcode Command Line Tools (one-time, needed by sharp's fallback build)..."
    xcode-select --install || true
    echo "    Re-run scripts/setup.sh after the GUI installer finishes."
    exit 1
  fi
fi

echo "==> Installing npm dependencies..."
npm install

if [ ! -f .env ]; then
  echo "==> Scaffolding .env from .env.example..."
  cp .env.example .env
  ENV_NEEDS_FILL=1
else
  ENV_NEEDS_FILL=0
fi

# Supabase CLI — optional but recommended. Required for `supabase db push`.
if ! command -v supabase >/dev/null 2>&1; then
  if [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    echo "==> Installing Supabase CLI via Homebrew..."
    brew install supabase/tap/supabase
  else
    echo "==> Supabase CLI not found. Install manually:"
    echo "    https://supabase.com/docs/guides/local-development/cli/getting-started"
  fi
fi

cat <<EOF

==> Setup complete on the local side. Remaining manual steps:

EOF

if [ "$ENV_NEEDS_FILL" = "1" ]; then
  cat <<EOF
  1. Fill in .env with your API keys:
       SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
       ANTHROPIC_API_KEY
       PRICECHARTING_API_KEY (optional but recommended)
       SHOPIFY_STORE, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET
       (eBay, SerpAPI keys are optional — pipeline works without them)

EOF
fi

cat <<EOF
  2. Link your Supabase project and push migrations:
       supabase login
       supabase link --project-ref <your-project-ref>
       supabase db push

  3. In the Supabase dashboard, create a Storage bucket named 'product-images'
     and set it to PUBLIC (Shopify needs to fetch the image URLs).

  4. Generate a Shopify access token:
       npm run shopify:auth

  5. Try the server locally:
       npm run snap

==> For 24/7 service on a Mac mini, see deploy/README.md.
EOF
