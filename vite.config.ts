import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { syncWorker } from "./config/sync.ts";
export default defineConfig({
  plugins: [
    cloudflare({
      auxiliaryWorkers: [
        {
          config: {
            ...syncWorker,
            entrypoint: "./src/sync.ts",
            exports: {
              BotCollector: { type: "durable-object", storage: "sqlite" },
            },
          },
        },
      ],
      persistState: { path: ".cloudflare/state" },
    }),
  ],
  server: { host: "localhost", port: 5173, strictPort: true },
});
