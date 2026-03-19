CREATE TYPE product_category AS ENUM (
  'trading_card',
  'video_game',
  'console_hardware',
  'accessory',
  'arcade',
  'coin',
  'comic',
  'toy',
  'apparel',
  'electronics',
  'promotional',
  'misc'
);

CREATE TYPE product_condition AS ENUM (
  'loose',
  'good',
  'very_good',
  'cib',
  'new_sealed',
  'graded'
);

CREATE TYPE inventory_status AS ENUM (
  'in_stock',
  'listed_shopify',
  'listed_ebay',
  'listed_multi',
  'sold',
  'personal_collection'
);

CREATE TYPE price_source AS ENUM (
  'pricecharting',
  'ebay_sold',
  'manual',
  'visual_search',
  'shopify_sale'
);
