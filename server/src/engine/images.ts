import type { LanguageModelV4Message, LanguageModelV4Prompt } from "@ai-sdk/provider";
import type { LanguageModelMiddleware, ModelMessage } from "ai";
import sharp, { type Metadata } from "sharp";
import type { BlobStore } from "../blobs.js";

// Images are small and seldom reused: libvips' operation cache would only hold memory.
sharp.cache(false);

export type ImageFormat = "png" | "jpeg" | "gif" | "webp" | "avif" | "heif" | "tiff" | "bmp" | "svg";

/** What the model is sent: formats every vision model on OpenRouter takes. */
export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** Scheme of a stored image in saved messages (`agentcave-image:<sha256>`); the bytes are read when a step is sent. */
export const IMAGE_URL_SCHEME = "agentcave-image:";
/** Most bytes a prepared image may have, so its base64 stays under the 5 MB some providers allow. */
export const MAX_IMAGE_BYTES = 3_750_000;
/** Bigger files are not opened as images. */
export const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
/** Rough input tokens of one image, for the context estimate (providers scale images to about this). */
export const IMAGE_TOKENS = 1600;

export const VIEWABLE_FORMATS = "PNG, JPEG, GIF, WebP, AVIF, TIFF or SVG";

export class ImageError extends Error {
  override name = "ImageError";
}

export function imageUrl(sha256: string): string {
  return `${IMAGE_URL_SCHEME}${sha256}`;
}

/** The image format of a file, from its first bytes (SVG: from its text). Null when it isn't an image. */
export function sniffImage(bytes: Uint8Array): ImageFormat | null {
  const b = bytes;
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 4) === "PNG") return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "gif";
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (b.length >= 4 && (ascii(0, 4) === "II*\0" || ascii(0, 4) === "MM\0*")) return "tiff";
  if (b.length >= 12 && ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (brand === "avif" || brand === "avis") return "avif";
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand)) return "heif";
  }
  if (b.length >= 26 && ascii(0, 2) === "BM") return "bmp";
  const head = new TextDecoder("utf-8", { fatal: false }).decode(b.subarray(0, 4096));
  if (
    /^﻿?\s*(<\?xml[\s\S]*?\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(
      head,
    )
  )
    return "svg";
  return null;
}

export interface PreparedImage {
  /** Bytes to send: the original file when it already fits, otherwise a converted copy. */
  data: Buffer;
  mediaType: ImageMediaType;
  width: number;
  height: number;
  /** Size of the original, upright (SVG: at 72 dpi). */
  sourceWidth: number;
  sourceHeight: number;
  /** Scaled down or converted to another format. */
  converted: boolean;
}

const AS_IS: Partial<Record<ImageFormat, ImageMediaType>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * Makes an image ready for a vision model: upright, at most `maxEdge` pixels on its longest side,
 * PNG/JPEG/GIF/WebP, first frame only, under `MAX_IMAGE_BYTES`. Throws `ImageError` with a reason
 * the model or the caller can act on.
 */
export async function prepareImage(bytes: Buffer, opts: { maxEdge: number }): Promise<PreparedImage> {
  const format = sniffImage(bytes);
  if (!format) throw new ImageError(`Not an image this model can be shown (use ${VIEWABLE_FORMATS}).`);
  if (format === "bmp") throw new ImageError("BMP images can't be shown. Convert it to PNG first.");
  if (bytes.length > MAX_SOURCE_BYTES) {
    throw new ImageError(
      `The image is too big to open (${(bytes.length / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_SOURCE_BYTES / 1024 / 1024} MB).`,
    );
  }
  let meta: Metadata;
  try {
    meta = await sharp(bytes).metadata();
  } catch (err) {
    throw unreadable(format, err);
  }
  const sourceWidth = meta.autoOrient?.width ?? meta.width ?? 0;
  const sourceHeight = meta.autoOrient?.height ?? meta.height ?? 0;
  if (!sourceWidth || !sourceHeight) throw new ImageError("The image has no size.");
  const maxEdge = Math.max(1, Math.floor(opts.maxEdge));
  const longEdge = Math.max(sourceWidth, sourceHeight);

  const asIs = AS_IS[format];
  const upright = (meta.orientation ?? 1) === 1;
  const oneFrame = (meta.pages ?? 1) === 1;
  if (asIs && upright && oneFrame && longEdge <= maxEdge && bytes.length <= MAX_IMAGE_BYTES) {
    return {
      data: bytes,
      mediaType: asIs,
      width: sourceWidth,
      height: sourceHeight,
      sourceWidth,
      sourceHeight,
      converted: false,
    };
  }

  // SVG: render sharp (up to 2× its own size) but no bigger than needed.
  const density = format === "svg" ? Math.max(1, Math.min(144, (72 * maxEdge) / longEdge)) : undefined;
  const photo = format === "jpeg" || format === "avif" || format === "heif";
  const render = async (edge: number, as: "png" | "jpeg") => {
    let img = sharp(bytes, { density, pages: 1, autoOrient: true }).resize({
      width: edge,
      height: edge,
      fit: "inside",
      withoutEnlargement: true,
    });
    img = as === "jpeg" ? img.flatten({ background: "#ffffff" }).jpeg({ quality: 85 }) : img.png();
    const { data, info } = await img.toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, as };
  };

  try {
    let edge = maxEdge;
    for (let i = 0; i < 6; i++) {
      let out = await render(edge, photo ? "jpeg" : "png");
      if (out.data.length > MAX_IMAGE_BYTES && out.as === "png") out = await render(edge, "jpeg");
      if (out.data.length <= MAX_IMAGE_BYTES) {
        return {
          data: out.data,
          mediaType: out.as === "png" ? "image/png" : "image/jpeg",
          width: out.width,
          height: out.height,
          sourceWidth,
          sourceHeight,
          converted: true,
        };
      }
      edge = Math.floor(Math.min(edge, Math.max(out.width, out.height)) * 0.75);
    }
  } catch (err) {
    throw unreadable(format, err);
  }
  throw new ImageError("The image could not be made small enough to show.");
}

function unreadable(format: ImageFormat, err: unknown): ImageError {
  if (format === "heif") return new ImageError("HEIC/HEIF images can't be shown. Convert it to JPEG first.");
  const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
  return new ImageError(`The image could not be read (${msg}).`);
}

// -----------------------------------------------------------------------------
// Images in messages

/**
 * A user-message image part pointing into the blob store. `data` is a plain string so the part
 * survives being saved as JSON; the AI SDK reads it as a URL and `imageDownloader` fetches it.
 */
export function userImagePart(img: { sha256: string; mediaType: string }) {
  return { type: "file" as const, mediaType: img.mediaType, data: imageUrl(img.sha256) };
}

/** A tool-result image part pointing into the blob store (see `reviveImageUrls` after JSON). */
export function toolImagePart(img: { sha256: string; mediaType: string }) {
  return {
    type: "file" as const,
    mediaType: img.mediaType,
    data: { type: "url" as const, url: new URL(imageUrl(img.sha256)) },
  };
}

/** Saved tool results lose their `URL` objects to JSON; puts them back so the AI SDK accepts the messages. */
export function reviveImageUrls(messages: ModelMessage[]): ModelMessage[] {
  for (const m of messages) {
    if (m.role !== "tool") continue;
    for (const part of m.content) {
      if (part.type !== "tool-result" || part.output.type !== "content") continue;
      for (const c of part.output.value) {
        if (c.type === "file" && c.data.type === "url" && typeof c.data.url === "string")
          c.data.url = new URL(c.data.url);
      }
    }
  }
  return messages;
}

/** How many images the messages show (user parts and tool results). */
export function countImages(messages: ModelMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.role === "user" && Array.isArray(m.content)) {
      for (const p of m.content)
        if (p.type === "image" || (p.type === "file" && isImageType(p.mediaType))) n++;
    } else if (m.role === "tool") {
      for (const p of m.content) {
        if (p.type !== "tool-result" || p.output.type !== "content") continue;
        for (const c of p.output.value) if (c.type === "file" && isImageType(c.mediaType)) n++;
      }
    }
  }
  return n;
}

function isImageType(mediaType: string | undefined): boolean {
  return !!mediaType && (mediaType === "image" || mediaType.startsWith("image/"));
}

/** The AI SDK's `experimental_download`: reads `agentcave-image:` URLs from the blob store (cached per run). */
export function imageDownloader(blobs: BlobStore) {
  const cache = new Map<string, Promise<Uint8Array>>();
  return (requests: Array<{ url: URL }>) =>
    Promise.all(
      requests.map(async ({ url }) => {
        if (url.protocol !== IMAGE_URL_SCHEME) return null;
        const sha = url.pathname;
        if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error(`Bad image reference: ${url.href}`);
        let bytes = cache.get(sha);
        if (!bytes) {
          bytes = blobs.read(sha).then((b) => new Uint8Array(b.buffer, b.byteOffset, b.length));
          cache.set(sha, bytes);
          bytes.catch(() => cache.delete(sha));
        }
        return { data: await bytes, mediaType: undefined };
      }),
    );
}

/**
 * Model middleware: moves images out of tool results into a user message right after them.
 * OpenAI-style APIs only take text in tool results, so this is the form every vision model accepts.
 * The saved conversation keeps them in the tool result, where they belong.
 */
export const toolImagesMiddleware: LanguageModelMiddleware = {
  transformParams: async ({ params }) => ({ ...params, prompt: moveToolImages(params.prompt) }),
};

export function moveToolImages(prompt: LanguageModelV4Prompt): LanguageModelV4Prompt {
  const out: LanguageModelV4Prompt = [];
  for (const message of prompt) {
    if (message.role !== "tool") {
      out.push(message);
      continue;
    }
    const shown: Extract<LanguageModelV4Message, { role: "user" }>["content"] = [];
    const content = message.content.map((part) => {
      if (part.type !== "tool-result" || part.output.type !== "content") return part;
      let label = `Image from \`${part.toolName}\``;
      const value = part.output.value.map((c) => {
        if (c.type === "text") label = c.text;
        if (c.type !== "file" || !isImageType(c.mediaType)) return c;
        shown.push({ type: "text", text: label }, { ...c, type: "file" as const });
        return { type: "text" as const, text: "(The image is attached in the next message.)" };
      });
      return { ...part, output: { ...part.output, value } };
    });
    out.push({ ...message, content } as typeof message);
    if (shown.length) out.push({ role: "user", content: shown });
  }
  return out;
}
