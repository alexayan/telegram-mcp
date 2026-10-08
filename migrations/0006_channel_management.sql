-- Browser-only, single-use confirmation; never an MCP permission.
ALTER TABLE sessions ADD COLUMN leave_chat_id TEXT;
ALTER TABLE sessions ADD COLUMN leave_token_hash TEXT;
ALTER TABLE sessions ADD COLUMN leave_expires_at INTEGER;
-- Persist the local block before contacting Telegram, including uncertain outcomes.
ALTER TABLE chats ADD COLUMN left_at INTEGER;
ALTER TABLE chats ADD COLUMN leave_pending INTEGER NOT NULL DEFAULT 0;
CREATE INDEX chats_management_channels ON chats(installation_id,source_key,chat_type,chat_id);
