CREATE TABLE images (
 id TEXT PRIMARY KEY,
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 source_key TEXT NOT NULL, chat_id TEXT NOT NULL, message_id INTEGER NOT NULL,
 last_update INTEGER NOT NULL, object_key TEXT NOT NULL UNIQUE,
 file_sealed TEXT, mime_type TEXT NOT NULL, width INTEGER, height INTEGER,
 byte_size INTEGER, status TEXT NOT NULL, error_code TEXT,
 attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0,
 expires_at INTEGER NOT NULL,
 FOREIGN KEY (installation_id,source_key,chat_id,message_id)
 REFERENCES messages(installation_id,source_key,chat_id,message_id) ON DELETE CASCADE,
 UNIQUE (installation_id,source_key,chat_id,message_id,last_update)
);
CREATE INDEX images_pending ON images(installation_id,status,retry_at);
CREATE INDEX images_expiry ON images(expires_at);
