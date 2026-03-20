export interface TradingCardMetadata {
  game?: string;
  set?: string;
  rarity?: string;
  card_number?: string;
  edition?: string;
  language?: string;
  foil?: boolean;
  psa_grade?: number;
  psa_cert_number?: string;
  bgs_grade?: number;
  bgs_subgrades?: {
    centering?: number;
    corners?: number;
    edges?: number;
    surface?: number;
  };
  cgc_grade?: number;
  grading_label?: string;
}

export interface VideoGameMetadata {
  platform?: string;
  region?: string;
  publisher?: string;
  genre?: string;
  release_year?: number;
  manual_included?: boolean;
  box_included?: boolean;
}

export interface ConsoleHardwareMetadata {
  platform?: string;
  model?: string;
  region?: string;
  color?: string;
  storage_size?: string;
  modded?: boolean;
  mod_details?: string;
  includes_cables?: boolean;
  includes_controller?: boolean;
}

export interface AccessoryMetadata {
  platform?: string;
  accessory_type?: string;
  color?: string;
  brand?: string;
  compatible_with?: string[];
  wireless?: boolean;
}

export interface ArcadeMetadata {
  cabinet_type?: string;
  game_title?: string;
  board_type?: string;
  monitor_type?: string;
  monitor_size?: string;
  working?: boolean;
  parts_only?: boolean;
  conversion?: boolean;
  manufacturer?: string;
}

export interface CoinMetadata {
  year?: number;
  mint?: string;
  denomination?: string;
  composition?: string;
  country?: string;
  variety?: string;
}

export interface ComicMetadata {
  publisher?: string;
  series?: string;
  issue_number?: string;
  year?: number;
  writer?: string;
  artist?: string;
  variant_cover?: boolean;
  first_appearance?: string;
}

export interface ToyMetadata {
  brand?: string;
  line?: string;
  character?: string;
  year?: number;
  scale?: string;
  in_package?: boolean;
}

export interface ApparelMetadata {
  size?: string;
  color?: string;
  brand?: string;
  garment_type?: string;
  franchise?: string;
  year?: number;
}

export interface ElectronicsMetadata {
  component_type?: string;
  brand?: string;
  model?: string;
  working?: boolean;
  voltage?: string;
  compatible_with?: string[];
}

export interface PromotionalMetadata {
  brand?: string;
  event?: string;
  year?: number;
  limited_edition?: boolean;
  edition_size?: number;
}

export type CategoryMetadata =
  | TradingCardMetadata
  | VideoGameMetadata
  | ConsoleHardwareMetadata
  | AccessoryMetadata
  | ArcadeMetadata
  | CoinMetadata
  | ComicMetadata
  | ToyMetadata
  | ApparelMetadata
  | ElectronicsMetadata
  | PromotionalMetadata
  | Record<string, unknown>;
