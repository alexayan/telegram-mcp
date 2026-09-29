import { imageFile } from "./image-metadata";
import type { TelegramMessage } from "./types";

export const MAX_DOCUMENT_BYTES = 20_000_000;
export interface DocumentFile {
  file_id: string;
  file_name: string | null;
  mime_type: string;
  file_size?: number;
}

export function documentFile(
  message: TelegramMessage,
): DocumentFile | undefined {
  // Supported image documents continue to use the image archive and get_image.
  if (imageFile(message)) return;
  const value = message.document;
  if (!value || typeof value !== "object") return;
  const x = value as Record<string, unknown>;
  if (
    typeof x.file_id !== "string" ||
    !/^[A-Za-z0-9_-]{1,1024}$/.test(x.file_id)
  )
    return;
  return {
    file_id: x.file_id,
    // Display metadata only. Never use the sender's filename as an object key or path.
    file_name:
      typeof x.file_name === "string" ? x.file_name.slice(0, 1024) : null,
    mime_type:
      typeof x.mime_type === "string" &&
      /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(x.mime_type) &&
      x.mime_type.length <= 255
        ? x.mime_type.toLowerCase()
        : "application/octet-stream",
    file_size:
      typeof x.file_size === "number" &&
      Number.isSafeInteger(x.file_size) &&
      x.file_size >= 0
        ? x.file_size
        : undefined,
  };
}
