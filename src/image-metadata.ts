import type { TelegramMessage } from "./types";
export const MAX_IMAGE_BYTES = 20_000_000;
export interface ImageFile {
  file_id: string;
  mime_type: string;
  file_size?: number;
  width?: number;
  height?: number;
}
const mimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
function file(value: unknown, photo = false): ImageFile | undefined {
  if (!value || typeof value !== "object") return;
  const x = value as Record<string, unknown>;
  if (
    typeof x.file_id !== "string" ||
    !/^[A-Za-z0-9_-]{1,1024}$/.test(x.file_id)
  )
    return;
  const mime = photo ? "image/jpeg" : x.mime_type;
  if (typeof mime !== "string" || !mimeTypes.has(mime)) return;
  const number = (v: unknown) =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
  return {
    file_id: x.file_id,
    mime_type: mime,
    file_size: number(x.file_size),
    width: number(x.width),
    height: number(x.height),
  };
}
export function imageFile(message: TelegramMessage): ImageFile | undefined {
  if (Array.isArray(message.photo)) {
    return message.photo
      .map((x) => file(x, true))
      .filter((x): x is ImageFile => Boolean(x))
      .sort(
        (a, b) =>
          (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0),
      )[0];
  }
  return file(message.document);
}
