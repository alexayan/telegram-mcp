import { RETENTION_SECONDS } from "../config/retention";
import type {
  BusinessConnection,
  Connection,
  GrantProps,
  Installation,
  TelegramUpdate,
  TelegramChat,
} from "./types";
import { isReadOnly } from "./telegram";
export const now = () => Math.floor(Date.now() / 1000);
export async function getInstallation(db: D1Database, id: string) {
  return db
    .prepare("SELECT * FROM installations WHERE id = ?")
    .bind(id)
    .first<Installation>();
}
export async function getConnection(
  db: D1Database,
  id: string,
  connectionId: string,
) {
  return db
    .prepare(
      "SELECT * FROM connections WHERE installation_id = ? AND connection_id = ?",
    )
    .bind(id, connectionId)
    .first<Connection>();
}
export async function saveConnection(
  db: D1Database,
  id: string,
  c: BusinessConnection,
  updateId = -1,
) {
  await db
    .prepare(
      `INSERT INTO connections(installation_id,connection_id,owner_id,enabled,read_only,last_update) VALUES(?,?,?,?,?,?)
    ON CONFLICT(installation_id,connection_id) DO UPDATE SET owner_id=excluded.owner_id,enabled=excluded.enabled,read_only=excluded.read_only,last_update=MAX(connections.last_update,excluded.last_update)
    WHERE excluded.last_update = -1 OR excluded.last_update >= connections.last_update`,
    )
    .bind(
      id,
      c.id,
      String(c.user.id),
      Number(c.is_enabled),
      Number(isReadOnly(c)),
      updateId,
    )
    .run();
}
export async function assertScope(
  db: D1Database,
  scope: GrantProps,
): Promise<Installation> {
  const i = await getInstallation(db, scope.installationId);
  if (
    scope.access !== "bot" ||
    !i ||
    i.epoch !== scope.epoch ||
    i.status !== "active"
  )
    throw new Error("access_revoked");
  return i;
}
export async function saveChat(
  db: D1Database,
  id: string,
  source: string,
  chat: TelegramChat,
  updateId: number,
  enabled = true,
  membershipDate?: number,
) {
  await db
    .prepare(
      `INSERT INTO chats(installation_id,source_key,chat_id,chat_type,title,enabled,last_update) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(installation_id,source_key,chat_id) DO UPDATE SET chat_type=excluded.chat_type,title=excluded.title,
    enabled=CASE WHEN chats.left_at IS NOT NULL AND ?<=chats.left_at THEN 0 ELSE excluded.enabled END,
    left_at=CASE WHEN ?>chats.left_at AND excluded.enabled=1 THEN NULL ELSE chats.left_at END,
    leave_pending=CASE WHEN ?>chats.left_at OR (?=chats.left_at AND excluded.enabled=0) THEN 0 ELSE chats.leave_pending END,
    last_update=excluded.last_update
    WHERE excluded.last_update >= chats.last_update`,
    )
    .bind(
      id,
      source,
      String(chat.id),
      chat.type ?? "private",
      (
        chat.title ??
        [chat.first_name, chat.last_name].filter(Boolean).join(" ")
      ).slice(0, 256),
      Number(enabled),
      updateId,
      membershipDate ?? 0,
      membershipDate ?? 0,
      membershipDate ?? 0,
      membershipDate ?? 0,
    )
    .run();
}
export async function materialize(
  db: D1Database,
  id: string,
  update: TelegramUpdate,
) {
  if (update.business_connection) {
    await saveConnection(db, id, update.business_connection, update.update_id);
    return;
  }
  if (update.my_chat_member) {
    const member = update.my_chat_member.new_chat_member;
    const enabled =
      ["member", "administrator", "creator"].includes(member.status) ||
      (member.status === "restricted" && member.is_member === true);
    await saveChat(
      db,
      id,
      "bot",
      update.my_chat_member.chat,
      update.update_id,
      enabled,
      update.my_chat_member.date,
    );
    return;
  }
  const business = update.business_message ?? update.edited_business_message;
  const m =
    business ??
    update.message ??
    update.edited_message ??
    update.channel_post ??
    update.edited_channel_post;
  const deleted = update.deleted_business_messages;
  const connectionId =
    business?.business_connection_id ?? deleted?.business_connection_id;
  if ((business || deleted) && !connectionId) return;
  const connection = connectionId
    ? await getConnection(db, id, connectionId)
    : null;
  if (connectionId && !connection) return;
  const source = connectionId ? `business:${connectionId}` : "bot";
  if (deleted) {
    await db.batch(
      deleted.message_ids.map((messageId) =>
        db
          .prepare(
            `INSERT INTO messages(installation_id,source_key,chat_id,message_id,sent_at,deleted,last_update) VALUES(?,?,?,?,0,1,?)
      ON CONFLICT(installation_id,source_key,chat_id,message_id) DO UPDATE SET text=NULL,chat_title=NULL,sender_id=NULL,media_type=NULL,deleted=1,last_update=MAX(messages.last_update,excluded.last_update)`,
          )
          .bind(
            id,
            source,
            String(deleted.chat.id),
            messageId,
            update.update_id,
          ),
      ),
    );
    return;
  }
  if (
    !m ||
    (connectionId && !connection?.enabled) ||
    m.date <= now() - RETENTION_SECONDS
  )
    return;
  await saveChat(db, id, source, m.chat, update.update_id);
  const chat = await db
    .prepare(
      "SELECT enabled FROM chats WHERE installation_id=? AND source_key=? AND chat_id=?",
    )
    .bind(id, source, String(m.chat.id))
    .first<{ enabled: number }>();
  if (!chat?.enabled || m.message_id === 0) return;
  const media =
    ["photo", "video", "document", "voice", "audio", "sticker"].find(
      (type) => type in m,
    ) ?? null;
  await db
    .prepare(
      `INSERT INTO messages(installation_id,source_key,chat_id,message_id,chat_title,sender_id,sent_at,edited_at,text,media_type,last_update,message_thread_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(installation_id,source_key,chat_id,message_id) DO UPDATE SET chat_title=excluded.chat_title,sender_id=excluded.sender_id,edited_at=excluded.edited_at,text=excluded.text,media_type=excluded.media_type,last_update=excluded.last_update,message_thread_id=excluded.message_thread_id
    WHERE messages.deleted=0 AND excluded.last_update > messages.last_update`,
    )
    .bind(
      id,
      source,
      String(m.chat.id),
      m.message_id,
      (
        m.chat.title ??
        [m.chat.first_name, m.chat.last_name].filter(Boolean).join(" ")
      ).slice(0, 256),
      m.from ? String(m.from.id) : null,
      m.date,
      m.edit_date ?? null,
      (m.text ?? m.caption ?? "").slice(0, 16000),
      media,
      update.update_id,
      m.message_thread_id ?? null,
    )
    .run();
}
export async function retain(db: D1Database) {
  await db.batch([
    db
      .prepare(
        "UPDATE messages SET text=NULL,chat_title=NULL,sender_id=NULL,media_type=NULL,deleted=1 WHERE deleted=0 AND sent_at <= ?",
      )
      .bind(now() - RETENTION_SECONDS),
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now()),
  ]);
}
