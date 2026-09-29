import { randomBytes } from "node:crypto";
import { writeFileSync, existsSync } from "node:fs";
const file = ".dev.vars";
if (existsSync(file)) {
  console.log("Local secrets already exist; left unchanged.");
} else {
  writeFileSync(
    file,
    `BOT_KEYS='${JSON.stringify({ v1: randomBytes(32).toString("base64url") })}'\n`,
    { mode: 0o600, flag: "wx" },
  );
  console.log("Created local encryption key (not printed).");
}
