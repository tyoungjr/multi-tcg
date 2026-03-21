import Anthropic from "@anthropic-ai/sdk";
import { processImageForVision } from "../lib/image-utils";
import type { IdentificationResult } from "../types/visual-search";

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing ANTHROPIC_API_KEY in environment. Add it to your .env file."
    );
  }
  return new Anthropic({ apiKey });
}

const IDENTIFICATION_PROMPT = `You are an expert collectibles appraiser and identifier. Analyze this image and identify the item.

Respond with ONLY valid JSON (no markdown, no code fences) in this exact structure:
{
  "title": "exact product name as it would appear in a price guide",
  "category": "trading_card | video_game | console_hardware | accessory | arcade | coin | comic | toy | apparel | electronics | promotional | misc",
  "description": "brief description of what this item is",
  "confidence": "high | medium | low",
  "details": {
    "game": "Pokemon, Magic: The Gathering, Yu-Gi-Oh!, etc (if trading card)",
    "set": "the set/expansion name (if trading card)",
    "card_number": "card number if visible",
    "rarity": "common, uncommon, rare, holo rare, ultra rare, etc",
    "variant": "reverse holo, full art, master ball, etc",
    "platform": "console/platform (if video game)",
    "region": "NTSC-U, PAL, NTSC-J, etc (if video game)",
    "year": 2024,
    "brand": "manufacturer or brand",
    "character": "featured character if applicable",
    "manufacturer": "who made it",
    "condition_estimate": "mint, near mint, lightly played, moderately played, heavily played, damaged",
    "grading_company": "PSA, BGS, CGC if graded",
    "grade": 9.5
  },
  "search_queries": {
    "primary": "the best general search query to find this exact item on PriceCharting",
    "ebay": "optimized eBay search query (include key identifiers, exclude noise words)"
  }
}

Only include fields in "details" that you can actually determine from the image. Omit fields you cannot identify.
For the title, be as specific as possible - include card numbers, set names, variant types, etc.
For search queries, be specific enough to find this exact item but not so specific that results are empty.`;

function buildPromptText(additionalContext?: string): string {
  return additionalContext
    ? `${IDENTIFICATION_PROMPT}\n\nAdditional context from user: ${additionalContext}`
    : IDENTIFICATION_PROMPT;
}

function parseResponse(rawText: string): IdentificationResult {
  try {
    const parsed = JSON.parse(rawText);
    return {
      ...parsed,
      raw_response: rawText,
    } as IdentificationResult;
  } catch {
    throw new Error(
      `Failed to parse Claude Vision response as JSON: ${rawText.slice(0, 200)}`
    );
  }
}

function extractText(response: Anthropic.Message): string {
  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from Claude Vision");
  }
  return textBlock.text.trim();
}

export async function identifyFromFile(
  filePath: string,
  additionalContext?: string
): Promise<IdentificationResult> {
  const client = getClient();

  // Resize large phone photos before sending
  const processed = await processImageForVision(filePath);

  if (processed.originalSize !== processed.processedSize) {
    const origMb = (processed.originalSize / 1_000_000).toFixed(1);
    const newMb = (processed.processedSize / 1_000_000).toFixed(1);
    console.log(`  Resized image: ${origMb}MB -> ${newMb}MB (${processed.width}x${processed.height})`);
  }

  const base64 = processed.buffer.toString("base64");

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: processed.mediaType,
              data: base64,
            },
          },
          { type: "text", text: buildPromptText(additionalContext) },
        ],
      },
    ],
  });

  return parseResponse(extractText(response));
}

export async function identifyFromUrl(
  imageUrl: string,
  additionalContext?: string
): Promise<IdentificationResult> {
  const client = getClient();

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "url", url: imageUrl },
          },
          { type: "text", text: buildPromptText(additionalContext) },
        ],
      },
    ],
  });

  return parseResponse(extractText(response));
}
