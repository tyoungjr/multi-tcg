import dotenv from "dotenv";
dotenv.config();

import { readFileSync } from "fs";
import { supabase } from "../lib/supabase";
import type { ProductInsert } from "../types/database";

// ---------------------------------------------------------------------------
// CSV parsing (handles quoted fields with commas)
// ---------------------------------------------------------------------------

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

interface CsvRow {
  id: string;
  productName: string;
  consoleName: string;
  priceInPennies: number;
  includeString: string;
  conditionString: string;
  sku: string;
  notes: string;
  costBasisInPennies: number;
  quantity: number;
  dateEntered: string;
  datePurchased: string;
  gradingCompany: string;
  gradingCertId: string;
  folder: string;
}

function parseCsv(filePath: string): CsvRow[] {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);

  // Skip header
  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    rows.push({
      id: fields[0] ?? "",
      productName: fields[1] ?? "",
      consoleName: fields[2] ?? "",
      priceInPennies: parseInt(fields[3] ?? "0", 10) || 0,
      includeString: fields[4] ?? "",
      conditionString: fields[5] ?? "",
      sku: fields[6] ?? "",
      notes: fields[7] ?? "",
      costBasisInPennies: parseInt(fields[8] ?? "0", 10) || 0,
      quantity: parseInt(fields[9] ?? "1", 10) || 1,
      dateEntered: fields[10] ?? "",
      datePurchased: fields[11] ?? "",
      gradingCompany: fields[12] ?? "",
      gradingCertId: fields[13] ?? "",
      folder: fields[14] ?? "",
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function mapCategory(consoleName: string): ProductInsert["category"] {
  const lower = consoleName.toLowerCase();

  if (
    lower.includes("pokemon") ||
    lower.includes("yugioh") ||
    lower.includes("yu-gi-oh") ||
    lower.includes("magic ")
  ) {
    return "trading_card";
  }

  if (lower.includes("marvel") || lower.includes("comic")) {
    return "trading_card";
  }

  if (
    lower.includes("baseball") ||
    lower.includes("basketball") ||
    lower.includes("football") ||
    lower.includes("hockey") ||
    lower.includes("soccer")
  ) {
    return "trading_card";
  }

  if (lower.includes("coin") || lower.includes("currency")) {
    return "coin";
  }

  return "video_game";
}

function mapCondition(
  includeString: string,
  conditionString: string
): ProductInsert["condition"] {
  const inc = includeString.toLowerCase();
  if (inc.startsWith("graded")) return "graded";
  if (inc.includes("new") || inc.includes("sealed")) return "new_sealed";
  if (inc.includes("cib") || inc.includes("complete")) return "cib";
  if (inc.includes("good")) return "good";
  return "loose";
}

function parseGradedScore(includeString: string): number | null {
  const match = includeString.match(/Graded\s+([\d.]+)/i);
  if (match) {
    return parseFloat(match[1]);
  }
  return null;
}

function extractCardMetadata(
  consoleName: string,
  productName: string,
  folder: string
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};

  metadata.set = consoleName;
  if (folder) metadata.folder = folder;

  // Try to extract card number from product name like "Ponyta #19"
  const cardNumMatch = productName.match(/#(\S+)/);
  if (cardNumMatch) {
    metadata.card_number = cardNumMatch[1];
  }

  // Detect special variants from product name
  if (productName.includes("[Reverse Holo]") || productName.includes("[Reverse]")) {
    metadata.variant = "reverse_holo";
  } else if (productName.includes("[Holo]")) {
    metadata.variant = "holo";
  } else if (productName.includes("[Master Ball]")) {
    metadata.variant = "master_ball";
  } else if (productName.includes("[Pokemon Day]")) {
    metadata.variant = "pokemon_day";
  }

  // Detect the TCG game from console name
  const lower = consoleName.toLowerCase();
  if (lower.includes("pokemon")) {
    metadata.game = "Pokemon";
  } else if (lower.includes("magic")) {
    metadata.game = "Magic: The Gathering";
  } else if (lower.includes("yugioh") || lower.includes("yu-gi-oh")) {
    metadata.game = "Yu-Gi-Oh!";
  } else if (lower.includes("marvel")) {
    metadata.game = "Marvel";
  } else if (
    lower.includes("baseball") ||
    lower.includes("basketball") ||
    lower.includes("football")
  ) {
    metadata.game = "Sports";
  }

  return metadata;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

async function importCsv(filePath: string, dryRun: boolean): Promise<void> {
  const rows = parseCsv(filePath);
  console.log(`Parsed ${rows.length} rows from CSV.\n`);

  // Check for existing pricecharting_ids to avoid duplicates
  const pcIds = rows.map((r) => r.id).filter(Boolean);
  const { data: existing } = await supabase
    .from("products")
    .select("pricecharting_id")
    .in("pricecharting_id", pcIds);

  const existingIds = new Set(
    (existing ?? []).map((e: { pricecharting_id: string }) => e.pricecharting_id)
  );

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  // Batch inserts for performance
  const batch: ProductInsert[] = [];
  const BATCH_SIZE = 50;

  for (const row of rows) {
    if (existingIds.has(row.id)) {
      skipped++;
      continue;
    }

    const category = mapCategory(row.consoleName);
    const condition = mapCondition(row.includeString, row.conditionString);
    const gradedScore = parseGradedScore(row.includeString);

    const metadata =
      category === "trading_card"
        ? extractCardMetadata(row.consoleName, row.productName, row.folder)
        : { console_name: row.consoleName, folder: row.folder || undefined };

    const insert: ProductInsert = {
      title: row.productName,
      category,
      condition,
      inventory_status: "personal_collection",
      pricecharting_id: row.id || undefined,
      market_price: row.priceInPennies > 0 ? row.priceInPennies : undefined,
      purchase_price:
        row.costBasisInPennies > 0 ? row.costBasisInPennies : undefined,
      purchase_date: row.datePurchased || undefined,
      purchase_notes: row.notes || undefined,
      graded_score: gradedScore ?? undefined,
      grading_company: row.gradingCompany || undefined,
      metadata,
      quantity: row.quantity,
    };

    if (dryRun) {
      const price = row.priceInPennies > 0
        ? ` @ $${(row.priceInPennies / 100).toFixed(2)}`
        : "";
      const grade = gradedScore ? ` [${row.gradingCompany || "Graded"} ${gradedScore}]` : "";
      console.log(
        `  DRY   ${row.productName} (${row.consoleName})${grade}${price} -> ${category}, ${condition}, folder="${row.folder}"`
      );
      imported++;
      continue;
    }

    batch.push(insert);

    if (batch.length >= BATCH_SIZE) {
      const { error } = await supabase.from("products").insert(batch);
      if (error) {
        console.error(`  ERR   Batch insert failed: ${error.message}`);
        errors += batch.length;
      } else {
        imported += batch.length;
        console.log(`  ADD   ${batch.length} items (${imported} total)`);
      }
      batch.length = 0;
    }
  }

  // Flush remaining batch
  if (batch.length > 0 && !dryRun) {
    const { error } = await supabase.from("products").insert(batch);
    if (error) {
      console.error(`  ERR   Final batch insert failed: ${error.message}`);
      errors += batch.length;
    } else {
      imported += batch.length;
      console.log(`  ADD   ${batch.length} items (${imported} total)`);
    }
  }

  console.log(
    `\nDone${dryRun ? " (dry run)" : ""}. ${imported} imported, ${skipped} skipped (already in DB), ${errors} errors.`
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log("Import PriceCharting CSV export into Supabase\n");
  console.log("Usage:");
  console.log("  npm run csv:import -- collection.csv              Import CSV");
  console.log("  npm run csv:import -- collection.csv --dry-run    Preview without writing");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help")) {
    printUsage();
    return;
  }

  const filePath = args.find((a) => !a.startsWith("--"));
  if (!filePath) {
    console.error("Provide a CSV file path.");
    process.exit(1);
  }

  const dryRun = args.includes("--dry-run");

  await importCsv(filePath, dryRun);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
