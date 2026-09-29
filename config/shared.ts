import { bindings } from "cf/config";
export const database = bindings.d1({
  name: "telegram-mcp",
  id: process.env.D1_DATABASE_ID ?? "7e560d01-5666-4b29-8d26-729f9ac60d3c",
});
export const images = bindings.r2({
  name: process.env.R2_BUCKET_NAME ?? "telegram-mcp-images",
});
export const origin = process.env.PUBLIC_ORIGIN ?? "http://localhost:5173";
// Telegram credentials occur in URL paths. Never automatically capture subrequest traces.
export const privateObservability = {
  enabled: true,
  redactQueryString: true,
  logs: { enabled: true, invocationLogs: false },
  traces: { enabled: false },
};
