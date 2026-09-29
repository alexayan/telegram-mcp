// Only these fixed codes/messages may cross the RPC boundary or appear in logs/UI.
export const authFailures = {
  bot_token_format: {
    status: 400,
    title: "Bot Token 格式不正确",
    message: "请粘贴 BotFather 提供的完整 Bot Token，格式为数字、冒号和密钥。",
  },
  bot_token_invalid: {
    status: 401,
    title: "Bot Token 无效或已撤销",
    message:
      "Telegram 未接受这个 Token。请在 BotFather 中确认当前 Token，然后重新输入。",
  },
  bot_access_denied: {
    status: 403,
    title: "Telegram 拒绝访问此 bot",
    message: "请在 Telegram / BotFather 检查这个 bot 的可用状态。",
  },
  webhook_conflict: {
    status: 409,
    title: "此 bot 已有 webhook",
    message:
      "这个 bot 正由 webhook 接收更新。请先迁移或停用原接收服务并移除 webhook，再重新验证；本服务不会自动修改它。",
  },
  telegram_rate_limited: {
    status: 429,
    title: "Telegram 请求过于频繁",
    message: "请稍后重新验证。当前没有签发 MCP 授权。",
  },
  telegram_unavailable: {
    status: 502,
    title: "暂时无法验证 Telegram bot",
    message: "Telegram API 暂时不可用或网络请求失败，请稍后重试。",
  },
  enrollment_unavailable: {
    status: 503,
    title: "服务暂时无法保存连接",
    message:
      "后台连接或加密存储暂时不可用，请稍后重试。这不代表 Bot Token 无效。",
  },
  invalid_origin: {
    status: 403,
    title: "请求来源不匹配",
    message: "请从 MCP 客户端重新打开授权页面，并在同一个浏览器中完成操作。",
  },
  invalid_form: {
    status: 400,
    title: "表单提交无效",
    message: "请重新打开授权页面后再提交。",
  },
  form_too_large: {
    status: 413,
    title: "表单内容过长",
    message: "请只填写完整的 Bot Token，不要粘贴其他内容。",
  },
  oauth_request_invalid: {
    status: 400,
    title: "授权请求无效或已过期",
    message:
      "授权表单有效期为 10 分钟，且只能提交一次。请从 MCP 客户端重新连接，在同一浏览器中完成授权并允许本站 Cookie。",
  },
  oauth_client_unavailable: {
    status: 502,
    title: "暂时无法验证 MCP 客户端",
    message: "无法获取客户端的 OAuth 元数据。请稍后从 MCP 客户端重新连接。",
  },
  authorization_unavailable: {
    status: 503,
    title: "授权服务暂时不可用",
    message:
      "服务端未能完成这次请求，请稍后重新连接。此错误不表示 Bot Token 无效。",
  },
} as const;
export type AuthFailureCode = keyof typeof authFailures;
export class AuthFlowError extends Error {
  constructor(public readonly code: AuthFailureCode) {
    super(code);
  }
}
export function reportAuthFailure(code: AuthFailureCode) {
  console.warn(JSON.stringify({ event: "auth_error", code }));
}
