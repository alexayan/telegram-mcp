// HTML form POSTs get Origin: null under no-referrer, breaking strict CSRF checks.
// strict-origin preserves Origin and never sends URL paths or query strings.
export const formReferrerPolicy = "strict-origin";
export const escape = (value: unknown) =>
  String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const csrfInput = (value: string) =>
  `<input type="hidden" name="csrf" value="${escape(value)}">`;
export function page(
  title: string,
  body: string,
  headers: HeadersInit = {},
  status = 200,
) {
  const h = new Headers(headers);
  h.set("Content-Type", "text/html; charset=utf-8");
  h.set("Cache-Control", "no-store");
  h.set(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  h.set("Referrer-Policy", formReferrerPolicy);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  return new Response(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)} · Telegram MCP</title><style>
  :root{font-family:system-ui,sans-serif;color:#e9f0ed;background:#101916;color-scheme:dark}body{max-width:720px;margin:64px auto;padding:0 24px;line-height:1.7}h1{font-size:30px;line-height:1.2}h2{font-size:20px}a{color:#82dfb3}label{display:block;margin:16px 0}input,select,button{font:inherit;padding:12px;border:1px solid #527367;border-radius:7px;background:#192b23;color:inherit;max-width:100%;box-sizing:border-box}input[type=password],input[type=text],select{width:100%}button{cursor:pointer;margin:8px 8px 8px 0;background:#245b43}article{padding:18px 22px;background:#19241f;border:1px solid #345143;border-radius:12px;margin:24px 0}small{color:#a7b9b0}code{overflow-wrap:anywhere}.danger{background:#622f35}nav{margin-top:36px;border-top:1px solid #345143;padding-top:16px}</style>
  <body><small>TELEGRAM / READ-ONLY MCP</small><h1>${escape(title)}</h1>${body}<nav><a href="/">说明</a> · <a href="/manage">管理连接</a></nav></body></html>`,
    { status, headers: h },
  );
}
export function cookie(request: Request, name: string): string {
  return (
    request.headers
      .get("Cookie")
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? ""
  );
}
export const sessionCookie = "__Host-tmcp-session";
export function setCookie(name: string, value: string, maxAge = 600): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}
export function redirect(location: string, headers: HeadersInit = {}) {
  const h = new Headers(headers);
  h.set("Location", location);
  h.set("Cache-Control", "no-store");
  return new Response(null, { status: 303, headers: h });
}
