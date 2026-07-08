import type { ChatAttachment, ChatTurn } from '@botty/shared';

/** Image attachment handling for the chat composer + message rendering. */

const SUPPORTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export const MAX_ATTACHMENTS = 4;
/** Long-edge cap before client-side downscale (matches Claude's useful max). */
const MAX_EDGE = 1568;
/** Mirror of ChatAttachmentSchema's dataBase64 max. */
const MAX_BASE64_CHARS = 7_000_000;

export function isSupportedImageType(type: string): boolean {
  return SUPPORTED_TYPES.has(type);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('failed to read image'));
    reader.readAsDataURL(blob);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not decode image'));
    img.src = url;
  });
}

/**
 * Turn a pasted/dropped file into a ChatAttachment. Images whose long edge
 * exceeds MAX_EDGE are downscaled via canvas (gifs lose animation in that
 * case — canvas can only re-encode to png/jpeg/webp).
 */
export async function prepareImage(file: File): Promise<ChatAttachment> {
  if (!isSupportedImageType(file.type)) {
    throw new Error(`unsupported image type: ${file.type || 'unknown'}`);
  }
  const dataUrl = await blobToDataUrl(file);
  const img = await loadImage(dataUrl);
  const longEdge = Math.max(img.naturalWidth, img.naturalHeight);

  let outUrl = dataUrl;
  if (longEdge > MAX_EDGE) {
    const scale = MAX_EDGE / longEdge;
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas unavailable');
    ctx.drawImage(img, 0, 0, w, h);
    const encodeAs =
      file.type === 'image/jpeg' ? 'image/jpeg' : file.type === 'image/webp' ? 'image/webp' : 'image/png';
    outUrl = canvas.toDataURL(encodeAs, encodeAs === 'image/jpeg' ? 0.85 : undefined);
  }

  const comma = outUrl.indexOf(',');
  // data:<mime>;base64,<payload> — trust the URL itself for the final mime
  // (toDataURL may silently fall back to png when webp is unsupported).
  const mimeType = outUrl.slice(5, outUrl.indexOf(';'));
  const dataBase64 = outUrl.slice(comma + 1);
  if (dataBase64.length > MAX_BASE64_CHARS) {
    throw new Error('image too large even after downscaling (max ~5MB)');
  }
  return { mimeType, dataBase64, name: file.name || undefined };
}

export function attachmentDataUrl(a: { mimeType: string; dataBase64: string }): string {
  return `data:${a.mimeType};base64,${a.dataBase64}`;
}

// ---------- reading attachments back out of turn.meta ----------

/**
 * Shape coordinated with the agent: meta.attachments entries carry either
 * inline data ({mimeType, dataBase64?, name}) or a ref the backend swapped in
 * to keep history payloads small ({ref: '/api/chat/attachments/<id>'}).
 */
export interface MetaAttachment {
  mimeType?: string;
  dataBase64?: string;
  name?: string;
  ref?: string;
}

export function metaAttachments(meta: ChatTurn['meta']): MetaAttachment[] {
  const raw = meta?.['attachments'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((a): a is MetaAttachment => typeof a === 'object' && a !== null);
}

export function metaAttachmentSrc(a: MetaAttachment): string | null {
  if (typeof a.ref === 'string' && a.ref) return a.ref;
  if (a.dataBase64 && a.mimeType) return attachmentDataUrl({ mimeType: a.mimeType, dataBase64: a.dataBase64 });
  return null;
}
