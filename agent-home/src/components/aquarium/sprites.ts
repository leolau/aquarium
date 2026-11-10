/**
 * Decode-once image cache for the canvas. `loadImage` starts a fetch on first
 * use and returns `null` until the image is decoded (then an `ImageBitmap`
 * where supported), so a render loop can poll it every frame for free.
 */
export type SpriteImage = HTMLImageElement | ImageBitmap | HTMLCanvasElement;

type Entry = { state: "loading" } | { state: "ready"; image: SpriteImage } | { state: "failed" };

const cache = new Map<string, Entry>();

function canLoad(): boolean {
  return typeof window !== "undefined" && typeof Image !== "undefined";
}

async function decode(url: string): Promise<SpriteImage> {
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  if (typeof img.decode === "function") await img.decode();
  else
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(`sprite failed: ${url}`));
    });
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(img);
    } catch {
      return img;
    }
  }
  return img;
}

/** The decoded image for `url`, or `null` while it loads (or if it failed). */
export function loadImage(url: string): SpriteImage | null {
  const hit = cache.get(url);
  if (hit) return hit.state === "ready" ? hit.image : null;
  if (!canLoad()) return null;
  cache.set(url, { state: "loading" });
  decode(url).then(
    (image) => {
      cache.set(url, { state: "ready", image });
    },
    () => cache.set(url, { state: "failed" }),
  );
  return null;
}

/** Starts loading every url now so the first frames don't wait on them. */
export function preloadImages(urls: Iterable<string>): void {
  for (const url of urls) loadImage(url);
}

export function imageSize(img: SpriteImage): [number, number] {
  if (typeof HTMLImageElement !== "undefined" && img instanceof HTMLImageElement) return [img.naturalWidth, img.naturalHeight];
  return [img.width, img.height];
}

/** Test seam: forget everything. */
export function resetImageCache(): void {
  cache.clear();
}
