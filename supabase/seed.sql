-- Seed data for development/testing
INSERT INTO products (title, category, condition, inventory_status, current_price, market_price, metadata)
VALUES
  (
    'Charizard Base Set Holo',
    'trading_card',
    'good',
    'in_stock',
    35000,
    32000,
    '{"set": "Base Set", "rarity": "Holo Rare", "card_number": "4/102", "game": "Pokemon"}'::jsonb
  ),
  (
    'Super Mario 64 (CIB)',
    'video_game',
    'cib',
    'personal_collection',
    4500,
    4200,
    '{"platform": "Nintendo 64", "region": "NTSC-U"}'::jsonb
  ),
  (
    '1921 Morgan Silver Dollar',
    'coin',
    'very_good',
    'in_stock',
    3500,
    3200,
    '{"year": 1921, "mint": "Philadelphia", "denomination": "Dollar", "composition": "Silver"}'::jsonb
  ),
  (
    'Street Fighter II Champion Edition Arcade Cabinet',
    'arcade',
    'good',
    'in_stock',
    150000,
    140000,
    '{"cabinet_type": "upright", "game_title": "Street Fighter II CE", "monitor_type": "CRT", "monitor_size": "25 inch", "working": true, "manufacturer": "Capcom"}'::jsonb
  ),
  (
    'Nintendo 64 Console (Smoke Black)',
    'console_hardware',
    'loose',
    'in_stock',
    7500,
    7000,
    '{"platform": "Nintendo 64", "model": "NUS-001", "color": "Smoke Black", "region": "NTSC-U", "includes_cables": true, "includes_controller": false}'::jsonb
  ),
  (
    'GameCube WaveBird Wireless Controller',
    'accessory',
    'good',
    'in_stock',
    5500,
    5000,
    '{"platform": "GameCube", "accessory_type": "controller", "brand": "Nintendo", "color": "Grey", "wireless": true}'::jsonb
  );
