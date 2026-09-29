import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { RETENTION_DAYS, RETENTION_SECONDS } from "../config/retention.ts";
const saved = ".cloudflare/production/deployment.env";
if (existsSync(saved)) loadEnvFile(saved);
export const bucket = process.env.R2_BUCKET_NAME ?? "telegram-mcp-images";
function cf(args) {
  const result = spawnSync("cf", args, { encoding: "utf8", env: process.env });
  if (result.status !== 0)
    throw new Error(
      `cf ${args.slice(0, 4).join(" ")} failed. ${result.stderr || result.stdout}`,
    );
  const data = JSON.parse(result.stdout);
  return data.result ?? data;
}
export function checkPrivateImagesBucket() {
  const managed = cf([
    "r2",
    "buckets",
    "domains",
    "managed",
    "list",
    "--bucket-name",
    bucket,
  ]);
  const custom = cf([
    "r2",
    "buckets",
    "domains",
    "custom",
    "list",
    "--bucket-name",
    bucket,
  ]);
  if (
    managed.enabled !== false ||
    !Array.isArray(custom.domains) ||
    custom.domains.some((domain) => domain.enabled !== false)
  )
    throw new Error(
      "Images require a private R2 bucket: disable r2.dev and all custom domains first.",
    );
  console.log(`Verified private image bucket: ${bucket}`);
}
export function prepareImagesBucket() {
  const listed = cf(["r2", "buckets", "list", "--name-contains", bucket]);
  if (!Array.isArray(listed.buckets))
    throw new Error("Unexpected bucket list response");
  if (!listed.buckets.some((item) => item.name === bucket))
    cf([
      "r2",
      "buckets",
      "create",
      "--name",
      bucket,
      "--location-hint",
      "wnam",
    ]);
  checkPrivateImagesBucket();
  const previous = cf(["r2", "buckets", "lifecycle", "get", bucket]);
  const managedRuleIds = ["images", "documents"].flatMap((prefix) => [
    `telegram-${prefix}-30-days`,
    `telegram-${prefix}-retention`,
  ]);
  const rules = (previous.rules ?? []).filter(
    (rule) => !managedRuleIds.includes(rule.id),
  );
  for (const prefix of ["images", "documents"])
    rules.push({
      id: `telegram-${prefix}-retention`,
      enabled: true,
      conditions: { prefix: `${prefix}/` },
      deleteObjectsTransition: {
        condition: { type: "Age", maxAge: RETENTION_SECONDS },
      },
    });
  cf([
    "r2",
    "buckets",
    "lifecycle",
    "update",
    bucket,
    "--body",
    JSON.stringify({ rules }),
    "--force",
  ]);
  console.log(
    `Configured ${RETENTION_DAYS}-day image and document object expiration.`,
  );
}
