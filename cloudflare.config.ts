import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
import {
  database,
  images,
  origin,
  privateObservability,
} from "./config/shared.ts";
export default defineConfig({
  worker: {
    name: "telegram-mcp",
    entrypoint,
    compatibilityDate: "2026-08-22",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    previewUrls: false,
    env: {
      DB: database,
      IMAGES: images,
      OAUTH_KV: bindings.kv({
        id: process.env.OAUTH_KV_ID ?? "00000000000000000000000000000001",
      }),
      PUBLIC_ORIGIN: bindings.text(origin),
      SYNC: bindings.worker({ worker: "telegram-mcp-sync" }),
      AUTH_LIMIT: bindings.rateLimit({
        namespace: "1001",
        simple: { limit: 20, period: 60 },
      }),
    },
    observability: privateObservability,
  },
});
