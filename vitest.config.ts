import { defineConfig } from "vitest/config";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/sync.ts",
      miniflare: {
        compatibilityDate: "2026-08-22",
        compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
        d1Databases: ["DB"],
        kvNamespaces: ["OAUTH_KV"],
        r2Buckets: ["IMAGES"],
        durableObjects: {
          COLLECTORS: { className: "BotCollector", useSQLite: true },
        },
        bindings: {
          PUBLIC_ORIGIN: "https://mcp.example.com",
          BOT_KEYS: JSON.stringify({
            v1: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
          }),
          ACTIVE_KEY_ID: "v1",
        },
      },
    }),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    provide: { migrations: await readD1Migrations("./migrations") },
    fileParallelism: false,
  },
});
