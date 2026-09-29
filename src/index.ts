import { formReferrerPolicy } from "./ui";
import OAuthProvider, {
  insufficientScope,
  type OAuthResourceContext,
} from "@cloudflare/workers-oauth-provider";
import { authRoutes, safeAuthError } from "./auth";
import { grantSchema, mcpHandler } from "./mcp";
import { assertScope } from "./store";
import type { Env } from "./types";
export function provider(env: Env) {
  return new OAuthProvider<Env>({
    apiRoute: "/mcp",
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: ["telegram:read", "offline_access"],
    requiredScopes: ["telegram:read"],
    resourceMetadata: {
      resource: `${env.PUBLIC_ORIGIN}/mcp`,
      authorization_servers: [env.PUBLIC_ORIGIN],
    },
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 900,
    refreshTokenTTL: 30 * 86400,
    onError(error) {
      console.warn(
        JSON.stringify({
          event: "oauth_error",
          code: error.code,
          status: error.status,
        }),
      );
    },
    apiHandler: {
      async fetch(request, env, ctx) {
        const auth = (ctx as OAuthResourceContext<unknown>).auth;
        if (!auth.scope.includes("telegram:read"))
          return insufficientScope(auth, ["telegram:read"]);
        const parsed = grantSchema.safeParse(ctx.props);
        if (!parsed.success)
          return new Response("Unauthorized", { status: 401 });
        try {
          await assertScope(env.DB, parsed.data);
        } catch {
          return new Response(
            "Authorization revoked or connection unavailable",
            {
              status: 401,
              headers: {
                "WWW-Authenticate": `Bearer error="invalid_token", resource_metadata="${env.PUBLIC_ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
              },
            },
          );
        }
        return mcpHandler(env, parsed.data)(request, env, ctx);
      },
    },
    defaultHandler: {
      async fetch(request, env) {
        try {
          return await authRoutes(request, env);
        } catch (error) {
          return safeAuthError(error);
        }
      },
    },
  });
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.origin !== env.PUBLIC_ORIGIN)
      return new Response("Invalid host", { status: 421 });
    if (request.method === "POST" && url.pathname !== "/mcp") {
      const { success } = await env.AUTH_LIMIT.limit({
        key: request.headers.get("CF-Connecting-IP") ?? "local",
      });
      if (!success)
        return new Response("Too many requests", {
          status: 429,
          headers: { "Retry-After": "60" },
        });
    }
    const response = await provider(env).fetch(request, env, ctx);
    const safe = new Response(response.body, response);
    safe.headers.set("Cache-Control", "no-store");
    safe.headers.set(
      "Referrer-Policy",
      response.headers.get("Content-Type")?.startsWith("text/html")
        ? formReferrerPolicy
        : "no-referrer",
    );
    safe.headers.set("X-Content-Type-Options", "nosniff");
    return safe;
  },
} satisfies ExportedHandler<Env>;
