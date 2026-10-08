import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type SyncService from "./sync";
import type { BotCollector } from "./sync";
export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  OAUTH_KV: KVNamespace;
  PUBLIC_ORIGIN: string;
  SYNC: Service<SyncService>;
  AUTH_LIMIT: RateLimit;
  OAUTH_PROVIDER: OAuthHelpers;
}
export interface SyncEnv {
  DB: D1Database;
  IMAGES: R2Bucket;
  BOT_KEYS: string;
  ACTIVE_KEY_ID: string;
  COLLECTORS: DurableObjectNamespace<BotCollector>;
}
export interface Installation {
  id: string;
  bot_id: string;
  username: string;
  epoch: number;
  status: string;
  created_at: number;
  last_sync: number | null;
  error_code: string | null;
}
export interface Connection {
  installation_id: string;
  connection_id: string;
  owner_id: string;
  enabled: number;
  read_only: number;
  selected: number;
  last_update: number;
}
export interface GrantProps {
  installationId: string;
  access: "bot";
  epoch: number;
}
export interface Session {
  token_hash: string;
  installation_id: string;
  epoch: number;
  csrf: string;
  auth_request: string | null;
  expires_at: number;
}
export interface BusinessConnection {
  id: string;
  user: { id: number };
  is_enabled: boolean;
  rights?: Record<string, boolean>;
  can_reply?: boolean;
}
export interface TelegramChat {
  id: number;
  type?: "private" | "group" | "supergroup" | "channel";
  title?: string;
  first_name?: string;
  last_name?: string;
}
export interface TelegramMessage {
  message_id: number;
  business_connection_id?: string;
  chat: TelegramChat;
  message_thread_id?: number;
  from?: { id: number };
  date: number;
  edit_date?: number;
  text?: string;
  caption?: string;
  photo?: unknown;
  video?: unknown;
  document?: unknown;
  voice?: unknown;
  audio?: unknown;
  sticker?: unknown;
}
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
  my_chat_member?: {
    chat: TelegramChat;
    date?: number;
    new_chat_member: { status: string; is_member?: boolean };
  };
  business_connection?: BusinessConnection;
  business_message?: TelegramMessage;
  edited_business_message?: TelegramMessage;
  deleted_business_messages?: {
    business_connection_id: string;
    chat: { id: number };
    message_ids: number[];
  };
}
