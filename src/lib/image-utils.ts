import sharp from "sharp";
import { readFileSync } from "fs";

// Claude Vision works well at 1568px max dimension (their recommended size)
// Phone photos are often 4000-8000px - resizing saves bandwidth and time
const MAX_DIMENSION = 1568;
const JPEG_QUALITY = 85;

export interface ProcessedImage {
  buffer: Buffer;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
  originalSize: number;
  processedSize: number;
}

export async function processImageForVision(
  filePath: string
): Promise<ProcessedImage> {
  const originalBuffer = readFileSync(filePath);
  const originalSize = originalBuffer.length;

  const metadata = await sharp(originalBuffer).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  // If already small enough, return as-is
  if (width <= MAX_DIMENSION && height <= MAX_DIMENSION && originalSize < 5_000_000) {
    const mediaType =
      metadata.format === "png" ? "image/png" as const :
      metadata.format === "webp" ? "image/webp" as const :
      "image/jpeg" as const;

    return {
      buffer: originalBuffer,
      mediaType,
      width,
      height,
      originalSize,
      processedSize: originalSize,
    };
  }

  // Resize and convert to JPEG for best compression
  const resized = await sharp(originalBuffer)
    .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
    .rotate() // auto-rotate based on EXIF
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: resized.data,
    mediaType: "image/jpeg",
    width: resized.info.width,
    height: resized.info.height,
    originalSize,
    processedSize: resized.data.length,
  };
}
