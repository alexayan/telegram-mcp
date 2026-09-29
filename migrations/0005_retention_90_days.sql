-- Extend retained media from the original message timestamp, never from deployment time.
-- Deleted, superseded or already-expired entries must not become readable again.
UPDATE images
SET expires_at = (
 SELECT m.sent_at + 90 * 86400 FROM messages m
 WHERE m.installation_id=images.installation_id AND m.source_key=images.source_key
 AND m.chat_id=images.chat_id AND m.message_id=images.message_id
)
WHERE expires_at > unixepoch() AND EXISTS (
 SELECT 1 FROM messages m
 WHERE m.installation_id=images.installation_id AND m.source_key=images.source_key
 AND m.chat_id=images.chat_id AND m.message_id=images.message_id
 AND m.last_update=images.last_update AND m.deleted=0
);

UPDATE documents
SET expires_at = (
 SELECT m.sent_at + 90 * 86400 FROM messages m
 WHERE m.installation_id=documents.installation_id AND m.source_key=documents.source_key
 AND m.chat_id=documents.chat_id AND m.message_id=documents.message_id
)
WHERE expires_at > unixepoch() AND EXISTS (
 SELECT 1 FROM messages m
 WHERE m.installation_id=documents.installation_id AND m.source_key=documents.source_key
 AND m.chat_id=documents.chat_id AND m.message_id=documents.message_id
 AND m.last_update=documents.last_update AND m.deleted=0
);
