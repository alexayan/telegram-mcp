import { hash, randomToken } from "./crypto";
import { RETENTION_DAYS } from "../config/retention";
import { now } from "./store";
import { csrfInput, escape, page } from "./ui";
import type { Env, Installation, Session } from "./types";

export interface ManagedChannel {
  chat_id: string;
  title: string;
  enabled: number;
  left_at: number | null;
  leave_pending: number;
}
export type LeaveResult =
  | "left"
  | "already_left"
  | "invalid_request"
  | "rate_limited"
  | "unavailable"
  | "rejected"
  | "uncertain";
export const leaveNotices: Record<LeaveResult, string> = {
  left: "Bot 已退出频道，该频道的消息、图片和附件已停止向 MCP 提供。",
  already_left: "Telegram 确认 bot 已不在该频道，本地状态已更新。",
  invalid_request: "确认已过期、已使用或频道状态已变化，请返回管理页重新操作。",
  rate_limited: "Telegram 请求过于频繁，请稍后返回频道列表重试。",
  unavailable: "暂时无法查询 Telegram 状态，请稍后重试。",
  rejected: "Telegram 拒绝退出请求，尚未确认退出，请检查 bot 状态后重试。",
  uncertain:
    "暂时无法确认退出结果，请返回频道列表查看状态并重新确认。显示“退出结果待确认”的频道已暂停向 MCP 提供数据。",
};
export async function getManagedChannel(
  db: D1Database,
  id: string,
  chatId: string,
) {
  return db
    .prepare(
      "SELECT chat_id,title,enabled,left_at,leave_pending FROM chats WHERE installation_id=? AND source_key='bot' AND chat_type='channel' AND chat_id=?",
    )
    .bind(id, chatId)
    .first<ManagedChannel>();
}
export async function channelSection(
  env: Env,
  i: Installation,
  s: Session,
  url: URL,
) {
  const cursor = url.searchParams.get("after_channel") ?? "";
  const after = /^-?\d{1,20}$/.test(cursor) ? cursor : "";
  const { results } = await env.DB.prepare(
    "SELECT chat_id,title,enabled,left_at,leave_pending FROM chats WHERE installation_id=? AND source_key='bot' AND chat_type='channel' AND chat_id>? ORDER BY chat_id LIMIT 21",
  )
    .bind(i.id, after)
    .all<ManagedChannel>();
  const channels = results.slice(0, 20);
  const notice = url.searchParams.get("channel_notice");
  const banner =
    notice && Object.hasOwn(leaveNotices, notice)
      ? `<p role="status">${leaveNotices[notice as LeaveResult]}</p>`
      : "";
  return `<section id="channels"><h2>频道管理</h2>${banner}<p>显示此服务已发现的频道，状态来自最近收到的更新。Telegram 不提供 bot 全部频道的查询接口；尚未投递更新的频道不会显示。<a href="/manage#channels">刷新列表</a></p>${channels.length ? channels.map((c) => `<article><h3>${escape(c.title || "未命名频道")}</h3><p>频道 ID：<code>${escape(c.chat_id)}</code></p><p>状态：${c.leave_pending ? "退出结果待确认" : c.enabled ? "在频道内（最近同步记录）" : "已退出或不可访问"}</p>${c.enabled || c.leave_pending ? `<form method="post" action="/manage">${csrfInput(s.csrf)}<input type="hidden" name="chat_id" value="${escape(c.chat_id)}"><button class="danger" name="action" value="leave_preview">${c.leave_pending ? "确认状态并重试退出" : "Leave · 退出频道"}</button></form>` : ""}</article>`).join("") : "<p>尚无已发现的频道。Bot 加入频道或收到新的频道消息后，列表会自动更新。</p>"}${after ? '<a href="/manage#channels">返回首页</a> ' : ""}${results.length > 20 ? `<a href="/manage?after_channel=${encodeURIComponent(channels.at(-1)!.chat_id)}#channels">下一页</a>` : ""}</section>`;
}
export async function confirmChannelLeave(
  env: Env,
  i: Installation,
  s: Session,
  chatId: string,
) {
  const channel = /^-\d{1,19}$/.test(chatId)
    ? await getManagedChannel(env.DB, i.id, chatId)
    : null;
  if (!channel || (!channel.enabled && !channel.leave_pending))
    return page(
      "频道不可操作",
      "<p>此频道不在当前 bot 的可退出列表中。</p>",
      {},
      404,
    );
  const confirmation = randomToken();
  await env.DB.prepare(
    "UPDATE sessions SET leave_chat_id=?,leave_token_hash=?,leave_expires_at=? WHERE token_hash=?",
  )
    .bind(
      chatId,
      await hash(confirmation),
      Math.min(s.expires_at, now() + 300),
      s.token_hash,
    )
    .run();
  return page(
    "确认退出频道",
    `<p>你即将让 <strong>@${escape(i.username)}</strong> 退出以下频道：</p><article><h2>${escape(channel.title || "未命名频道")}</h2><code>${escape(chatId)}</code></article><p>退出后停止接收该频道的新消息，已保存的消息、图片和附件也将无法通过 MCP 读取。数据仍按原消息时间保留 ${RETENTION_DAYS} 天，到期清理；退出不等于立即删除存档。重新加入需要频道管理员操作。</p><form method="post" action="/manage">${csrfInput(s.csrf)}<input type="hidden" name="leave_token" value="${escape(confirmation)}"><label><input type="checkbox" name="confirm" value="leave" required> 我确认让这个 bot 退出上述频道</label><button class="danger" name="action" value="leave_channel">确认退出</button> <a href="/manage#channels">取消</a></form><small>确认有效期 5 分钟，仅能使用一次。退出功能仅在管理页提供。</small>`,
  );
}
