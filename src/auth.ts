import { RETENTION_DAYS } from "../config/retention";
import {
  AuthFlowError,
  authFailures,
  reportAuthFailure,
  type AuthFailureCode,
} from "./auth-errors";
import {
  AuthorizationError,
  CimdFetchError,
  type AuthRequest,
} from "@cloudflare/workers-oauth-provider";
import { hash, randomToken } from "./crypto";
import { getInstallation, now } from "./store";
import {
  cookie,
  csrfInput,
  escape,
  page,
  redirect,
  sessionCookie,
  setCookie,
} from "./ui";
import type { Env, Installation, Session } from "./types";
const loginCookie = "__Host-tmcp-login";
const inputToken =
  '<label>Telegram Bot Token<input type="password" name="bot_token" required autocomplete="off" spellcheck="false" maxlength="222"></label>';
async function newSession(env: Env, i: Installation, auth: AuthRequest | null) {
  const token = randomToken();
  await env.DB.prepare(
    "INSERT INTO sessions(token_hash,installation_id,epoch,csrf,auth_request,expires_at) VALUES(?,?,?,?,?,?)",
  )
    .bind(
      await hash(token),
      i.id,
      i.epoch,
      randomToken(),
      auth ? JSON.stringify(auth) : null,
      now() + 600,
    )
    .run();
  return token;
}
async function session(
  env: Env,
  request: Request,
): Promise<{ s: Session; i: Installation } | null> {
  const raw = cookie(request, sessionCookie);
  if (!raw) return null;
  const s = await env.DB.prepare(
    "SELECT * FROM sessions WHERE token_hash=? AND expires_at>?",
  )
    .bind(await hash(raw), now())
    .first<Session>();
  const i = s ? await getInstallation(env.DB, s.installation_id) : null;
  if (!s || !i || s.epoch !== i.epoch) return null;
  return { s, i };
}
async function formData(request: Request, env: Env) {
  if (request.headers.get("Origin") !== env.PUBLIC_ORIGIN)
    throw new AuthFlowError("invalid_origin");
  if (
    !request.headers
      .get("Content-Type")
      ?.startsWith("application/x-www-form-urlencoded")
  )
    throw new AuthFlowError("invalid_form");
  const reader = request.body?.getReader();
  if (!reader) throw new AuthFlowError("invalid_form");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 8192) {
      await reader.cancel();
      throw new AuthFlowError("form_too_large");
    }
    chunks.push(value);
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  const body = new TextDecoder().decode(buffer);
  return new URLSearchParams(body);
}
function consentFacts(details: {
  clientName: string;
  clientDomain?: string;
  redirectHost: string;
  redirectIsLoopback: boolean;
}) {
  return `<article><p>客户端：<strong>${escape(details.clientName)}</strong></p><p>${details.clientDomain ? `客户端域名：${escape(details.clientDomain)}` : "客户端名称由申请方自行声明。"}</p><p>授权返回：<strong>${escape(details.redirectHost)}</strong></p>${details.redirectIsLoopback ? "<p>这是本机应用的回调地址。仅在你刚刚从该应用发起连接时继续。</p>" : ""}<p>权限：<code>telegram:read</code>（读取此 bot 能访问的所有会话及保存的图片和附件，包括未来新增会话）；若客户端请求离线访问，会发放可撤销的 refresh token。</p></article>`;
}
function failureNotice(code: AuthFailureCode) {
  const failure = authFailures[code];
  return `<article role="alert"><h2>${escape(failure.title)}</h2><p>${escape(failure.message)}</p><small>错误代码：<code>${code}</code></small></article>`;
}
async function authorizationPage(
  env: Env,
  auth: AuthRequest,
  failure?: AuthFailureCode,
  previousHeaders?: Headers,
) {
  const details = await env.OAUTH_PROVIDER.describeConsent(auth);
  const consent = await env.OAUTH_PROVIDER.beginConsent(auth);
  // Expire the consumed cookie while issuing a new browser-bound, single-use form.
  for (const value of previousHeaders?.getSetCookie() ?? [])
    consent.headers.append("Set-Cookie", value);
  if (failure) reportAuthFailure(failure);
  const callback = new URL(auth.redirectUri);
  const formDestination =
    callback.origin === "null" ? callback.protocol : callback.origin;
  // Chromium applies form-action to redirects too. The destination was validated by the OAuth provider.
  const formPolicy = `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${formDestination}; frame-ancestors 'none'; base-uri 'none'`;
  const response = page(
    "连接 Telegram",
    `${failure ? failureNotice(failure) : ""}${consentFacts(details)}<p>Bot Token 用于验证 bot 控制权，不代表 Telegram 个人身份。请使用你自己的专用 bot。</p><form method="post" action="/authorize"><input type="hidden" name="handle" value="${escape(consent.handle)}">${inputToken}<p><button name="decision" value="approve">${failure ? "重新验证并连接" : "验证并连接"}</button><button name="decision" value="deny" formnovalidate>取消</button></p></form><small>Token 仅通过 HTTPS POST 提交，不放入 URL。验证成功后自动完成授权，并同步此 bot 可接收的所有会话。</small>`,
    consent.headers,
    failure ? authFailures[failure].status : 200,
  );
  response.headers.set("Content-Security-Policy", formPolicy);
  return response;
}
async function enrollForAuth(env: Env, token: string) {
  try {
    return await env.SYNC.enrollForAuth(token);
  } catch {
    return { ok: false as const, code: "enrollment_unavailable" as const };
  }
}
export async function authRoutes(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") return Response.json({ ok: true });
  if (url.pathname === "/")
    return page(
      "把聊天接入 AI，保留控制权",
      `<p>通过 Telegram 官方 Bot API 接入普通私聊、群聊、频道与 Business/Secretary 会话，只提供查询工具。</p><article><p>MCP 地址：<code>${escape(env.PUBLIC_ORIGIN)}/mcp</code></p><p>在 MCP 客户端添加此地址，按 OAuth 引导连接。验证 Bot Token 后直接完成授权，后台自动同步此 bot 能接收的所有会话，包括未来新增会话。</p></article><h2>开始之前</h2><ol><li>在 BotFather 创建自己的专用 bot。</li><li>群聊：把 bot 加入群，并关闭 Group Privacy Mode；频道：按 Telegram 要求添加 bot。个人账号会话：另行启用 Business/Secretary 模式并连接账号。</li><li>不要让其他服务同时轮询该 bot，也不要配置 webhook。</li></ol><p>只同步接入后的新消息；Telegram 暂存更新最多 24 小时。正文、图片与普通附件保留 ${RETENTION_DAYS} 天。支持照片、JPG/PNG/WebP/GIF 图片文件，以及 PDF、Word、Excel、ZIP 等附件的原始文件和文件名，单个文件最大 20 MB。接收范围由 Telegram 权限决定，不支持 Secret Chats 或账号全部历史。普通群聊/频道的消息删除不会同步通知本服务。</p><p>Bot Token 在私有同步服务内加密保存。聊天正文在 D1 中可查询，图片和附件原文件存入私有对象存储；Cloudflare、服务管理员以及你授权的 AI 客户端仍是信任边界。</p>`,
    );
  if (url.pathname === "/authorize") {
    const oauth = env.OAUTH_PROVIDER;
    if (request.method === "GET") {
      let auth: AuthRequest;
      try {
        auth = await oauth.parseAuthRequest(request);
      } catch (e) {
        if (e instanceof AuthorizationError && e.redirectTo)
          return redirect(e.redirectTo);
        throw e;
      }
      // Require S256 even for confidential clients; the UI never grants write scopes.
      if (!auth.codeChallenge || auth.codeChallengeMethod !== "S256")
        return page(
          "无法授权",
          "<p>此服务要求客户端使用 PKCE S256。</p>",
          {},
          400,
        );
      return authorizationPage(env, auth);
    }
    if (request.method === "POST") {
      const form = await formData(request, env);
      const handle = form.get("handle") ?? "";
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(request, handle);
      // Remember offline access only if this client requested it.
      approved.request.scope = approved.request.scope.includes("offline_access")
        ? ["telegram:read", "offline_access"]
        : ["telegram:read"];
      const result = await enrollForAuth(env, form.get("bot_token") ?? "");
      if (!result.ok)
        return authorizationPage(
          env,
          approved.request,
          result.code,
          approved.headers,
        );
      const i = result.installation;
      await env.SYNC.control(i.bot_id, "resume");
      const complete = await env.OAUTH_PROVIDER.completeAuthorization({
        request: approved.request,
        userId: i.id,
        metadata: { access: "all_bot_chats" },
        scope: approved.request.scope,
        props: { installationId: i.id, access: "bot", epoch: i.epoch },
      });
      approved.headers.append(
        "Set-Cookie",
        setCookie(sessionCookie, await newSession(env, i, null)),
      );
      return redirect(complete.redirectTo, approved.headers);
    }
  }
  if (url.pathname === "/manage" && request.method === "GET") {
    const current = await session(env, request);
    if (!current) {
      const nonce = randomToken();
      return page(
        "管理你的 bot",
        `<p>使用当前有效的 Bot Token 验证控制权。管理会话 10 分钟后失效。</p><form method="post" action="/manage/login">${csrfInput(nonce)}${inputToken}<button>登录</button></form>`,
        { "Set-Cookie": setCookie(loginCookie, nonce) },
      );
    }
    const { s, i } = current;
    return page(
      "连接管理",
      `<article><p>Bot：@${escape(i.username)} · ${escape(i.bot_id)}</p><p>范围：此 bot 可接收的全部会话</p><p>状态：${escape(i.status)} / ${escape(i.error_code ?? "正常")}</p><p>上次同步：${escape(i.last_sync ? new Date(i.last_sync * 1000).toISOString() : "尚未同步")}</p></article><p>撤销会让此 bot 的全部 MCP 授权立即失效。暂停同时停止同步。恢复后，MCP 客户端需要重新授权。</p><form method="post" action="/manage">${csrfInput(s.csrf)}<button name="action" value="revoke">撤销全部 MCP 授权</button><button name="action" value="disconnect">暂停同步并撤销</button><button name="action" value="resume">恢复同步</button></form><article><p>删除会移除数据库中的消息、连接、加密凭证与已保存图片和附件。Cloudflare 备份/恢复窗口由基础设施策略决定。</p><form method="post" action="/manage">${csrfInput(s.csrf)}<label><input type="checkbox" name="confirm" value="delete" required> 我确认删除这个 bot 的全部服务数据</label><button class="danger" name="action" value="delete">删除全部数据</button></form></article>`,
    );
  }
  if (url.pathname === "/manage/login" && request.method === "POST") {
    const form = await formData(request, env);
    const nonce = cookie(request, loginCookie);
    if (!nonce || form.get("csrf") !== nonce)
      return page("请求已失效", "<p>请重新打开管理页面。</p>", {}, 403);
    const result = await enrollForAuth(env, form.get("bot_token") ?? "");
    if (!result.ok) {
      reportAuthFailure(result.code);
      const freshNonce = randomToken();
      return page(
        "管理你的 bot",
        `${failureNotice(result.code)}<form method="post" action="/manage/login">${csrfInput(freshNonce)}${inputToken}<button>重新验证</button></form>`,
        { "Set-Cookie": setCookie(loginCookie, freshNonce) },
        authFailures[result.code].status,
      );
    }
    const i = result.installation;
    const h = new Headers();
    h.append("Set-Cookie", setCookie(loginCookie, "", 0));
    h.append(
      "Set-Cookie",
      setCookie(sessionCookie, await newSession(env, i, null)),
    );
    return redirect("/manage", h);
  }
  if (url.pathname === "/connect")
    return page(
      "连接流程已更新",
      "<p>现在输入 Bot Token 后即可连接并自动同步所有可访问会话。请从 MCP 客户端重新发起授权。</p>",
    );
  if (url.pathname === "/manage" && request.method === "POST") {
    const current = await session(env, request);
    if (!current)
      return page(
        "会话已过期",
        "<p>请从 MCP 客户端重新连接，或<a href='/manage'>重新登录管理页面</a>。</p>",
        {},
        401,
      );
    const { s, i } = current;
    {
      const form = await formData(request, env);
      if (form.get("csrf") !== s.csrf)
        return new Response("Forbidden", { status: 403 });
      const action = form.get("action");
      if (
        !["revoke", "disconnect", "delete", "resume"].includes(action ?? "") ||
        (action === "delete" && form.get("confirm") !== "delete")
      )
        return new Response("Bad request", { status: 400 });
      await env.SYNC.control(
        i.bot_id,
        action as "revoke" | "disconnect" | "delete" | "resume",
      );
      // Epoch checks revoke resource access immediately; also remove OAuth grants/refresh tokens.
      if (action !== "resume") {
        let cursor: string | undefined;
        do {
          const grants = await env.OAUTH_PROVIDER.listUserGrants(i.id, {
            cursor,
          });
          for (const grant of grants.items)
            await env.OAUTH_PROVIDER.revokeGrant(grant.id, i.id);
          cursor = grants.cursor;
        } while (cursor);
      }
      return page(
        "操作完成",
        "<p>设置已更新。旧 MCP 授权已撤销（恢复操作除外）。</p>",
        { "Set-Cookie": setCookie(sessionCookie, "", 0) },
      );
    }
  }
  return new Response("Not found", { status: 404 });
}
export function safeAuthError(error: unknown): Response {
  // Never render raw exceptions, upstream bodies, credential URLs or client metadata.
  const code: AuthFailureCode =
    error instanceof AuthFlowError
      ? error.code
      : error instanceof CimdFetchError
        ? "oauth_client_unavailable"
        : error instanceof AuthorizationError
          ? "oauth_request_invalid"
          : "authorization_unavailable";
  reportAuthFailure(code);
  const failure = authFailures[code];
  return page(
    failure.title,
    `<p>${escape(failure.message)}</p><small>错误代码：<code>${code}</code></small>`,
    {},
    failure.status,
  );
}
