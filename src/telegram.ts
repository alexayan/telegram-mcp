import { AuthFlowError } from "./auth-errors";
import type { BusinessConnection, TelegramUpdate } from "./types";
export class TelegramError extends Error {
  constructor(
    public code: number,
    public retryAfter = 30,
  ) {
    super(`telegram_${code}`);
  }
}
// The only allowed Telegram methods. No arbitrary method or URL comes from MCP input.
interface Results {
  getMe: { id: number; username?: string; can_connect_to_business?: boolean };
  getWebhookInfo: { url: string };
  getBusinessConnection: BusinessConnection;
  getUpdates: TelegramUpdate[];
  getFile: { file_path?: string; file_size?: number };
  getChatMember: { status: string; is_member?: boolean };
}
export async function telegram<M extends keyof Results>(
  token: string,
  method: M,
  params: Record<string, unknown> = {},
): Promise<Results[M]> {
  return telegramRequest<Results[M]>(token, method, params);
}
// Deliberately separate from the read-only API. Only the authenticated management RPC uses this.
export async function leaveTelegramChannel(token: string, chatId: string) {
  return telegramRequest<boolean>(token, "leaveChat", { chat_id: chatId });
}
async function telegramRequest<T>(
  token: string,
  method: keyof Results | "leaveChat",
  params: Record<string, unknown>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(20_000),
      redirect: "manual",
    });
  } catch {
    throw new TelegramError(503);
  } // Never propagate a fetch exception containing a credential URL.
  // Workers only supports follow/manual. Never forward a credential URL to a redirect target.
  if (response.status >= 300 && response.status < 400)
    throw new TelegramError(502);
  let body: {
    ok: boolean;
    result: T;
    error_code?: number;
    parameters?: { retry_after?: number };
  };
  try {
    body = await response.json();
  } catch {
    throw new TelegramError(502);
  }
  if (!response.ok || !body.ok)
    throw new TelegramError(
      body.error_code ?? response.status,
      Math.max(1, body.parameters?.retry_after ?? 30),
    );
  return body.result;
}
export function isReadOnly(connection: BusinessConnection): boolean {
  // Telegram omits optional rights when none are granted (BusinessConnection.rights).
  const rights = connection.rights === undefined ? {} : connection.rights;
  return (
    rights !== null &&
    typeof rights === "object" &&
    !Array.isArray(rights) &&
    connection.can_reply !== true &&
    Object.values(rights).every((value) => value === false)
  );
}
export function validateTokenFormat(token: string): void {
  if (!/^\d{5,20}:[A-Za-z0-9_-]{20,200}$/.test(token))
    throw new AuthFlowError("bot_token_format");
}
