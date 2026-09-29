CREATE TABLE installations (
 id TEXT PRIMARY KEY, bot_id TEXT NOT NULL UNIQUE, username TEXT NOT NULL,
 epoch INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'pending',
 created_at INTEGER NOT NULL, last_sync INTEGER, error_code TEXT
);
CREATE TABLE connections (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 connection_id TEXT NOT NULL, owner_id TEXT NOT NULL, enabled INTEGER NOT NULL,
 read_only INTEGER NOT NULL, selected INTEGER NOT NULL DEFAULT 0,
 last_update INTEGER NOT NULL DEFAULT -1,
 PRIMARY KEY (installation_id, connection_id)
);
CREATE TABLE messages (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 source_key TEXT NOT NULL, chat_id TEXT NOT NULL, message_id INTEGER NOT NULL,
 chat_title TEXT, sender_id TEXT, sent_at INTEGER NOT NULL, edited_at INTEGER,
 text TEXT, media_type TEXT, deleted INTEGER NOT NULL DEFAULT 0, last_update INTEGER NOT NULL,
 PRIMARY KEY (installation_id, source_key, chat_id, message_id)
);
CREATE INDEX messages_scope_date ON messages(installation_id, source_key, sent_at DESC, chat_id, message_id);
CREATE INDEX messages_chat ON messages(installation_id, source_key, chat_id, message_id DESC);
CREATE TABLE sessions (
 token_hash TEXT PRIMARY KEY, installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 epoch INTEGER NOT NULL, csrf TEXT NOT NULL, auth_request TEXT, expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
