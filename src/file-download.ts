import { telegram, TelegramError } from "./telegram";
export class FileDownloadError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export async function downloadFileBytes(
  token: string,
  fileId: string,
  maxBytes: number,
  kind: "image" | "file",
) {
  const file = await telegram(token, "getFile", { file_id: fileId });
  if (file.file_size !== undefined && file.file_size > maxBytes)
    throw new FileDownloadError(`${kind}_too_large`);
  const path = file.file_path;
  if (
    !path ||
    !/^[A-Za-z0-9_./-]+$/.test(path) ||
    path.startsWith("/") ||
    path.split("/").some((x) => !x || x === "." || x === "..")
  )
    throw new FileDownloadError("invalid_file_path");
  let response: Response;
  try {
    response = await fetch(
      `https://api.telegram.org/file/bot${token}/${path}`,
      {
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      },
    );
  } catch {
    throw new TelegramError(503);
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status >= 300 && response.status < 400)
      throw new FileDownloadError("file_redirect_rejected");
    throw new TelegramError(response.status);
  }
  if (Number(response.headers.get("Content-Length")) > maxBytes) {
    await response.body?.cancel();
    throw new FileDownloadError(`${kind}_too_large`);
  }
  if (!response.body) throw new FileDownloadError(`empty_${kind}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new FileDownloadError(`${kind}_too_large`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof FileDownloadError) throw error;
    throw new TelegramError(503);
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  if (file.file_size !== undefined && size !== file.file_size)
    throw new TelegramError(502);
  return bytes;
}
