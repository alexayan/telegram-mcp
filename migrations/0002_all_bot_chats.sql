-- Grants without the explicit access:"bot" discriminator remain invalid at the gateway.
-- Existing message namespaces and ciphertext are preserved.
CREATE TABLE chats (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 source_key TEXT NOT NULL, chat_id TEXT NOT NULL, chat_type TEXT NOT NULL,
 title TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
 last_update INTEGER NOT NULL DEFAULT -1,
 PRIMARY KEY (installation_id, source_key, chat_id)
);
ALTER TABLE messages ADD COLUMN message_thread_id INTEGER;
INSERT INTO chats(installation_id,source_key,chat_id,chat_type,title,last_update)
 SELECT installation_id,source_key,chat_id,'private',COALESCE(MAX(chat_title),''),MAX(last_update)
 FROM messages GROUP BY installation_id,source_key,chat_id;
CREATE INDEX messages_bot_date ON messages(installation_id,sent_at DESC,source_key,chat_id,message_id);
UPDATE installations SET status='active' WHERE status='pending';
