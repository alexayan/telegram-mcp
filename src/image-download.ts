import {
  FileDownloadError as ImageError,
  downloadFileBytes,
} from "./file-download";
import { MAX_IMAGE_BYTES } from "./image-metadata";
export { FileDownloadError as ImageError } from "./file-download";
export async function downloadImage(token: string, fileId: string) {
  const bytes = await downloadFileBytes(
    token,
    fileId,
    MAX_IMAGE_BYTES,
    "image",
  );
  // Never trust a document's extension or supplied MIME type. Exclude HTML/SVG.
  const starts = (magic: number[]) => magic.every((x, i) => bytes[i] === x);
  const ascii = (a: number, b: number) =>
    String.fromCharCode(...bytes.subarray(a, b));
  const mimeType = starts([0xff, 0xd8, 0xff])
    ? "image/jpeg"
    : starts([137, 80, 78, 71, 13, 10, 26, 10])
      ? "image/png"
      : ["GIF87a", "GIF89a"].includes(ascii(0, 6))
        ? "image/gif"
        : ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP"
          ? "image/webp"
          : null;
  if (!mimeType) throw new ImageError("unsupported_image");
  return { bytes, mimeType };
}
