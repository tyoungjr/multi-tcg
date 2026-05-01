// .ydk format:
//   #created by ...        <- comment / unknown directive (ignored)
//   #main                  <- begin main deck
//   12345678               <- Konami passcode (one per line; duplicates = quantity)
//   #extra                 <- begin extra deck
//   34567890
//   !side                  <- begin side deck
//   45678901
//
// Some exporters (e.g. MDPro3) append cosmetic blocks after the side deck:
//   #pickup                <- NOT a real deck section
//   #case
//   1080001                <- cosmetic IDs that look like passcodes
// To avoid polluting the side deck with these, ANY directive other than
// #main / #extra / !side flips the parser into ignore mode until the next
// recognized directive.

export type YdkSection = "main" | "extra" | "side";

export interface YdkParsed {
  main: string[];
  extra: string[];
  side: string[];
  // Diagnostic — every directive seen that wasn't #main/#extra/!side, in order.
  // Lets the caller surface "we saw 16 unknown directives, here they are."
  unknownDirectives: string[];
}

export interface YdkCount {
  main: number;
  extra: number;
  side: number;
  total: number;
}

export interface YdkSectionGrouped {
  passcode: string;
  quantity: number;
}

export interface YdkGrouped {
  main: YdkSectionGrouped[];
  extra: YdkSectionGrouped[];
  side: YdkSectionGrouped[];
}

const IGNORE: unique symbol = Symbol("ignore");
type ParseState = YdkSection | typeof IGNORE;

export function parseYdk(text: string): YdkParsed {
  const result: YdkParsed = { main: [], extra: [], side: [], unknownDirectives: [] };
  // Default to main so files that omit a leading `#main` still parse cards;
  // a leading `#created by ...` will flip us to ignore until #main appears.
  let state: ParseState = "main";

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;

    if (line.startsWith("#")) {
      const tag = line.slice(1).toLowerCase().split(/\s+/)[0];
      if (tag === "main") state = "main";
      else if (tag === "extra") state = "extra";
      else {
        state = IGNORE;
        result.unknownDirectives.push(line);
      }
      continue;
    }
    if (line.startsWith("!")) {
      const tag = line.slice(1).toLowerCase().split(/\s+/)[0];
      if (tag === "side") state = "side";
      else {
        state = IGNORE;
        result.unknownDirectives.push(line);
      }
      continue;
    }

    if (state === IGNORE) continue;

    // Real passcodes are 7-8 digits but we accept any all-digit line within
    // a recognized section. Non-digit lines inside a section are skipped.
    const passcode = line.split(/\s+/)[0];
    if (!/^\d+$/.test(passcode)) continue;

    result[state].push(passcode);
  }

  return result;
}

export function countYdk(parsed: YdkParsed): YdkCount {
  return {
    main: parsed.main.length,
    extra: parsed.extra.length,
    side: parsed.side.length,
    total: parsed.main.length + parsed.extra.length + parsed.side.length,
  };
}

// Collapse duplicates into { passcode, quantity }, preserving order of first appearance.
export function groupYdk(parsed: YdkParsed): YdkGrouped {
  return {
    main: groupSection(parsed.main),
    extra: groupSection(parsed.extra),
    side: groupSection(parsed.side),
  };
}

function groupSection(passcodes: string[]): YdkSectionGrouped[] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const p of passcodes) {
    if (!counts.has(p)) order.push(p);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return order.map((passcode) => ({ passcode, quantity: counts.get(passcode) ?? 1 }));
}

// All distinct passcodes across all sections — useful for batch API lookup.
export function uniquePasscodes(parsed: YdkParsed): string[] {
  const seen = new Set<string>();
  for (const section of [parsed.main, parsed.extra, parsed.side]) {
    for (const p of section) seen.add(p);
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// ydke:// URI support
//
// Format used by YGOPRODeck, YGO Omega, etc:
//   ydke://<base64-main>!<base64-extra>!<base64-side>!
// Each base64 section decodes to a packed array of little-endian uint32
// passcodes (4 bytes per card).
// ---------------------------------------------------------------------------

export function parseYdke(uri: string): YdkParsed {
  if (!uri.startsWith("ydke://")) {
    throw new Error("Expected a ydke:// URI");
  }
  const body = uri.slice("ydke://".length);
  const parts = body.split("!");
  if (parts.length < 3) {
    throw new Error(
      `ydke:// URI must have 3 sections separated by '!', got ${parts.length}`
    );
  }
  return {
    main: decodePasscodeArray(parts[0]),
    extra: decodePasscodeArray(parts[1]),
    side: decodePasscodeArray(parts[2]),
    unknownDirectives: [],
  };
}

function decodePasscodeArray(b64: string): string[] {
  if (!b64) return [];
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length % 4 !== 0) {
    throw new Error(
      `ydke section is ${bytes.length} bytes; must be a multiple of 4`
    );
  }
  const passcodes: string[] = [];
  for (let i = 0; i < bytes.length; i += 4) {
    passcodes.push(String(bytes.readUInt32LE(i)));
  }
  return passcodes;
}

// Format-agnostic entry point — picks the right parser based on input shape.
// Accepts either raw .ydk text or a ydke:// URI.
export function parseDeck(input: string): YdkParsed {
  const trimmed = input.trim();
  if (trimmed.startsWith("ydke://")) {
    return parseYdke(trimmed);
  }
  return parseYdk(input);
}
