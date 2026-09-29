// Both archives use the current message revision and the same chat/Business visibility.
export const mediaJoin = `JOIN messages m ON m.installation_id=a.installation_id AND m.source_key=a.source_key
 AND m.chat_id=a.chat_id AND m.message_id=a.message_id AND m.last_update=a.last_update
 JOIN chats c ON c.installation_id=m.installation_id AND c.source_key=m.source_key AND c.chat_id=m.chat_id`;
export const visibleMedia = `m.deleted=0 AND c.enabled=1 AND (c.source_key='bot' OR EXISTS (
 SELECT 1 FROM connections b WHERE b.installation_id=c.installation_id AND 'business:' || b.connection_id=c.source_key AND b.enabled=1))`;
