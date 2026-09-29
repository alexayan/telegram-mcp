CREATE TABLE documents (
 id TEXT PRIMARY KEY,
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 source_key TEXT NOT NULL, chat_id TEXT NOT NULL, message_id INTEGER NOT NULL,
 last_update INTEGER NOT NULL, object_key TEXT NOT NULL UNIQUE,
 file_sealed TEXT, file_name TEXT, mime_type TEXT NOT NULL,
 byte_size INTEGER, status TEXT NOT NULL, error_code TEXT,
 attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0,
 expires_at INTEGER NOT NULL,
 FOREIGN KEY (installation_id,source_key,chat_id,message_id)
 REFERENCES messages(installation_id,source_key,chat_id,message_id) ON DELETE CASCADE,
 UNIQUE (installation_id,source_key,chat_id,message_id,last_update)
);
CREATE INDEX documents_pending ON documents(installation_id,status,retry_at);
CREATE INDEX documents_expiry ON documents(expires_at);
