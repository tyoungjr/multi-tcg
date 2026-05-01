// Parse a .ydk, look up cards via YGOPRODeck, match against inventory,
// and either print a preview (default) or persist a bundle (--save).
//
// Usage:
//   npm run deck:import                                                 (uses fixture, dry-run)
//   npm run deck:import -- path/to/deck.ydk
//   npm run deck:import -- path/to/deck.ydk --title "Fiendsmith Yummy" --save
//   npm run deck:import -- path/to/deck.ydk --title "..." --pilot "Jose Angel Fajardo" \
//                          --source "Pittsboro WCQ Top 8" --format TCG --save
//
// Default is DRY-RUN. Pass --save to actually insert a bundle + bundle_items.

import { readFileSync, existsSync } from "fs";
import { resolve, basename } from "path";
import {
  previewBundleFromYdk,
  createBundleFromYdk,
} from "../services/bundle-service";
import type { PreviewItem } from "../services/bundle-service";

const DEFAULT_FIXTURE = "src/services/__fixtures__/sample.ydk";

interface CliArgs {
  path: string;
  title: string | null;
  game: string;
  format: string | null;
  source: string | null;
  source_url: string | null;
  pilot: string | null;
  description: string | null;
  save: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    path: DEFAULT_FIXTURE,
    title: null,
    game: "yugioh",
    format: null,
    source: null,
    source_url: null,
    pilot: null,
    description: null,
    save: false,
    verbose: false,
  };

  let positional: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--save") args.save = true;
    else if (a === "--verbose") args.verbose = true;
    else if (a === "--title") args.title = argv[++i] ?? null;
    else if (a === "--game") args.game = argv[++i] ?? "yugioh";
    else if (a === "--format") args.format = argv[++i] ?? null;
    else if (a === "--source") args.source = argv[++i] ?? null;
    else if (a === "--source-url") args.source_url = argv[++i] ?? null;
    else if (a === "--pilot") args.pilot = argv[++i] ?? null;
    else if (a === "--description") args.description = argv[++i] ?? null;
    else if (!a.startsWith("--") && positional === null) positional = a;
  }
  if (positional) args.path = positional;
  return args;
}

function fmt(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || cents === 0) return "  -  ";
  return "$" + (cents / 100).toFixed(2);
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n - 1) + "…" : s + " ".repeat(n - s.length);
}

function printItems(items: PreviewItem[]): void {
  for (const section of ["main", "extra", "side"] as const) {
    const sub = items.filter((it) => it.section === section);
    if (sub.length === 0) continue;
    const totalQty = sub.reduce((n, it) => n + it.quantity, 0);
    console.log(`${section.toUpperCase()} (${totalQty} cards, ${sub.length} unique):`);
    for (const it of sub) {
      const stockMark = it.product_id ? "[OWNED]" : "[NEED] ";
      const priceTag = it.price_source ? `(${it.price_source})` : "";
      console.log(
        `  ${stockMark} ${it.passcode.padStart(8)} x${it.quantity} ` +
          `${pad(it.card_name, 38)} ${fmt(it.unit_price_cents).padStart(8)}/ea ` +
          `${fmt(it.line_total_cents).padStart(8)} ${priceTag}`
      );
    }
    console.log("");
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const path = resolve(args.path);

  if (!existsSync(path)) {
    console.error(`File not found: ${path}`);
    process.exit(1);
  }

  const ydk = readFileSync(path, "utf8");
  const inferredTitle = args.title ?? basename(path, ".ydk");

  console.log(`Importing deck from ${path}`);
  console.log(`Mode: ${args.save ? "SAVE (will insert into Supabase)" : "DRY RUN (use --save to persist)"}`);
  console.log("");

  if (args.save) {
    const result = await createBundleFromYdk(ydk, {
      title: inferredTitle,
      kind: "deck",
      game: (args.game as "yugioh") ?? "yugioh",
      format: args.format,
      source: args.source,
      source_url: args.source_url,
      pilot: args.pilot,
      description: args.description,
    });
    printPreview(result.preview, args.verbose);
    console.log(`Saved bundle ${result.bundle_id}`);
    return;
  }

  const preview = await previewBundleFromYdk(ydk);
  printPreview(preview, args.verbose);
}

function printPreview(
  preview: Awaited<ReturnType<typeof previewBundleFromYdk>>,
  verbose: boolean
): void {
  const s = preview.summary;
  console.log(`Sections: main=${preview.parsed.main.length} extra=${preview.parsed.extra.length} side=${preview.parsed.side.length} (total ${s.total_items})`);
  console.log(`Unique cards: ${s.unique_cards}`);
  console.log(`In stock:     ${s.in_stock_items} cards / ${fmt(s.in_stock_total_cents)}`);
  console.log(`Need to source: ${s.total_items - s.in_stock_items} cards / ${fmt(s.missing_total_cents)} (est.)`);
  console.log(`Total estimate: ${fmt(s.in_stock_total_cents + s.missing_total_cents)}`);

  if (s.unresolved_passcodes.length > 0) {
    console.log("");
    console.log(`Passcodes not found in YGOPRODeck: ${s.unresolved_passcodes.length}`);
    if (verbose) for (const p of s.unresolved_passcodes) console.log(`  ${p}`);
    else console.log(`  (run with --verbose to list them)`);
  }
  if (s.unknown_directives.length > 0) {
    console.log("");
    console.log(`Unknown .ydk directives ignored: ${s.unknown_directives.length}`);
    if (verbose) for (const d of s.unknown_directives) console.log(`  ${d}`);
    else console.log(`  (run with --verbose to list them)`);
  }
  console.log("");

  printItems(preview.items);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
