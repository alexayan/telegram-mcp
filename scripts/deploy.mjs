import { checkPrivateImagesBucket } from "./images-bucket.mjs";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
const savedEnvironment = ".cloudflare/production/deployment.env";
if (existsSync(savedEnvironment)) loadEnvFile(savedEnvironment);
const origin = process.env.PUBLIC_ORIGIN;
const database = process.env.D1_DATABASE_ID;
const kv = process.env.OAUTH_KV_ID;
const secrets = process.env.SYNC_SECRETS_FILE;
if (
  !origin ||
  new URL(origin).protocol !== "https:" ||
  new URL(origin).origin !== origin
)
  throw new Error(
    "PUBLIC_ORIGIN must be an HTTPS origin without a trailing slash",
  );
if (
  !database ||
  database === "7e560d01-5666-4b29-8d26-729f9ac60d3c" ||
  !kv ||
  kv === "00000000000000000000000000000001"
)
  throw new Error("Set production D1_DATABASE_ID and OAUTH_KV_ID");
if (!secrets)
  throw new Error(
    "Set SYNC_SECRETS_FILE to a private JSON file containing BOT_KEYS",
  );
const secretValues = JSON.parse(readFileSync(secrets, "utf8"));
if (
  typeof secretValues.BOT_KEYS !== "string" ||
  Buffer.from(
    JSON.parse(secretValues.BOT_KEYS)[process.env.ACTIVE_KEY_ID ?? "v1"] ?? "",
    "base64url",
  ).length !== 32
)
  throw new Error(
    "Secrets file must contain BOT_KEYS as a JSON-encoded key ring with a 32-byte active key",
  );
const run = (args) => {
  const result = spawnSync("cf", args, { stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
checkPrivateImagesBucket();
run(["build"]);
run(["d1", "migrations", "apply", database, "--dir", "migrations"]);
// Only the private worker receives the encryption key. Never pass --secrets-file to the gateway.
run([
  "deploy",
  "--prebuilt",
  "--worker",
  "telegram-mcp-sync",
  "--secrets-file",
  secrets,
]);
run(["deploy", "--prebuilt", "--worker", "telegram-mcp"]);
