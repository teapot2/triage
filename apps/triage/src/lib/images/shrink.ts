// Shrinks a pasted or dropped image in the browser before it's sent with
// an Ask question: long side at most 1,600 px (axis labels on a dashboard
// panel stay readable, at about 1,500 to 2,000 tokens), re-encoded until
// it's under the target size. Meta documents a 1 MiB cap on a request
// body, so only the shrunk copy leaves the browser.

export const MAX_SIDE = 1600;
export const TARGET_BYTES = 900_000;

// The formats the models take, which a small enough original keeps.
const KEEP_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface ShrunkImage {
  blob: Blob;
  mediaType: string;
  width: number;
  height: number;
}

// The size that fits within `max` on its long side, keeping the aspect
// ratio and never scaling up.
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// The encodings tried in order until one is under the target: quality
// first, then a smaller long side.
export const ladder: { side: number; quality: number }[] = [
  { side: MAX_SIDE, quality: 0.85 },
  { side: MAX_SIDE, quality: 0.7 },
  { side: MAX_SIDE, quality: 0.55 },
  { side: 1200, quality: 0.55 },
  { side: 900, quality: 0.5 },
];

export class UnreadableImage extends Error {}

export async function shrinkImage(file: Blob): Promise<ShrunkImage> {
  let bitmap: ImageBitmap;
  try {
    // A GIF gives its first frame.
    bitmap = await createImageBitmap(file);
  } catch {
    throw new UnreadableImage("Couldn't read that image (PNG, JPEG, GIF or WebP).");
  }
  try {
    const { width, height } = bitmap;
    // Already small enough: sent as is, so text in a PNG stays sharp.
    if (KEEP_TYPES.has(file.type) && file.size <= TARGET_BYTES && Math.max(width, height) <= MAX_SIDE) {
      return { blob: file, mediaType: file.type, width, height };
    }
    let last: ShrunkImage | undefined;
    for (const step of ladder) {
      last = await encode(bitmap, fitWithin(width, height, step.side), step.quality);
      if (last.blob.size <= TARGET_BYTES) return last;
    }
    return last!;
  } finally {
    bitmap.close();
  }
}

// WebP where the browser can encode it, else JPEG. On white, so a
// transparent screenshot doesn't turn black as a JPEG.
async function encode(
  bitmap: ImageBitmap,
  size: { width: number; height: number },
  quality: number,
): Promise<ShrunkImage> {
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new UnreadableImage("This browser can't resize images.");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, size.width, size.height);
  const toBlob = (type: string) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  let blob = await toBlob("image/webp");
  if (blob?.type !== "image/webp") blob = await toBlob("image/jpeg");
  if (!blob) throw new UnreadableImage("Couldn't resize that image.");
  return { blob, mediaType: blob.type, ...size };
}
