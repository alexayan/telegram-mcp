import { RETENTION_SECONDS } from "../config/retention";
import { Buffer } from "node:buffer";
import { hash, seal, unseal, type Sealed } from "./crypto";
import { documentFile, MAX_DOCUMENT_BYTES } from "./document-metadata";
import { downloadFileBytes, FileDownloadError } from "./file-download";
import { messageKeys } from "./inbox";
import { assertScope, now } from "./store";
import { TelegramError } from "./telegram";
import type { Env, SyncEnv, GrantProps, TelegramUpdate } from "./types";
import {
  mediaJoin as documentJoin,
  visibleMedia as visible,
} from "./media-access";

export async function stageDocument(
  env: SyncEnv,
  installationId: string,
  update: TelegramUpdate,
) {
  const key = messageKeys.find((key) => update[key]);
  const message = key ? update[key] : undefined;
  if (!message) return;
  const file = documentFile(message);
  if (!file) return;
  const source = message.business_connection_id
    ? `business:${message.business_connection_id}`
    : "bot";
  const stored = await env.DB.prepare(
    `SELECT sent_at FROM messages WHERE installation_id=? AND source_key=?
    AND chat_id=? AND message_id=? AND last_update=? AND deleted=0 AND sent_at>?`,
  )
    .bind(
      installationId,
      source,
      String(message.chat.id),
      message.message_id,
      update.update_id,
      now() - RETENTION_SECONDS,
    )
    .first<{ sent_at: number }>();
  if (!stored) return;
  const id = await hash(
    JSON.stringify([
      installationId,
      source,
      message.chat.id,
      message.message_id,
      update.update_id,
    ]),
  );
  const tooLarge = (file.file_size ?? 0) > MAX_DOCUMENT_BYTES;
  const encrypted = tooLarge
    ? null
    : JSON.stringify(
        await seal(
          file.file_id,
          `document:${installationId}:${id}`,
          env.BOT_KEYS,
          env.ACTIVE_KEY_ID,
        ),
      );
  await env.DB.prepare(
    `INSERT OR IGNORE INTO documents(id,installation_id,source_key,chat_id,message_id,last_update,object_key,
    file_sealed,file_name,mime_type,byte_size,status,error_code,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      id,
      installationId,
      source,
      String(message.chat.id),
      message.message_id,
      update.update_id,
      `documents/${installationId}/${id}`,
      encrypted,
      file.file_name,
      file.mime_type,
      file.file_size ?? null,
      tooLarge ? "skipped" : "pending",
      tooLarge ? "file_too_large" : null,
      stored.sent_at + RETENTION_SECONDS,
    )
    .run();
}

export async function processDocuments(
  env: SyncEnv,
  installationId: string,
  token: string,
) {
  const { results } = await env.DB.prepare(
    `SELECT a.id,a.file_sealed,a.object_key,a.attempts FROM documents a ${documentJoin}
    WHERE a.installation_id=? AND a.status='pending' AND a.retry_at<=? AND a.expires_at>? AND ${visible}
    ORDER BY a.retry_at,a.id LIMIT 2`,
  )
    .bind(installationId, now(), now())
    .all<{
      id: string;
      file_sealed: string;
      object_key: string;
      attempts: number;
    }>();
  for (const row of results) {
    try {
      const fileId = await unseal(
        JSON.parse(row.file_sealed) as Sealed,
        `document:${installationId}:${row.id}`,
        env.BOT_KEYS,
      );
      const bytes = await downloadFileBytes(
        token,
        fileId,
        MAX_DOCUMENT_BYTES,
        "file",
      );
      await env.IMAGES.put(row.object_key, bytes, {
        httpMetadata: {
          contentType: "application/octet-stream",
          contentDisposition: "attachment",
          cacheControl: "private, no-store",
        },
      });
      const saved = await env.DB.prepare(
        "UPDATE documents SET status='ready',file_sealed=NULL,byte_size=?,error_code=NULL WHERE id=?",
      )
        .bind(bytes.length, row.id)
        .run();
      // Retention may have removed the job while the network request was in flight.
      if (!saved.meta.changes) await env.IMAGES.delete(row.object_key);
    } catch (error) {
      if (error instanceof TelegramError && error.code === 401) throw error;
      const permanent =
        error instanceof FileDownloadError ||
        (error instanceof TelegramError &&
          [400, 403, 404].includes(error.code)) ||
        row.attempts >= 7;
      const code =
        error instanceof FileDownloadError
          ? error.code
          : error instanceof TelegramError
            ? `telegram_${error.code}`
            : "file_storage_failed";
      const delay =
        error instanceof TelegramError && error.code === 429
          ? error.retryAfter
          : Math.min(3600, 30 * 2 ** row.attempts);
      await env.DB.prepare(
        `UPDATE documents SET status=?,error_code=?,attempts=attempts+1,retry_at=?,file_sealed=CASE WHEN ? THEN NULL ELSE file_sealed END WHERE id=?`,
      )
        .bind(
          permanent ? "failed" : "pending",
          code,
          now() + delay,
          Number(permanent),
          row.id,
        )
        .run();
      if (error instanceof TelegramError && error.code === 429) throw error;
    }
  }
}

export async function readDocument(
  env: Pick<Env, "DB" | "IMAGES">,
  scope: GrantProps,
  id: string,
) {
  await assertScope(env.DB, scope);
  const lookup = () =>
    env.DB.prepare(
      `SELECT a.object_key,a.mime_type,a.file_name FROM documents a ${documentJoin}
    WHERE a.id=? AND a.installation_id=? AND a.status='ready' AND a.expires_at>? AND ${visible}`,
    )
      .bind(id, scope.installationId, now())
      .first<{
        object_key: string;
        mime_type: string;
        file_name: string | null;
      }>();
  const row = await lookup();
  if (!row) return null;
  const object = await env.IMAGES.get(row.object_key);
  if (!object) return null;
  if (object.size > MAX_DOCUMENT_BYTES) {
    await object.body.cancel();
    return null;
  }
  const bytes = await object.arrayBuffer();
  // Check revocation again after object I/O; never hand out an unauthenticated URL.
  await assertScope(env.DB, scope);
  if (!(await lookup())) return null;
  return {
    id,
    file_name: row.file_name,
    mime_type: row.mime_type,
    byte_size: bytes.byteLength,
    content: {
      type: "resource" as const,
      resource: {
        uri: `telegram-file://documents/${id}`,
        mimeType: "application/octet-stream",
        blob: Buffer.from(bytes).toString("base64"),
      },
    },
  };
}

export async function cleanupDocuments(
  env: Pick<SyncEnv, "DB" | "IMAGES">,
  installationId?: string,
) {
  const { results } = await env.DB.prepare(
    `SELECT a.id,a.object_key FROM documents a WHERE ${installationId ? "a.installation_id=? AND" : ""}
    (a.expires_at<=? OR NOT EXISTS (SELECT 1 FROM messages m WHERE m.installation_id=a.installation_id
    AND m.source_key=a.source_key AND m.chat_id=a.chat_id AND m.message_id=a.message_id AND m.last_update=a.last_update AND m.deleted=0)) LIMIT 100`,
  )
    .bind(...(installationId ? [installationId, now()] : [now()]))
    .all<{ id: string; object_key: string }>();
  if (!results.length) return;
  await env.IMAGES.delete(results.map((x) => x.object_key));
  await env.DB.prepare(
    `DELETE FROM documents WHERE id IN (${results.map(() => "?").join(",")})`,
  )
    .bind(...results.map((x) => x.id))
    .run();
}
export async function deleteInstallationDocuments(
  env: SyncEnv,
  installationId: string,
) {
  // Prefix also includes uploads whose ready-state D1 write was interrupted.
  for (;;) {
    const page = await env.IMAGES.list({
      prefix: `documents/${installationId}/`,
      limit: 1000,
    });
    if (!page.objects.length) return;
    await env.IMAGES.delete(page.objects.map((x) => x.key));
  }
}
