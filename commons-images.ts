const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const COMMONS_SOURCE = "https://commons.wikimedia.org/?curid=";
const USER_AGENT = "Scholar-Pi/1.0 (educational image selection)";
const MAX_API_BYTES = 1_500_000;
const MAX_PREVIEW_BYTES = 2_000_000;
const MAX_SAVED_BYTES = 8_000_000;
const MAX_IMAGE_DIMENSION = 8_192;
const MAX_IMAGE_PIXELS = 24_000_000;

type CommonsMetadata = Record<string, { value?: unknown }>;

type CommonsImageInfo = {
  url?: unknown;
  descriptionurl?: unknown;
  thumburl?: unknown;
  width?: unknown;
  height?: unknown;
  thumbwidth?: unknown;
  thumbheight?: unknown;
  mime?: unknown;
  thumbmime?: unknown;
  mediatype?: unknown;
  extmetadata?: unknown;
};

export type CommonsImageCandidate = {
  pageId: number;
  title: string;
  description: string;
  previewUrl: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  artist: string;
  license: string;
  licenseUrl?: string;
  sourceUrl: string;
};

export type CommonsImageDownload = CommonsImageCandidate & {
  bytes: Buffer;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function compactText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(x?[\da-f]+);/gi, (_match, code: string) => {
      const radix = code[0]?.toLowerCase() === "x" ? 16 : 10;
      const digits = radix === 16 ? code.slice(1) : code;
      const point = Number.parseInt(digits, radix);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : " ";
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function metadataValue(metadata: unknown, key: string, maxLength: number): string {
  if (!record(metadata)) return "";
  const entry = (metadata as CommonsMetadata)[key];
  return compactText(entry?.value, maxLength);
}

function safeHttpsUrl(value: unknown, allowedHost?: string): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || (allowedHost && parsed.hostname !== allowedHost)) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function safeLicenseUrl(value: unknown): string | undefined {
  const url = safeHttpsUrl(value);
  if (!url) return undefined;
  const host = new URL(url).hostname.toLowerCase();
  return host === "creativecommons.org" || host === "www.creativecommons.org" || host === "rightsstatements.org"
    ? url
    : undefined;
}

function imageMime(value: unknown): CommonsImageCandidate["mimeType"] | undefined {
  if (value === "image/png" || value === "image/jpeg") return value;
  return undefined;
}

function candidateFromPage(value: unknown): CommonsImageCandidate | undefined {
  if (!record(value)) return undefined;
  const pageId = integer(value.pageid);
  const title = compactText(value.title, 300).replace(/^File:/i, "");
  const infos = Array.isArray(value.imageinfo) ? value.imageinfo : [];
  const info = infos[0] as CommonsImageInfo | undefined;
  if (!pageId || !title || !info || !record(info)) return undefined;
  if (info.mediatype !== "BITMAP" && info.mediatype !== "DRAWING") return undefined;

  const previewUrl = safeHttpsUrl(info.thumburl ?? info.url, "upload.wikimedia.org");
  const mimeType = imageMime(info.thumbmime ?? info.mime);
  const width = integer(info.thumbwidth ?? info.width);
  const height = integer(info.thumbheight ?? info.height);
  const originalWidth = integer(info.width) ?? width;
  const originalHeight = integer(info.height) ?? height;
  if (!previewUrl || !mimeType || !width || !height || !originalWidth || !originalHeight) return undefined;

  const license = metadataValue(info.extmetadata, "LicenseShortName", 120);
  const normalizedLicense = license.toUpperCase().replace(/[‐‑‒–—]/g, "-");
  const nonFree = metadataValue(info.extmetadata, "NonFree", 20).toLowerCase();
  const reusableLicense = normalizedLicense === "CC0"
    || normalizedLicense.includes("PUBLIC DOMAIN")
    || normalizedLicense === "PDM"
    || (/^CC[- ]BY(?:[- ]SA)?(?:[- ]\d(?:\.\d)?)?$/i.test(normalizedLicense) && !/(?:^|[- ])(?:NC|ND)(?:[- ]|$)/i.test(normalizedLicense));
  if (!reusableLicense || nonFree === "true" || nonFree === "1") return undefined;
  const artist = metadataValue(info.extmetadata, "Artist", 300) || "See the Wikimedia Commons source page";
  const description = metadataValue(info.extmetadata, "ImageDescription", 600);
  const licenseUrl = safeLicenseUrl(metadataValue(info.extmetadata, "LicenseUrl", 500));
  const sourceUrl = `${COMMONS_SOURCE}${pageId}`;
  return {
    pageId,
    title,
    description,
    previewUrl,
    mimeType,
    width,
    height,
    originalWidth,
    originalHeight,
    artist,
    license,
    ...(licenseUrl ? { licenseUrl } : {}),
    sourceUrl,
  };
}

async function readBounded(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.ok) throw new Error(`Wikimedia Commons returned HTTP ${response.status}.`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`Wikimedia response exceeds Scholar's ${maxBytes}-byte limit.`);
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`Wikimedia response exceeds Scholar's ${maxBytes}-byte limit.`);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Wikimedia response exceeds Scholar's ${maxBytes}-byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

async function fetchWithTimeout(url: URL | string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Wikimedia request timed out.")), timeoutMs);
  try {
    return await fetch(url, { ...init, redirect: "error", signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

async function commonsQuery(url: URL, signal?: AbortSignal): Promise<unknown> {
  const response = await fetchWithTimeout(url, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
  }, 8_000, signal);
  const bytes = await readBounded(response, MAX_API_BYTES);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Wikimedia Commons returned invalid JSON.");
  }
}

function baseQuery(thumbnailWidth: number): URL {
  const url = new URL(COMMONS_API);
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  url.searchParams.set("prop", "imageinfo");
  url.searchParams.set("iiprop", "url|size|mime|thumbmime|mediatype|extmetadata");
  url.searchParams.set("iiurlwidth", String(thumbnailWidth));
  url.searchParams.set("iiextmetadatafilter", "LicenseShortName|LicenseUrl|Artist|ImageDescription|NonFree");
  return url;
}

function pagesFromResponse(value: unknown): unknown[] {
  if (!record(value) || !record(value.query) || !Array.isArray(value.query.pages)) return [];
  return value.query.pages;
}

export async function searchCommonsImages(query: string, limit = 3, signal?: AbortSignal): Promise<CommonsImageCandidate[]> {
  const normalized = query.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 200) throw new Error("Commons image search requires a query of at most 200 characters.");
  const count = Math.max(1, Math.min(Math.trunc(limit), 4));
  const url = baseQuery(640);
  url.searchParams.set("generator", "search");
  url.searchParams.set("gsrsearch", normalized);
  url.searchParams.set("gsrnamespace", "6");
  url.searchParams.set("gsrlimit", String(Math.min(count * 2, 8)));
  const response = await commonsQuery(url, signal);
  return pagesFromResponse(response).map(candidateFromPage).filter((item): item is CommonsImageCandidate => Boolean(item)).slice(0, count);
}

function hasImageSignature(bytes: Buffer, mimeType: CommonsImageCandidate["mimeType"]): boolean {
  if (mimeType === "image/png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function imageDimensions(bytes: Buffer, mimeType: CommonsImageCandidate["mimeType"]): { width: number; height: number } | undefined {
  if (!hasImageSignature(bytes, mimeType)) return undefined;
  if (mimeType === "image/png") {
    if (bytes.length < 24 || bytes.toString("ascii", 12, 16) !== "IHDR") return undefined;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  let offset = 2;
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset + 4 <= bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++]!;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (startOfFrame.has(marker) && length >= 7) {
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return undefined;
}

function verifiedDimensions(bytes: Buffer, mimeType: CommonsImageCandidate["mimeType"]): { width: number; height: number } {
  const dimensions = imageDimensions(bytes, mimeType);
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1) throw new Error("Commons image dimensions could not be verified.");
  if (
    dimensions.width > MAX_IMAGE_DIMENSION
    || dimensions.height > MAX_IMAGE_DIMENSION
    || dimensions.width * dimensions.height > MAX_IMAGE_PIXELS
  ) {
    throw new Error("Commons image dimensions exceed Scholar's safety limit.");
  }
  return dimensions;
}

export async function downloadCommonsPreview(candidate: CommonsImageCandidate, signal?: AbortSignal): Promise<Buffer> {
  const url = safeHttpsUrl(candidate.previewUrl, "upload.wikimedia.org");
  if (!url) throw new Error("Commons returned an unsafe preview URL.");
  const response = await fetchWithTimeout(url, { headers: { Accept: candidate.mimeType, "User-Agent": USER_AGENT } }, 15_000, signal);
  const mimeType = imageMime(response.headers.get("content-type")?.split(";", 1)[0]?.trim());
  if (mimeType !== candidate.mimeType) throw new Error("Commons preview MIME type did not match its metadata.");
  const bytes = await readBounded(response, MAX_PREVIEW_BYTES);
  if (!hasImageSignature(bytes, mimeType)) throw new Error("Commons preview bytes did not match their declared image type.");
  return bytes;
}

export async function downloadCommonsImage(pageId: number, signal?: AbortSignal): Promise<CommonsImageDownload> {
  if (!Number.isSafeInteger(pageId) || pageId < 1) throw new Error("A valid Wikimedia Commons page ID is required.");
  const url = baseQuery(1600);
  url.searchParams.set("pageids", String(pageId));
  const response = await commonsQuery(url, signal);
  const candidate = pagesFromResponse(response).map(candidateFromPage).find(Boolean);
  if (!candidate) throw new Error(`Wikimedia Commons image ${pageId} is unavailable or lacks reusable license metadata.`);

  const imageUrl = safeHttpsUrl(candidate.previewUrl, "upload.wikimedia.org");
  if (!imageUrl) throw new Error("Commons returned an unsafe image URL.");
  const imageResponse = await fetchWithTimeout(imageUrl, { headers: { Accept: candidate.mimeType, "User-Agent": USER_AGENT } }, 15_000, signal);
  const mimeType = imageMime(imageResponse.headers.get("content-type")?.split(";", 1)[0]?.trim());
  if (mimeType !== candidate.mimeType) throw new Error("Commons image MIME type did not match its metadata.");
  const bytes = await readBounded(imageResponse, MAX_SAVED_BYTES);
  if (!hasImageSignature(bytes, mimeType)) throw new Error("Commons image bytes did not match their declared image type.");
  const dimensions = verifiedDimensions(bytes, mimeType);
  return { ...candidate, ...dimensions, bytes };
}

export function extensionForImageMime(mimeType: CommonsImageCandidate["mimeType"]): "png" | "jpg" {
  if (mimeType === "image/png") return "png";
  return "jpg";
}
