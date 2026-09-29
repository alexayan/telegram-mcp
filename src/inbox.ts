import { imageFile } from "./image-metadata";
import { documentFile } from "./document-metadata";
import type { Sealed } from "./crypto";
import type { TelegramUpdate, TelegramMessage } from "./types";
type Store = DurableObjectStorage | DurableObjectTransaction;
type Manifest = Omit<Sealed, "ciphertext"> & { chunks: number };
// Chunk ciphertext well below the storage value limit; a full Telegram batch may be >128 KiB.
export async function writeInbox(
  storage: DurableObjectStorage,
  sealed: Sealed,
) {
  await storage.transaction(async (tx) => {
    const chunks = Math.ceil(sealed.ciphertext.length / 48000);
    for (let i = 0; i < chunks; i++)
      await tx.put(
        `inbox:${i}`,
        sealed.ciphertext.slice(i * 48000, (i + 1) * 48000),
      );
    await tx.put("inbox", {
      kid: sealed.kid,
      iv: sealed.iv,
      chunks,
    } satisfies Manifest);
  });
}
export async function readInbox(storage: Store): Promise<Sealed | undefined> {
  const manifest = await storage.get<Manifest>("inbox");
  if (!manifest) return;
  const parts: string[] = [];
  for (let i = 0; i < manifest.chunks; i++) {
    const part = await storage.get<string>(`inbox:${i}`);
    if (part === undefined) throw new Error("inbox_incomplete");
    parts.push(part);
  }
  return { kid: manifest.kid, iv: manifest.iv, ciphertext: parts.join("") };
}
export async function clearInbox(storage: Store) {
  const manifest = await storage.get<Manifest>("inbox");
  if (manifest)
    for (let i = 0; i < manifest.chunks; i++)
      await storage.delete(`inbox:${i}`);
  await storage.delete("inbox");
}
export function minimalUpdate(update: TelegramUpdate): TelegramUpdate {
  if (update.business_connection) {
    const c = update.business_connection;
    return {
      update_id: update.update_id,
      business_connection: {
        id: c.id,
        user: { id: c.user.id },
        is_enabled: c.is_enabled,
        rights: c.rights,
        can_reply: c.can_reply,
      },
    };
  }
  if (update.deleted_business_messages) {
    const d = update.deleted_business_messages;
    return {
      update_id: update.update_id,
      deleted_business_messages: {
        business_connection_id: d.business_connection_id,
        chat: { id: d.chat.id },
        message_ids: d.message_ids,
      },
    };
  }
  if (update.my_chat_member) {
    const c = update.my_chat_member;
    return {
      update_id: update.update_id,
      my_chat_member: {
        chat: cleanChat(c.chat),
        new_chat_member: {
          status: c.new_chat_member.status,
          is_member: c.new_chat_member.is_member,
        },
      },
    };
  }
  const key = messageKeys.find((key) => update[key]);
  const m = key ? update[key] : undefined;
  if (!m) return { update_id: update.update_id };
  const clean: TelegramMessage = {
    message_id: m.message_id,
    business_connection_id: m.business_connection_id,
    chat: cleanChat(m.chat),
    message_thread_id: m.message_thread_id,
    from: m.from ? { id: m.from.id } : undefined,
    date: m.date,
    edit_date: m.edit_date,
    text: m.text?.slice(0, 16000),
    caption: m.caption?.slice(0, 16000),
  };
  for (const key of [
    "photo",
    "video",
    "document",
    "voice",
    "audio",
    "sticker",
  ] as const)
    if (key in m) clean[key] = true;
  const image = imageFile(m);
  if (image) {
    if (Array.isArray(m.photo)) clean.photo = [image];
    else clean.document = image;
  } else {
    const document = documentFile(m);
    if (document) clean.document = document;
  }
  return { update_id: update.update_id, [key!]: clean };
}
export const messageKeys = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "business_message",
  "edited_business_message",
] as const;
function cleanChat(chat: TelegramMessage["chat"]): TelegramMessage["chat"] {
  return {
    id: chat.id,
    type: chat.type,
    title: chat.title?.slice(0, 256),
    first_name: chat.first_name?.slice(0, 256),
    last_name: chat.last_name?.slice(0, 256),
  };
}
