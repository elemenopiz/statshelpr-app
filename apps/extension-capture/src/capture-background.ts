/**
 * Background service worker — CORS-free image fetching for captures.
 *
 * Content-script fetches run under the PAGE's CORS rules, so images hosted
 * off-Canvas (e.g. a course screenshot on bookdown.org) or behind redirecting
 * signed URLs fail from the page with "Failed to fetch". MV3 host permissions
 * only apply in the extension's own contexts — so the content script relays
 * image URLs here, and this worker fetches the bytes (cookies included, for
 * Canvas file URLs) and returns base64. Anything that isn't already
 * png/jpeg/webp is transcoded to png via OffscreenCanvas so every stored
 * image matches /api/solve's image contract.
 */

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

type ApiMediaType = "image/png" | "image/jpeg" | "image/webp";
type FetchImageResult =
  | { ok: true; data: string; mediaType: ApiMediaType }
  | { ok: false; error: string };

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  const m = msg as { type?: unknown; url?: unknown } | null;
  if (!m || m.type !== "shcap:fetch-image" || typeof m.url !== "string") return undefined;
  void fetchImage(m.url).then(sendResponse);
  return true; // keep the channel open for the async response
});

async function fetchImage(url: string): Promise<FetchImageResult> {
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const blob = await res.blob();
    if (blob.size === 0) return { ok: false, error: "empty response" };
    if (blob.size > MAX_IMAGE_BYTES) return { ok: false, error: `too large (${blob.size} bytes)` };

    const t = blob.type.toLowerCase().split(";")[0]!.trim();
    if (t === "image/png" || t === "image/jpeg" || t === "image/jpg" || t === "image/webp") {
      const mediaType: ApiMediaType = t === "image/jpg" ? "image/jpeg" : (t as ApiMediaType);
      return { ok: true, data: await blobToBase64(blob), mediaType };
    }
    // gif/bmp/octet-stream/… → decode and re-encode as png.
    const png = await transcodeToPng(blob);
    if (!png) return { ok: false, error: `unsupported image type "${blob.type || "unknown"}"` };
    return { ok: true, data: await blobToBase64(png), mediaType: "image/png" };
  } catch (e) {
    return { ok: false, error: (e as Error).message || String(e) };
  }
}

async function transcodeToPng(blob: Blob): Promise<Blob | null> {
  try {
    const bmp = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    return await canvas.convertToBlob({ type: "image/png" });
  } catch {
    return null; // not decodable (svg without intrinsic size, corrupt, …)
  }
}

/** Service workers have no FileReader — base64 via chunked btoa. */
async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
