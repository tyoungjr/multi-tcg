## Stage 1: Foundation - Project Scaffold, Schema, Connectivity
**Goal**: Working project with database schema and verified Supabase connection
**Success Criteria**: `npm run build` compiles, migrations apply, `npm run dev` queries products table
**Tests**: Smoke test in src/index.ts
**Status**: Complete

## Stage 2: PriceCharting API Integration
**Goal**: Fetch and store live pricing from PriceCharting
**Success Criteria**: Look up products, fetch prices, store in price_history
**Tests**: API response parsing, price storage
**Status**: Complete

## Stage 3: Visual Search + Gap Coverage
**Goal**: Image-based identification for items PriceCharting doesn't cover
**Success Criteria**: Upload image, get identification suggestions, store results
**Tests**: Image upload, search result parsing
**Status**: Complete

## Stage 4: Shopify Sync
**Goal**: Two-way sync between inventory and Shopify store
**Success Criteria**: Push products to Shopify, pull orders/sales back
**Tests**: Product creation, inventory updates, order sync
**Status**: Complete

## Stage 5: Multi-Channel + Dashboard
**Goal**: eBay integration, unified dashboard, profit tracking
**Success Criteria**: List on eBay, see all inventory in one view, track P&L
**Tests**: eBay listing, dashboard queries, profit calculations
**Status**: Not Started
