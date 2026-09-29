import { bindings, defineWorker, exports, triggers } from "cf/config";
import { database, images, privateObservability } from "./shared.ts";
export const syncWorker = defineWorker({
  name: "telegram-mcp-sync",
  entrypoint: "./src/sync.ts",
  compatibilityDate: "2026-08-22",
  compatibilityFlags: ["nodejs_compat"],
  workersDev: false,
  previewUrls: false,
  env: {
    DB: database,
    IMAGES: images,
    BOT_KEYS: bindings.secret(),
    ACTIVE_KEY_ID: bindings.text(process.env.ACTIVE_KEY_ID ?? "v1"),
    COLLECTORS: bindings.durableObject({
      worker: "telegram-mcp-sync",
      exportName: "BotCollector",
    }),
  },
  exports: { BotCollector: exports.durableObject({ storage: "sqlite" }) },
  triggers: [triggers.scheduled({ schedule: "*/5 * * * *" })],
  observability: privateObservability,
});
