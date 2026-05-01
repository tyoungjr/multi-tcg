// Parse a .ydk file and print what we extracted. No network calls.
// Usage:
//   npm run deck:inspect                                    # uses bundled fixture
//   npm run deck:inspect -- path/to/deck.ydk
//   npm run deck:inspect -- path/to/deck.ydk --verbose      # also list unknown directives

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { parseDeck, countYdk, groupYdk } from "../services/ydk-parser";

const DEFAULT_FIXTURE = "src/services/__fixtures__/sample.ydk";

function main(): void {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose");
  const pathArg = args.find((a) => !a.startsWith("--"));
  const path = resolve(pathArg ?? DEFAULT_FIXTURE);

  if (!existsSync(path)) {
    console.error(`File not found: ${path}`);
    process.exit(1);
  }

  const text = readFileSync(path, "utf8");
  const parsed = parseDeck(text);
  const counts = countYdk(parsed);
  const grouped = groupYdk(parsed);

  console.log(`Parsed ${path}`);
  console.log("");
  console.log(`Sections:`);
  console.log(`  main:  ${counts.main.toString().padStart(3)} cards (${grouped.main.length} unique)`);
  console.log(`  extra: ${counts.extra.toString().padStart(3)} cards (${grouped.extra.length} unique)`);
  console.log(`  side:  ${counts.side.toString().padStart(3)} cards (${grouped.side.length} unique)`);
  console.log(`  total: ${counts.total.toString().padStart(3)} cards`);
  console.log("");

  if (parsed.unknownDirectives.length > 0) {
    console.log(`Unknown directives ignored: ${parsed.unknownDirectives.length}`);
    if (verbose) {
      for (const d of parsed.unknownDirectives) console.log(`  ${d}`);
    } else {
      console.log(`  (run with --verbose to list them)`);
    }
    console.log("");
  }

  printSection("Main", grouped.main);
  printSection("Extra", grouped.extra);
  printSection("Side", grouped.side);
}

function printSection(label: string, items: { passcode: string; quantity: number }[]): void {
  if (items.length === 0) return;
  console.log(`${label} (${items.reduce((n, it) => n + it.quantity, 0)} cards):`);
  for (const it of items) {
    console.log(`  ${it.passcode.padStart(8)} x${it.quantity}`);
  }
  console.log("");
}

main();
