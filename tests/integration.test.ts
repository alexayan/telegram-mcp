import { Buffer } from "node:buffer";
import {
  stageImage,
  processImages,
  readImage,
  cleanupImages,
} from "../src/images";
import { downloadImage } from "../src/image-download";
import {
  stageDocument,
  processDocuments,
  readDocument,
  cleanupDocuments,
} from "../src/documents";
import { downloadFileBytes } from "../src/file-download";
import { MAX_DOCUMENT_BYTES } from "../src/document-metadata";
import { writeInbox, readInbox, minimalUpdate } from "../src/inbox";
import { env as bindings } from "cloudflare:workers";
import {
  applyD1Migrations,
  createExecutionContext,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import {
  beforeEach,
  afterEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from "vitest";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import gateway from "../src/index";
import SyncService from "../src/sync";
import { hash, seal, unseal } from "../src/crypto";
import { isReadOnly, telegram, TelegramError } from "../src/telegram";
import {
  assertScope,
  getInstallation,
  materialize,
  now,
  retain,
  saveConnection,
} from "../src/store";
import { queryMessages, queryChats, grantSchema } from "../src/mcp";
import type {
  Env,
  GrantProps,
  Installation,
  SyncEnv,
  TelegramUpdate,
} from "../src/types";
declare module "vitest" {
  interface ProvidedContext {
    migrations: D1Migration[];
  }
}
const env = bindings as unknown as Env & SyncEnv;
const origin = "https://mcp.example.com";
const token = "123456789:abcdefghijklmnopqrstuvwxyz_0123456789";
const me = {
  id: 123456789,
  username: "testbot",
  can_connect_to_business: true,
};
const connection = {
  id: "conn-a",
  user: { id: 42 },
  is_enabled: true,
  rights: { can_reply: false, can_read_messages: false },
};
const downloads = new Map<string, () => Response>();
const replies = new Map<string, { result: unknown; status: number }[]>();
function mock(method: string, result: unknown, status = 200) {
  const queue = replies.get(method) ?? [];
  queue.push({ result, status });
  replies.set(method, queue);
}
async function registerClient(name: string) {
  const response = await call(
    request("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: name,
        redirect_uris: ["http://localhost:9876/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    }),
  );
  expect(response.status).toBe(201);
  const client = await response.json<{ client_id: string }>();
  return { clientId: client.client_id };
}
function appEnv(): Env {
  return {
    ...env,
    SYNC: new SyncService(
      createExecutionContext(),
      env,
    ) as unknown as Env["SYNC"],
    AUTH_LIMIT: { limit: async () => ({ success: true }) } as RateLimit,
  };
}
const request = (path: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set("Host", new URL(origin).host);
  return new Request(`${origin}${path}`, { ...init, headers });
};
const call = (r: Request) =>
  gateway.fetch(r, appEnv(), createExecutionContext());
const post = (path: string, form: Record<string, string>, cookie = "") =>
  request(path, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookie,
    },
    body: new URLSearchParams(form),
  });
function cookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}
const hidden = (html: string, name: string) =>
  html.match(new RegExp(`name="${name}" value="([^"]+)"`))![1];
async function fixture(): Promise<{ i: Installation; scope: GrantProps }> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO installations(id,bot_id,username,status,created_at) VALUES(?,?,?,'active',?)",
  )
    .bind(id, id, "fixture", now())
    .run();
  await saveConnection(env.DB, id, connection);
  await env.DB.prepare(
    "UPDATE connections SET selected=1 WHERE installation_id=?",
  )
    .bind(id)
    .run();
  return {
    i: (await getInstallation(env.DB, id))!,
    scope: { installationId: id, access: "bot", epoch: 1 },
  };
}
const msg = (
  n: number,
  text: string,
  cid = "conn-a",
  chat = 77,
): TelegramUpdate => ({
  update_id: n,
  business_message: {
    message_id: n,
    business_connection_id: cid,
    chat: { id: chat, title: "Chat" },
    date: now(),
    text,
  },
});
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, inject("migrations"));
  replies.clear();
  downloads.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | Request, init?: RequestInit) => {
      // Exercise workerd's Request constructor even when the network response is mocked.
      const url = new Request(input, init).url;
      if (url.startsWith("https://api.telegram.org/file/")) {
        const response = downloads.get(url.split("/").at(-1)!);
        if (!response) throw new Error("Unexpected file request");
        return response();
      }
      const method = url.split("/").at(-1)!;
      const reply = replies.get(method)?.shift();
      if (!reply) throw new Error(`Blocked unexpected fetch ${url}`);
      return Response.json(
        reply.status === 200
          ? { ok: true, result: reply.result }
          : {
              ok: false,
              error_code: reply.status,
              parameters: { retry_after: 120 },
            },
        { status: reply.status },
      );
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("privacy and tenant isolation", () => {
  it("encrypts with random nonces, authenticates identity and supports key rotation", async () => {
    const a = await seal(token, "bot:a", env.BOT_KEYS, "v1"),
      b = await seal(token, "bot:a", env.BOT_KEYS, "v1");
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(JSON.stringify(a)).not.toContain(token);
    expect(await unseal(a, "bot:a", env.BOT_KEYS)).toBe(token);
    await expect(unseal(a, "bot:b", env.BOT_KEYS)).rejects.toThrow();
  });
  it("identifies Telegram mutation rights while MCP remains read-only", () => {
    expect(isReadOnly(connection)).toBe(true);
    for (const rights of [
      { can_reply: true },
      { can_read_messages: true },
      { future_permission: true },
    ] as Record<string, boolean>[])
      expect(isReadOnly({ ...connection, rights })).toBe(false);
    expect(isReadOnly({ ...connection, rights: undefined })).toBe(true);
  });
  it("isolates installation + connection even when chat/message IDs overlap", async () => {
    const a = await fixture(),
      b = await fixture();
    await materialize(env.DB, a.i.id, msg(1, "A 中文 100%"));
    await materialize(env.DB, b.i.id, msg(1, "B private"));
    await saveConnection(env.DB, a.i.id, { ...connection, id: "conn-b" });
    await env.DB.prepare(
      "UPDATE connections SET selected=1 WHERE connection_id='conn-b'",
    ).run();
    await materialize(env.DB, a.i.id, msg(1, "Other account secret", "conn-b"));
    expect(
      await queryMessages(env.DB, a.scope, { query: "中文", limit: 20 }),
    ).toMatchObject([{ text: "A 中文 100%" }]);
    expect(
      await queryMessages(env.DB, a.scope, { query: "private", limit: 20 }),
    ).toEqual([]);
    expect(await queryMessages(env.DB, a.scope, { limit: 20 })).toHaveLength(2);
    expect(
      await queryMessages(env.DB, a.scope, {
        source_key: "business:conn-b",
        limit: 20,
      }),
    ).toMatchObject([{ text: "Other account secret" }]);
    expect(
      await queryMessages(env.DB, a.scope, {
        source_key: "business:' OR 1=1 --",
        limit: 20,
      }),
    ).toEqual([]);
    expect(
      grantSchema.safeParse({
        installationId: a.i.id,
        connectionId: "conn-a",
        epoch: 1,
      }).success,
    ).toBe(false);
    await expect(
      assertScope(env.DB, {
        installationId: a.i.id,
        connectionId: "conn-a",
        epoch: 1,
      } as unknown as GrantProps),
    ).rejects.toThrow("access_revoked");

    expect(
      await queryMessages(env.DB, a.scope, { query: "%", limit: 20 }),
    ).toHaveLength(1);
    expect(
      await queryMessages(env.DB, a.scope, { query: "' OR 1=1 --", limit: 20 }),
    ).toEqual([]);
    expect(
      await queryMessages(env.DB, a.scope, { chat_id: "999", limit: 20 }),
    ).toEqual([]);
  });
  it("does not persist unverified Business content; stale edits cannot resurrect deletions", async () => {
    const { i, scope } = await fixture();
    await materialize(env.DB, i.id, msg(1, "hidden", "unknown"));
    await materialize(env.DB, i.id, msg(2, "original"));
    await materialize(env.DB, i.id, {
      update_id: 4,
      deleted_business_messages: {
        business_connection_id: "conn-a",
        chat: { id: 77 },
        message_ids: [2],
      },
    });
    const stale = msg(3, "stale");
    stale.business_message!.message_id = 2;
    await materialize(env.DB, i.id, stale);
    expect(await queryMessages(env.DB, scope, { limit: 20 })).toEqual([]);
    const row = await env.DB.prepare(
      "SELECT text,deleted FROM messages",
    ).first();
    expect(row).toEqual({ text: null, deleted: 1 });
  });
  it("blocks stale authorization immediately and hides expired messages before cleanup", async () => {
    const { i, scope } = await fixture();
    const old = msg(1, "too old");
    old.business_message!.date = now() - 91 * 86400;
    await materialize(env.DB, i.id, old);
    expect(await queryMessages(env.DB, scope, { limit: 20 })).toEqual([]);
    await env.DB.prepare("UPDATE installations SET epoch=2 WHERE id=?")
      .bind(i.id)
      .run();
    await expect(assertScope(env.DB, scope)).rejects.toThrow("access_revoked");
    await retain(env.DB);
  });
  it("redacts Telegram exceptions instead of disclosing token URL", async () => {
    await expect(telegram(token, "getMe")).rejects.toThrow("telegram_503");
    try {
      await telegram(token, "getMe");
    } catch (e) {
      expect(String(e)).not.toContain(token);
      expect(e).toBeInstanceOf(TelegramError);
    }
  });
});

describe("message time ranges", () => {
  const iso = (seconds: number) =>
    new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
  async function timedMessage(
    installationId: string,
    id: number,
    date: number,
  ) {
    const update = msg(id, `range message ${id}`);
    update.business_message!.date = date;
    await materialize(env.DB, installationId, update);
  }
  it("includes the start, excludes the end, and applies bounds before pagination", async () => {
    const { i, scope } = await fixture();
    const start = now() - 7200;
    for (const [id, date] of [
      [1, start - 1],
      [2, start],
      [3, start + 1],
      [4, start + 2],
    ])
      await timedMessage(i.id, id!, date!);
    const input = {
      source_key: "business:conn-a",
      chat_id: "77",
      start_time: start,
      end_time: start + 2,
      limit: 10,
    };
    expect(await queryMessages(env.DB, scope, input)).toMatchObject([
      { message_id: 3 },
      { message_id: 2 },
    ]);
    expect(
      await queryMessages(env.DB, scope, { ...input, limit: 1 }),
    ).toMatchObject([{ message_id: 3 }]);
    expect(
      await queryMessages(env.DB, scope, { ...input, before_message_id: 3 }),
    ).toMatchObject([{ message_id: 2 }]);
    expect(
      await queryMessages(env.DB, scope, {
        ...input,
        query: "range message",
        limit: 1,
        offset: 1,
      }),
    ).toMatchObject([{ message_id: 2 }]);
    expect(await queryMessages(env.DB, scope, { limit: 10 })).toHaveLength(4);
  });
  it("accepts either bound alone and normalizes explicit timezones", async () => {
    const { i, scope } = await fixture();
    const start = now() - 7200;
    await timedMessage(i.id, 1, start - 1);
    await timedMessage(i.id, 2, start);
    await timedMessage(i.id, 3, start + 1);
    expect(
      await queryMessages(env.DB, scope, { start_time: start, limit: 10 }),
    ).toMatchObject([{ message_id: 3 }, { message_id: 2 }]);
    expect(
      await queryMessages(env.DB, scope, { end_time: start, limit: 10 }),
    ).toMatchObject([{ message_id: 1 }]);
    const inOffset = iso(start + 8 * 3600).replace("Z", "+08:00");
    expect(
      await queryMessages(env.DB, scope, {
        start_time: inOffset,
        end_time: iso(start + 1),
        limit: 10,
      }),
    ).toMatchObject([{ message_id: 2, sent_at: start }]);
    expect(
      await queryMessages(env.DB, scope, { start_time: 0, limit: 10 }),
    ).toHaveLength(3);
  });
  it("filters edited messages by their original send time", async () => {
    const { i, scope } = await fixture();
    const start = now() - 7200;
    await timedMessage(i.id, 1, start);
    const edit = msg(2, "edited after the requested range");
    edit.business_message!.message_id = 1;
    edit.business_message!.date = start;
    edit.business_message!.edit_date = start + 3600;
    await materialize(env.DB, i.id, {
      update_id: 2,
      edited_business_message: edit.business_message,
    });
    expect(
      await queryMessages(env.DB, scope, {
        start_time: start,
        end_time: start + 1,
        limit: 10,
      }),
    ).toMatchObject([
      { text: "edited after the requested range", sent_at: start },
    ]);
  });
  it("applies the range to filename search as well as message text", async () => {
    const { i, scope } = await fixture();
    const start = now() - 7200;
    for (const id of [1, 2]) {
      const update = documentUpdate(id, `range-doc-${id}`, "range-report.pdf");
      update.message!.date = start + id - 1;
      await materialize(env.DB, i.id, update);
      await stageDocument(env, i.id, update);
    }
    expect(
      await queryMessages(env.DB, scope, {
        query: "range-report.pdf",
        start_time: start,
        end_time: start + 1,
        limit: 10,
      }),
    ).toMatchObject([{ message_id: 1, file_name: "range-report.pdf" }]);
  });
  it("preserves tenant, chat, deletion and retention restrictions with broad bounds", async () => {
    const a = await fixture(),
      b = await fixture();
    const start = now() - 7200;
    await timedMessage(a.i.id, 1, start);
    await timedMessage(b.i.id, 2, start);
    await timedMessage(a.i.id, 3, start);
    await env.DB.prepare("UPDATE messages SET sent_at=? WHERE message_id=3")
      .bind(now() - 91 * 86400)
      .run();
    await materialize(env.DB, a.i.id, msg(4, "hidden chat", "conn-a", 88));
    await env.DB.prepare("UPDATE chats SET enabled=0 WHERE chat_id='88'").run();
    await timedMessage(a.i.id, 5, start);
    await materialize(env.DB, a.i.id, {
      update_id: 6,
      deleted_business_messages: {
        business_connection_id: "conn-a",
        chat: { id: 77 },
        message_ids: [5],
      },
    });
    await saveConnection(env.DB, a.i.id, { ...connection, id: "disabled" });
    await materialize(env.DB, a.i.id, msg(7, "hidden connection", "disabled"));
    await saveConnection(env.DB, a.i.id, {
      ...connection,
      id: "disabled",
      is_enabled: false,
    });
    expect(
      await queryMessages(env.DB, a.scope, {
        start_time: 0,
        end_time: now() + 3600,
        limit: 100,
      }),
    ).toMatchObject([{ message_id: 1 }]);
  });
  it("rejects ambiguous or invalid times and non-increasing ranges", async () => {
    const { scope } = await fixture();
    for (const value of [
      "2026-09-29",
      "2026-09-29T00:00:00",
      "2026-02-30T00:00:00Z",
      "2026-09-29T00:00:00.123Z",
      "2026-09-29T00:00:00+25:00",
      "not a date",
      "1790611200",
      -1,
      1.5,
      Date.now(),
      NaN,
      Infinity,
      "1969-12-31T23:59:59Z",
    ]) {
      for (const key of ["start_time", "end_time"]) {
        await expect(
          queryMessages(env.DB, scope, { [key]: value, limit: 10 }),
        ).rejects.toThrow(`${key} must be`);
      }
    }
    for (const end of [100, 99])
      await expect(
        queryMessages(env.DB, scope, {
          start_time: 100,
          end_time: end,
          limit: 10,
        }),
      ).rejects.toThrow("start_time must be earlier than end_time");
  });
});

describe("all bot chats", () => {
  it("migrates existing archives without losing data or resuming paused installations", async () => {
    await reset();
    const migrations = inject("migrations");
    await applyD1Migrations(env.DB, migrations.slice(0, 1));
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO installations(id,bot_id,username,created_at,status) VALUES('old','1','old',?,'pending'),('paused','2','paused',?,'paused')",
      ).bind(now(), now()),
      env.DB.prepare(
        "INSERT INTO connections(installation_id,connection_id,owner_id,enabled,read_only,selected) VALUES('old','before','3',1,1,1)",
      ),
      env.DB.prepare(
        "INSERT INTO messages(installation_id,source_key,chat_id,message_id,chat_title,sent_at,text,last_update) VALUES('old','business:before','77',9,'Existing',?,'preserved',10)",
      ).bind(now()),
    ]);
    await applyD1Migrations(env.DB, migrations.slice(1));
    expect(await env.DB.prepare("SELECT text FROM messages").first()).toEqual({
      text: "preserved",
    });
    expect(
      await env.DB.prepare(
        "SELECT source_key,chat_id,title FROM chats",
      ).first(),
    ).toEqual({
      source_key: "business:before",
      chat_id: "77",
      title: "Existing",
    });
    expect((await getInstallation(env.DB, "old"))?.status).toBe("active");
    expect((await getInstallation(env.DB, "paused"))?.status).toBe("paused");
  });
  it("separates overlapping sources, handles group edits and membership revocation, and discovers empty chats", async () => {
    const { i, scope } = await fixture();
    const ordinary: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: 77, type: "private", first_name: "Bot DM" },
        date: now(),
        text: "ordinary private",
      },
    };
    await materialize(env.DB, i.id, ordinary);
    await materialize(env.DB, i.id, msg(1, "business private"));
    const group: TelegramUpdate = {
      update_id: 2,
      message: {
        message_id: 2,
        message_thread_id: 7,
        chat: { id: -100200, type: "supergroup", title: "Group" },
        date: now(),
        text: "original group",
      },
    };
    await materialize(env.DB, i.id, group);
    await materialize(env.DB, i.id, {
      update_id: 4,
      edited_message: {
        ...group.message!,
        text: "edited group",
        edit_date: now(),
      },
    });
    await materialize(env.DB, i.id, {
      update_id: 3,
      edited_message: { ...group.message!, text: "stale group" },
    });
    await materialize(env.DB, i.id, {
      update_id: 5,
      channel_post: {
        message_id: 9,
        chat: { id: -100300, type: "channel", title: "Channel" },
        date: now(),
        text: "channel post",
      },
    });
    expect(
      await queryMessages(env.DB, scope, {
        source_key: "bot",
        chat_id: "77",
        limit: 30,
      }),
    ).toMatchObject([{ text: "ordinary private" }]);
    expect(
      await queryMessages(env.DB, scope, {
        source_key: "business:conn-a",
        chat_id: "77",
        limit: 30,
      }),
    ).toMatchObject([{ text: "business private" }]);
    expect(
      await queryMessages(env.DB, scope, {
        source_key: "bot",
        chat_id: "-100200",
        limit: 30,
      }),
    ).toMatchObject([{ text: "edited group", message_thread_id: 7 }]);
    expect(await queryChats(env.DB, scope, { limit: 30 })).toHaveLength(4);
    const membership = (update_id: number, status: string): TelegramUpdate => ({
      update_id,
      my_chat_member: {
        chat: group.message!.chat,
        new_chat_member: { status },
      },
    });
    await materialize(env.DB, i.id, membership(10, "left"));
    await materialize(env.DB, i.id, { ...group, update_id: 9 });
    expect(
      await queryMessages(env.DB, scope, { chat_id: "-100200", limit: 30 }),
    ).toEqual([]);
    expect(await queryChats(env.DB, scope, { limit: 30 })).toHaveLength(3);
    await materialize(env.DB, i.id, membership(11, "member"));
    expect(
      await queryMessages(env.DB, scope, { chat_id: "-100200", limit: 30 }),
    ).toHaveLength(1);
    await materialize(env.DB, i.id, {
      update_id: 12,
      my_chat_member: {
        chat: { id: -99, type: "group", title: "New group" },
        new_chat_member: { status: "member" },
      },
    });
    expect(await queryChats(env.DB, scope, { limit: 30 })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ chat_id: "-99", message_count: 0 }),
      ]),
    );
    const serialized = JSON.stringify(
      minimalUpdate({
        update_id: 20,
        message: {
          ...ordinary.message!,
          document: { file_id: "retained-document", file_name: "report.pdf" },
          reply_to_message: { text: "do-not-store" },
        },
      } as TelegramUpdate),
    );
    expect(serialized).not.toContain("do-not-store");
    expect(serialized).toContain("retained-document");
  });
  it("automatically collects all message sources and future Business connections without selection", async () => {
    mock("getMe", { ...me, can_connect_to_business: false });
    mock("getWebhookInfo", { url: "" });
    const i = await appEnv().SYNC.enroll(token);
    expect(i.status).toBe("active");
    const scope: GrantProps = {
      installationId: i.id,
      epoch: i.epoch,
      access: "bot",
    };
    // A bot-wide token is valid even before the first chat arrives.
    expect(await queryChats(env.DB, scope, { limit: 30 })).toEqual([]);
    const a = { ...connection, rights: { can_reply: true } };
    const b = { ...connection, id: "conn-b" };
    const dm = {
      message_id: 1,
      chat: { id: 77, type: "private" as const },
      date: now(),
      text: "bot DM",
    };
    mock("getWebhookInfo", { url: "" });
    mock("getUpdates", [
      { update_id: 1, business_connection: a },
      { update_id: 2, business_connection: b },
      msg(3, "business A"),
      msg(4, "business B", "conn-b"),
      { update_id: 5, message: dm },
      {
        update_id: 6,
        message: { ...dm, chat: { id: -10, type: "group" }, text: "group" },
      },
      {
        update_id: 7,
        channel_post: {
          ...dm,
          chat: { id: -20, type: "channel" },
          text: "channel",
        },
      },
      {
        update_id: 8,
        edited_channel_post: {
          ...dm,
          chat: { id: -20, type: "channel" },
          text: "edited channel",
          edit_date: now(),
        },
      },
    ]);
    const stub = env.COLLECTORS.getByName(String(me.id));
    await runDurableObjectAlarm(stub);
    expect((await getInstallation(env.DB, i.id))?.error_code).toBeNull();
    expect(await queryChats(env.DB, scope, { limit: 30 })).toHaveLength(5);
    expect(await queryMessages(env.DB, scope, { limit: 30 })).toHaveLength(5);
    expect(
      await queryMessages(env.DB, scope, {
        query: "edited channel",
        limit: 30,
      }),
    ).toHaveLength(1);
    // No selected flag is needed; Telegram write rights do not enable any write API in our service.
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM connections WHERE selected=1",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(0);
    const polling = vi
      .mocked(fetch)
      .mock.calls.find(([input]) => String(input).endsWith("/getUpdates"));
    expect(JSON.parse(String(polling?.[1]?.body)).allowed_updates).toEqual(
      expect.arrayContaining([
        "message",
        "edited_message",
        "channel_post",
        "edited_channel_post",
        "my_chat_member",
        "business_message",
      ]),
    );
    expect(
      vi
        .mocked(fetch)
        .mock.calls.every(([input]) =>
          /\/(getMe|getWebhookInfo|getUpdates|getBusinessConnection)$/.test(
            String(input),
          ),
        ),
    ).toBe(true);
    // New Business connections become visible without a second OAuth flow.
    mock("getUpdates", [
      { update_id: 9, business_connection: { ...connection, id: "future" } },
      msg(10, "future chat", "future"),
    ]);
    await runDurableObjectAlarm(stub);
    expect(
      await queryMessages(env.DB, scope, { query: "future chat", limit: 30 }),
    ).toHaveLength(1);
    mock("getUpdates", [
      {
        update_id: 11,
        business_connection: { ...connection, id: "future", is_enabled: false },
      },
    ]);
    await runDurableObjectAlarm(stub);
    expect(
      await queryMessages(env.DB, scope, { query: "future chat", limit: 30 }),
    ).toEqual([]);
  });
});

describe("browser channel management", () => {
  const channelPost = (
    id: number,
    chatId = -100700,
    title = "Managed channel",
  ): TelegramUpdate => ({
    update_id: id,
    channel_post: {
      message_id: id,
      chat: { id: chatId, type: "channel", title },
      date: now(),
      text: "Channel content",
    },
  });
  async function login() {
    const first = await call(request("/manage"));
    mock("getMe", me);
    mock("getWebhookInfo", { url: "" });
    const loggedIn = await call(
      post(
        "/manage/login",
        {
          csrf: hidden(await first.text(), "csrf"),
          bot_token: token,
        },
        cookies(first),
      ),
    );
    expect(loggedIn.status).toBe(303);
    const cookie = cookies(loggedIn);
    const i = (await env.DB.prepare(
      "SELECT * FROM installations WHERE bot_id=?",
    )
      .bind(String(me.id))
      .first<Installation>())!;
    const html = await (
      await call(request("/manage", { headers: { Cookie: cookie } }))
    ).text();
    return { i, cookie, csrf: hidden(html, "csrf") };
  }
  async function prepare(
    a: Awaited<ReturnType<typeof login>>,
    chatId = "-100700",
  ) {
    const preview = await call(
      post(
        "/manage",
        { csrf: a.csrf, action: "leave_preview", chat_id: chatId },
        a.cookie,
      ),
    );
    expect(preview.status).toBe(200);
    const html = await preview.text();
    return {
      html,
      form: {
        csrf: a.csrf,
        action: "leave_channel",
        confirm: "leave",
        leave_token: hidden(html, "leave_token"),
      },
    };
  }
  const stateOf = (i: Installation) =>
    env.DB.prepare(
      "SELECT enabled,left_at,leave_pending FROM chats WHERE installation_id=? AND source_key='bot' AND chat_id='-100700'",
    )
      .bind(i.id)
      .first<{
        enabled: number;
        left_at: number | null;
        leave_pending: number;
      }>();
  it("lists this bot's channels with escaping and pagination, excluding private chats", async () => {
    const a = await login(),
      other = await fixture();
    for (let n = 0; n < 22; n++)
      await materialize(env.DB, a.i.id, channelPost(n + 1, -100700 - n));
    await materialize(
      env.DB,
      a.i.id,
      channelPost(50, -100700, '<script>alert("channel")</script>'),
    );
    await materialize(
      env.DB,
      other.i.id,
      channelPost(1, -100900, "Other tenant channel"),
    );
    await materialize(env.DB, a.i.id, {
      update_id: 51,
      message: {
        ...channelPost(51).channel_post!,
        chat: { id: 99, type: "private", title: "Private chat" },
      },
    });
    const listing = await call(
      request("/manage", { headers: { Cookie: a.cookie } }),
    );
    const html = await listing.text();
    expect(html).toContain("&#60;script&#62;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("Other tenant channel");
    expect(html).not.toContain("Private chat");
    expect(html).not.toContain("Channel content");
    expect(html.match(/value="leave_preview"/g)).toHaveLength(20);
    const next = html.match(/href="(\/manage\?after_channel=[^"]+)"/)![1];
    const second = await (
      await call(request(next, { headers: { Cookie: a.cookie } }))
    ).text();
    expect(second.match(/value="leave_preview"/g)).toHaveLength(2);
    expect(second).not.toContain("下一页");
    expect(listing.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
  });
  it.each([
    {
      type: "group" as const,
      label: "普通群组",
      member: { status: "member" },
      leaves: true,
    },
    {
      type: "supergroup" as const,
      label: "超级群组",
      member: { status: "administrator" },
      leaves: true,
    },
    {
      type: "supergroup" as const,
      label: "超级群组",
      member: { status: "restricted", is_member: true },
      leaves: true,
    },
    {
      type: "supergroup" as const,
      label: "超级群组",
      member: { status: "restricted", is_member: false },
      leaves: false,
    },
  ])(
    "shows and manages $type with membership $member",
    async ({ type, label, member, leaves }) => {
      const a = await login();
      await materialize(env.DB, a.i.id, {
        update_id: 1,
        message: {
          ...channelPost(1).channel_post!,
          chat: { id: -100700, type, title: "Managed group" },
        },
      });
      // A Business chat is not a group the bot can leave, even if metadata says supergroup.
      await saveConnection(env.DB, a.i.id, connection);
      const business = msg(2, "Business content", "conn-a", -100900);
      business.business_message!.chat = {
        id: -100900,
        type,
        title: "Business-only group",
      };
      await materialize(env.DB, a.i.id, business);
      const html = await (
        await call(request("/manage", { headers: { Cookie: a.cookie } }))
      ).text();
      expect(html).toContain("Managed group");
      expect(html).toContain(`类型：${label}`);
      expect(html).toContain("Leave · 退出群组");
      expect(html).not.toContain("Business-only group");
      expect(
        (
          await call(
            post(
              "/manage",
              { csrf: a.csrf, action: "leave_preview", chat_id: "-100900" },
              a.cookie,
            ),
          )
        ).status,
      ).toBe(404);
      const confirmation = await prepare(a);
      expect(confirmation.html).toContain(`类型：${label}`);
      vi.mocked(fetch).mockClear();
      mock("getChatMember", member);
      if (leaves) mock("leaveChat", true);
      const result = await call(post("/manage", confirmation.form, a.cookie));
      expect(result.status).toBe(303);
      expect(result.headers.get("Location")).toContain(
        leaves ? "channel_notice=left" : "channel_notice=already_left",
      );
      expect(
        vi
          .mocked(fetch)
          .mock.calls.filter(([url]) => String(url).endsWith("/leaveChat")),
      ).toHaveLength(leaves ? 1 : 0);
      expect(await stateOf(a.i)).toMatchObject({
        enabled: 0,
        leave_pending: 0,
      });
    },
  );
  it("requires confirmation, leaves exactly once and hides messages and saved media", async () => {
    const a = await login();
    const image = channelPost(1);
    image.channel_post!.photo = [
      { file_id: "channel-photo", width: 1, height: 1 },
    ];
    const doc = channelPost(2);
    doc.channel_post!.document = {
      file_id: "channel-pdf",
      file_name: "channel.pdf",
      mime_type: "application/pdf",
    };
    await materialize(env.DB, a.i.id, image);
    await stageImage(env, a.i.id, image);
    await materialize(env.DB, a.i.id, doc);
    await stageDocument(env, a.i.id, doc);
    mock("getFile", { file_path: "photos/channel.png" });
    downloads.set("channel.png", () => new Response(png));
    await processImages(env, a.i.id, token);
    mock("getFile", { file_path: "documents/channel.pdf" });
    downloads.set("channel.pdf", () => new Response(pdf));
    await processDocuments(env, a.i.id, token);
    const imageId = (await env.DB.prepare("SELECT id FROM images").first<{
      id: string;
    }>())!.id;
    const docId = (await env.DB.prepare("SELECT id FROM documents").first<{
      id: string;
    }>())!.id;
    const scope: GrantProps = {
      installationId: a.i.id,
      access: "bot",
      epoch: a.i.epoch,
    };
    expect(await readImage(env, scope, imageId)).toBeTruthy();
    expect(await readDocument(env, scope, docId)).toBeTruthy();
    const prepared = await prepare(a);
    expect(prepared.html).toContain("Managed channel");
    expect(prepared.html).toContain("-100700");
    const session = (await env.DB.prepare(
      "SELECT token_hash,leave_token_hash FROM sessions",
    ).first<{ token_hash: string; leave_token_hash: string }>())!;
    expect(session.leave_token_hash).toBe(
      await hash(prepared.form.leave_token),
    );
    expect(session.leave_token_hash).not.toBe(prepared.form.leave_token);
    vi.mocked(fetch).mockClear();
    mock("getChatMember", { status: "administrator" });
    mock("leaveChat", true);
    const responses = await Promise.all([
      call(post("/manage", prepared.form, a.cookie)),
      call(post("/manage", prepared.form, a.cookie)),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([303, 409]);
    const calls = vi.mocked(fetch).mock.calls;
    expect(
      calls.filter(([url]) => String(url).endsWith("/leaveChat")),
    ).toHaveLength(1);
    expect(JSON.parse(calls[0]![1]!.body as string)).toEqual({
      chat_id: "-100700",
      user_id: me.id,
    });
    expect(JSON.parse(calls[1]![1]!.body as string)).toEqual({
      chat_id: "-100700",
    });
    expect(await stateOf(a.i)).toMatchObject({ enabled: 0, leave_pending: 0 });
    expect(await queryMessages(env.DB, scope, { limit: 10 })).toEqual([]);
    expect(await queryChats(env.DB, scope, { limit: 10 })).toEqual([]);
    expect(await readImage(env, scope, imageId)).toBeNull();
    expect(await readDocument(env, scope, docId)).toBeNull();
    expect((await getInstallation(env.DB, a.i.id))!.epoch).toBe(a.i.epoch);
    // Newer delivery IDs do not make old messages or pre-leave membership updates authoritative.
    const leftAt = (await stateOf(a.i))!.left_at!;
    await materialize(env.DB, a.i.id, channelPost(100));
    await materialize(
      env.DB,
      a.i.id,
      minimalUpdate({
        update_id: 101,
        my_chat_member: {
          chat: image.channel_post!.chat,
          date: leftAt - 1,
          new_chat_member: { status: "administrator" },
        },
      }),
    );
    expect(await queryMessages(env.DB, scope, { limit: 10 })).toEqual([]);
    await materialize(
      env.DB,
      a.i.id,
      minimalUpdate({
        update_id: 102,
        my_chat_member: {
          chat: image.channel_post!.chat,
          date: leftAt + 1,
          new_chat_member: { status: "administrator" },
        },
      }),
    );
    expect(await stateOf(a.i)).toMatchObject({ enabled: 1, left_at: null });
    expect(await queryMessages(env.DB, scope, { limit: 10 })).toHaveLength(2);
  });
  it("rejects unauthenticated, cross-origin, forged, cross-tenant and private-chat requests", async () => {
    const a = await login(),
      other = await fixture();
    await materialize(env.DB, a.i.id, channelPost(1));
    await materialize(env.DB, other.i.id, channelPost(2, -100900));
    await materialize(env.DB, a.i.id, {
      update_id: 3,
      message: {
        ...channelPost(3).channel_post!,
        chat: { id: 99, type: "private" },
      },
    });
    vi.mocked(fetch).mockClear();
    const form = { csrf: a.csrf, action: "leave_preview", chat_id: "-100700" };
    expect((await call(post("/manage", form))).status).toBe(401);
    expect(
      (await call(post("/manage", { ...form, csrf: "forged" }, a.cookie)))
        .status,
    ).toBe(403);
    const crossOrigin = post("/manage", form, a.cookie);
    crossOrigin.headers.set("Origin", "https://evil.example");
    expect((await call(crossOrigin)).status).toBe(403);
    for (const chat_id of ["-100900", "99", "@arbitrary", "-1' OR 1=1--"])
      expect(
        (await call(post("/manage", { ...form, chat_id }, a.cookie))).status,
      ).toBe(404);
    const prepared = await prepare(a);
    expect(
      (await call(post("/manage", { ...prepared.form, confirm: "" }, a.cookie)))
        .status,
    ).toBe(400);
    expect(
      (
        await call(
          post(
            "/manage",
            { ...prepared.form, leave_token: "x".repeat(43) },
            a.cookie,
          ),
        )
      ).status,
    ).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("binds confirmations to the session, installation, epoch and expiry", async () => {
    const a = await login();
    await materialize(env.DB, a.i.id, channelPost(1));
    const prepared = await prepare(a);
    const session = (await env.DB.prepare(
      "SELECT token_hash FROM sessions",
    ).first<{ token_hash: string }>())!;
    const other = await env.COLLECTORS.getByName("other-bot").enroll(
      token,
      "456789123",
      "other",
    );
    vi.mocked(fetch).mockClear();
    expect(
      await env.COLLECTORS.getByName("other-bot").leaveChannel(
        session.token_hash,
        await hash(prepared.form.leave_token),
      ),
    ).toBe("invalid_request");
    await env.DB.prepare("UPDATE sessions SET leave_expires_at=?")
      .bind(now() - 1)
      .run();
    expect((await call(post("/manage", prepared.form, a.cookie))).status).toBe(
      409,
    );
    const fresh = await prepare(a);
    await env.DB.prepare("UPDATE installations SET epoch=epoch+1 WHERE id=?")
      .bind(a.i.id)
      .run();
    expect(
      await env.COLLECTORS.getByName(a.i.bot_id).leaveChannel(
        session.token_hash,
        await hash(fresh.form.leave_token),
      ),
    ).toBe("invalid_request");
    expect((await call(post("/manage", fresh.form, a.cookie))).status).toBe(
      401,
    );
    expect(other.id).not.toBe(a.i.id);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves access on Telegram rejection and respects retry_after", async () => {
    const a = await login();
    await materialize(env.DB, a.i.id, channelPost(1));
    mock("getChatMember", { status: "administrator" });
    mock("leaveChat", null, 403);
    const first = await call(
      post("/manage", (await prepare(a)).form, a.cookie),
    );
    expect(first.status).toBe(503);
    expect(await first.text()).not.toContain(token);
    expect(await stateOf(a.i)).toMatchObject({
      enabled: 1,
      left_at: null,
      leave_pending: 0,
    });
    mock("getChatMember", { status: "administrator" });
    mock("leaveChat", null, 429);
    const limited = await call(
      post("/manage", (await prepare(a)).form, a.cookie),
    );
    expect(await limited.text()).toContain("请求过于频繁");
    vi.mocked(fetch).mockClear();
    const retry = await call(
      post("/manage", (await prepare(a)).form, a.cookie),
    );
    expect(await retry.text()).toContain("请求过于频繁");
    expect(fetch).not.toHaveBeenCalled();
    expect(await stateOf(a.i)).toMatchObject({ enabled: 1, left_at: null });
  });
  it("persists an uncertain outcome and resolves it without retrying leaveChat when already out", async () => {
    const a = await login();
    await materialize(env.DB, a.i.id, channelPost(1));
    mock("getChatMember", { status: "administrator" });
    mock("leaveChat", null, 503);
    const response = await call(
      post("/manage", (await prepare(a)).form, a.cookie),
    );
    expect(response.status).toBe(503);
    expect(await stateOf(a.i)).toMatchObject({ enabled: 0, leave_pending: 1 });
    await materialize(env.DB, a.i.id, channelPost(2));
    expect(await stateOf(a.i)).toMatchObject({ enabled: 0, leave_pending: 1 });
    const listing = await (
      await call(request("/manage", { headers: { Cookie: a.cookie } }))
    ).text();
    expect(listing).toContain("确认状态并重试退出");
    vi.mocked(fetch).mockClear();
    mock("getChatMember", { status: "left" });
    const reconciled = await call(
      post("/manage", (await prepare(a)).form, a.cookie),
    );
    expect(reconciled.headers.get("Location")).toContain("already_left");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await stateOf(a.i)).toMatchObject({ enabled: 0, leave_pending: 0 });
  });
  it("revokes a rejected bot token without attempting leaveChat", async () => {
    const a = await login();
    await materialize(env.DB, a.i.id, channelPost(1));
    const prepared = await prepare(a);
    vi.mocked(fetch).mockClear();
    mock("getChatMember", null, 401);
    const response = await call(post("/manage", prepared.form, a.cookie));
    expect(response.status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await getInstallation(env.DB, a.i.id)).toMatchObject({
      status: "invalid",
      epoch: a.i.epoch + 1,
    });
  });
});

describe("durable collector", () => {
  it("stores large encrypted batches in bounded chunks and strips reply/media metadata", async () => {
    const { i } = await fixture();
    const stub = env.COLLECTORS.getByName("large-batch");
    const payload = "大".repeat(200000);
    const encrypted = await seal(payload, `inbox:${i.id}`, env.BOT_KEYS, "v1");
    const restored = await runInDurableObject(
      stub,
      async (_instance, state) => {
        await writeInbox(state.storage, encrypted);
        const keys = await state.storage.list({ prefix: "inbox:" });
        expect(keys.size).toBeGreaterThan(1);
        return (await readInbox(state.storage))!;
      },
    );
    expect(await unseal(restored, `inbox:${i.id}`, env.BOT_KEYS)).toBe(payload);
    const update = msg(1, "kept");
    Object.assign(update.business_message!, {
      reply_to_message: { text: "unnecessary" },
      document: { file_id: "private-file" },
    });
    const minimal = JSON.stringify(minimalUpdate(update));
    expect(minimal).not.toContain("unnecessary");
    expect(minimal).toContain("private-file");
    const sealed = await seal(minimal, `inbox:${i.id}`, env.BOT_KEYS, "v1");
    expect(JSON.stringify(sealed)).not.toContain("private-file");
  });

  async function enrolled() {
    mock("getMe", me);
    mock("getWebhookInfo", { url: "" });
    const i = await appEnv().SYNC.enroll(token);
    await saveConnection(env.DB, i.id, connection);
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE connections SET selected=1 WHERE installation_id=?",
      ).bind(i.id),
      env.DB.prepare(
        "UPDATE installations SET status='active' WHERE id=?",
      ).bind(i.id),
    ]);
    return { i, stub: env.COLLECTORS.getByName(String(me.id)) };
  }
  it("refuses to take over an existing webhook", async () => {
    mock("getMe", me);
    mock("getWebhookInfo", { url: "https://example.com/webhook" });
    await expect(appEnv().SYNC.enroll(token)).rejects.toThrow("webhook");
    expect(
      (await env.DB.prepare("SELECT * FROM installations").all()).results,
    ).toHaveLength(0);
  });
  it("replays a durable inbox, deduplicates messages and commits cursor only after materialization", async () => {
    const { i, stub } = await enrolled();
    const inbox = { updates: [msg(10, "recover me")], nextOffset: 11 };
    await materialize(env.DB, i.id, inbox.updates[0]); // simulate crash after D1 commit but before cursor commit
    await runInDurableObject(stub, async (_instance, state) => {
      await writeInbox(
        state.storage,
        await seal(JSON.stringify(inbox), `inbox:${i.id}`, env.BOT_KEYS, "v1"),
      );
    });
    mock("getWebhookInfo", { url: "" });
    mock("getBusinessConnection", connection);
    mock("getUpdates", []);
    await runDurableObjectAlarm(stub);
    const state = await runInDurableObject(stub, async (_instance, s) => ({
      state: await s.storage.get<{ offset: number }>("state"),
      inbox: await s.storage.get("inbox"),
    }));
    expect(state.state?.offset).toBe(11);
    expect(state.inbox).toBeUndefined();
    expect(
      (await env.DB.prepare("SELECT * FROM messages").all()).results,
    ).toHaveLength(1);
  });
  it("honors retry_after; watchdog does not accelerate retries; invalid token revokes access", async () => {
    const { i, stub } = await enrolled();
    mock("getWebhookInfo", { url: "" });
    mock("getBusinessConnection", connection);
    mock("getUpdates", null, 429);
    await runDurableObjectAlarm(stub);
    const alarm = await runInDurableObject(stub, async (_instance, s) =>
      s.storage.getAlarm(),
    );
    expect(alarm!).toBeGreaterThan(Date.now() + 110000);
    await stub.wake();
    expect(
      await runInDurableObject(stub, async (_instance, s) =>
        s.storage.getAlarm(),
      ),
    ).toBe(alarm);
    mock("getUpdates", null, 401);
    await runDurableObjectAlarm(stub);
    expect((await getInstallation(env.DB, i.id))?.status).toBe("invalid");
    expect((await getInstallation(env.DB, i.id))?.epoch).toBe(2);
    expect(
      await runInDurableObject(stub, async (_instance, s) =>
        s.storage.getAlarm(),
      ),
    ).toBeNull();
  });
  it("keeps the inbox and old cursor when D1 fails, then recovers without persisting disabled Business chat text", async () => {
    const { i, stub } = await enrolled();
    await saveConnection(env.DB, i.id, {
      ...connection,
      id: "disabled",
      is_enabled: false,
    });
    await env.DB.exec(
      "CREATE TRIGGER fail_messages BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
    );
    mock("getWebhookInfo", { url: "" });
    mock("getBusinessConnection", connection);
    mock("getUpdates", [
      msg(1, "recover later"),
      msg(2, "never persist", "disabled"),
    ]);
    await runDurableObjectAlarm(stub);
    const before = await runInDurableObject(stub, async (_instance, s) => ({
      state: await s.storage.get<{ offset: number }>("state"),
      inbox: await readInbox(s.storage),
    }));
    expect(before.state?.offset).toBe(0);
    expect(before.inbox).toBeTruthy();
    const saved = await unseal(before.inbox!, `inbox:${i.id}`, env.BOT_KEYS);
    expect(saved).toContain("recover later");
    expect(saved).not.toContain("never persist");
    await env.DB.exec("DROP TRIGGER fail_messages;");
    mock("getUpdates", []);
    await runDurableObjectAlarm(stub);
    const after = await runInDurableObject(stub, async (_instance, s) => ({
      state: await s.storage.get<{ offset: number }>("state"),
      inbox: await s.storage.get("inbox"),
    }));
    expect(after.state?.offset).toBe(3);
    expect(after.inbox).toBeUndefined();
    expect(
      (await env.DB.prepare("SELECT text FROM messages").all()).results,
    ).toEqual([{ text: "recover later" }]);
  });
  it("deletes credentials and all tenant data", async () => {
    const { i, stub } = await enrolled();
    await materialize(env.DB, i.id, msg(1, "secret"));
    await stub.control("delete");
    expect(await getInstallation(env.DB, i.id)).toBeNull();
    expect(
      (await env.DB.prepare("SELECT * FROM messages").all()).results,
    ).toEqual([]);
    expect(
      await runInDurableObject(stub, async (_instance, s) =>
        s.storage.get("state"),
      ),
    ).toBeUndefined();
  });
});

it("rejects upstream redirects without forwarding the bot credential", async () => {
  vi.mocked(fetch).mockImplementationOnce(async (input, init) => {
    const outgoing = new Request(input, init);
    expect(outgoing.redirect).toBe("manual");
    return Response.redirect("https://untrusted.example/redirect-target", 302);
  });
  await expect(telegram(token, "getMe")).rejects.toMatchObject({ code: 502 });
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
});

describe("OAuth → Telegram → MCP", () => {
  it("publishes discovery and rejects anonymous access", async () => {
    const response = await call(request("/mcp"));
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      "resource_metadata",
    );
    const meta = await call(request("/.well-known/oauth-authorization-server"));
    expect(meta.status).toBe(200);
    expect(await meta.json()).toMatchObject({
      code_challenge_methods_supported: ["S256"],
    });
  });
  it("rejects forged redirect URIs, missing PKCE and cross-site credential submission", async () => {
    const client = await registerClient("Test");
    const response = await call(
      request(
        `/authorize?response_type=code&client_id=${client.clientId}&redirect_uri=${encodeURIComponent("https://attacker.example/cb")}`,
      ),
    );
    expect(response.status).toBe(400);
    expect(response.headers.has("Location")).toBe(false);
    const missingPkce = await call(
      request(
        `/authorize?response_type=code&client_id=${client.clientId}&redirect_uri=${encodeURIComponent("http://localhost:9876/callback")}`,
      ),
    );
    expect(missingPkce.status).not.toBe(200);
    const forged = await call(
      request("/manage/login", {
        method: "POST",
        headers: {
          Origin: "https://attacker.example",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "bot_token=secret&csrf=evil",
      }),
    );
    expect(forged.status).not.toBe(200);
    expect(await forged.text()).not.toContain("secret");
  });
  it("preserves form Origin without leaking referrer paths, and still rejects null Origin", async () => {
    const page = await call(request("/manage"));
    expect(page.headers.get("Referrer-Policy")).toBe("strict-origin");
    const html = await page.text();
    const forged = post(
      "/manage/login",
      { csrf: hidden(html, "csrf"), bot_token: token },
      cookies(page),
    );
    forged.headers.set("Origin", "null");
    const rejected = await call(forged);
    expect(rejected.status).toBe(403);
    expect(await rejected.text()).toContain("invalid_origin");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    const metadata = await call(
      request("/.well-known/oauth-authorization-server"),
    );
    expect(metadata.headers.get("Referrer-Policy")).toBe("no-referrer");
  });
  it("shows redacted enrollment failures, renews consent for retries, and keeps browser binding", async () => {
    const logs = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = await registerClient("Retry test");
    const params = new URLSearchParams({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: "http://localhost:9876/callback",
      scope: "telegram:read offline_access",
      state: "retry-state",
      code_challenge: await hash("x".repeat(64)),
      code_challenge_method: "S256",
      resource: `${origin}/mcp`,
    });
    let response = await call(request(`/authorize?${params}`));
    let html = await response.text();
    let browserCookie = cookies(response);
    const scenarios = [
      {
        code: "bot_token_format",
        status: 400,
        submitted: "not-a-valid-secret",
        setup() {},
      },
      {
        code: "bot_token_invalid",
        status: 401,
        submitted: token,
        setup() {
          mock("getMe", {}, 401);
        },
      },
      {
        code: "webhook_conflict",
        status: 409,
        submitted: token,
        setup() {
          mock("getMe", me);
          mock("getWebhookInfo", {
            url: "https://private.example/secret-hook",
          });
        },
      },
      {
        code: "telegram_rate_limited",
        status: 429,
        submitted: token,
        setup() {
          mock("getMe", {}, 429);
        },
      },
      {
        code: "telegram_unavailable",
        status: 502,
        submitted: token,
        setup() {
          mock("getMe", {}, 503);
        },
      },
    ];
    for (const scenario of scenarios) {
      scenario.setup();
      const oldHandle = hidden(html, "handle");
      response = await call(
        post(
          "/authorize",
          {
            handle: oldHandle,
            decision: "approve",
            bot_token: scenario.submitted,
          },
          browserCookie,
        ),
      );
      expect(response.status).toBe(scenario.status);
      html = await response.text();
      expect(html).toContain(scenario.code);
      expect(html).toContain("重新验证并连接");
      expect(html).not.toContain(scenario.submitted);
      expect(html).not.toContain("secret-hook");
      expect(hidden(html, "handle")).not.toBe(oldHandle);
      expect(
        response.headers.getSetCookie().some((c) => c.includes("Max-Age=0")),
      ).toBe(true);
      browserCookie = cookies(response);
    }
    expect(
      (await env.DB.prepare("SELECT * FROM installations").all()).results,
    ).toHaveLength(0);
    // A stolen retry handle without its browser cookie must never reach Telegram.
    const fetchesBefore = vi.mocked(fetch).mock.calls.length;
    const stolen = await call(
      post("/authorize", {
        handle: hidden(html, "handle"),
        decision: "approve",
        bot_token: token,
      }),
    );
    expect(stolen.status).toBe(400);
    expect(await stolen.text()).toContain("oauth_request_invalid");
    expect(vi.mocked(fetch).mock.calls.length).toBe(fetchesBefore);
    mock("getMe", me);
    mock("getWebhookInfo", { url: "" });
    const retried = await call(
      post(
        "/authorize",
        {
          handle: hidden(html, "handle"),
          decision: "approve",
          bot_token: `  ${token}\n`,
        },
        browserCookie,
      ),
    );
    expect(retried.status).toBe(303);
    expect(
      new URL(retried.headers.get("Location")!).searchParams.has("code"),
    ).toBe(true);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(token);
    expect(JSON.stringify(logs.mock.calls)).not.toContain("secret-hook");
    logs.mockRestore();
  });
  it("keeps management login retryable and sanitizes unexpected storage errors", async () => {
    const first = await call(request("/manage"));
    const body = await first.text();
    const denied = await call(
      post(
        "/manage/login",
        { csrf: hidden(body, "csrf"), bot_token: "invalid-secret-value" },
        cookies(first),
      ),
    );
    expect(denied.status).toBe(400);
    const html = await denied.text();
    expect(html).toContain("bot_token_format");
    expect(html).not.toContain("invalid-secret-value");
    expect(hidden(html, "csrf")).not.toBe(hidden(body, "csrf"));
    const service = new SyncService(createExecutionContext(), env);
    vi.spyOn(service, "enroll").mockRejectedValueOnce(
      new Error(`storage error ${token}`),
    );
    expect(await service.enrollForAuth(token)).toEqual({
      ok: false,
      code: "enrollment_unavailable",
    });
  });
  it("completes browser consent + PKCE, exposes six read tools with time filters, and rejects token reuse after revocation", async () => {
    const client = await registerClient("<script>alert(1)</script>");
    const verifier = "x".repeat(64),
      challenge = await hash(verifier);
    const params = new URLSearchParams({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: "http://localhost:9876/callback",
      scope: "telegram:read offline_access",
      state: "client-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${origin}/mcp`,
    });
    const first = await call(request(`/authorize?${params}`));
    expect(first.status).toBe(200);
    const html = await first.text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&#60;script&#62;");
    mock("getMe", { ...me, can_connect_to_business: false });
    mock("getWebhookInfo", { url: "" });
    const connected = await call(
      post(
        "/authorize",
        {
          handle: hidden(html, "handle"),
          decision: "approve",
          bot_token: token,
        },
        cookies(first),
      ),
    );
    expect(connected.status).toBe(303);
    expect(connected.headers.get("Location")).toContain(
      "http://localhost:9876/callback?",
    );
    const browserCookie = cookies(connected);
    const i = (await env.DB.prepare(
      "SELECT * FROM installations",
    ).first<Installation>())!;
    await saveConnection(env.DB, i.id, connection);
    const callback = new URL(connected.headers.get("Location")!);
    expect(i.status).toBe("active");
    expect(first.headers.get("Content-Security-Policy")).toContain(
      "form-action 'self' http://localhost:9876",
    );
    expect(callback.searchParams.get("state")).toBe("client-state");
    const wrongAudience = await call(
      post("/oauth/token", {
        grant_type: "authorization_code",
        code: callback.searchParams.get("code")!,
        client_id: client.clientId,
        redirect_uri: "http://localhost:9876/callback",
        code_verifier: verifier,
        resource: "https://other.example.com/mcp",
      }),
    );
    expect(wrongAudience.status).toBe(400);
    const exchange = await call(
      post("/oauth/token", {
        grant_type: "authorization_code",
        code: callback.searchParams.get("code")!,
        client_id: client.clientId,
        redirect_uri: "http://localhost:9876/callback",
        code_verifier: verifier,
        resource: `${origin}/mcp`,
      }),
    );
    expect(exchange.status).toBe(200);
    const tokens = await exchange.json<{
      access_token: string;
      refresh_token: string;
    }>();
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    const rpc = (method: string, params: Record<string, unknown> = {}) =>
      call(
        request("/mcp", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tokens.access_token}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2026-07-28",
            "Mcp-Method": method,
            ...(typeof params.name === "string"
              ? { "Mcp-Name": params.name }
              : {}),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            params: {
              ...params,
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }),
        }),
      );
    const tools = await rpc("tools/list");
    const raw = await tools.text();
    expect(tools.status, raw).toBe(200);
    for (const name of [
      "list_chats",
      "get_messages",
      "search_messages",
      "get_sync_status",
      "get_image",
      "get_file",
    ])
      expect(raw).toContain(name);
    expect(raw).not.toContain("send_message");
    expect(raw).not.toContain("leave_channel");
    const callsBeforeLeave = vi.mocked(fetch).mock.calls.length;
    const forbiddenLeave = await rpc("tools/call", {
      name: "leave_channel",
      arguments: { chat_id: "-100700" },
    });
    expect(await forbiddenLeave.text()).toContain("not found");
    expect(vi.mocked(fetch).mock.calls).toHaveLength(callsBeforeLeave);
    expect(raw.match(/"start_time":/g)).toHaveLength(2);
    expect(raw.match(/"end_time":/g)).toHaveLength(2);
    const rangeStart = now() - 7200;
    const original = msg(1, "Visible to this grant");
    original.business_message!.date = rangeStart;
    await materialize(env.DB, i.id, original);
    const messages = await rpc("tools/call", {
      name: "get_messages",
      arguments: { source_key: "business:conn-a", chat_id: "77" },
    });
    expect(await messages.text()).toContain("Visible to this grant");
    const excluded = msg(4, "Visible outside the range");
    excluded.business_message!.date = rangeStart + 1;
    await materialize(env.DB, i.id, excluded);
    for (const name of ["get_messages", "search_messages"]) {
      const arguments_ = {
        source_key: "business:conn-a",
        chat_id: "77",
        ...(name === "search_messages" ? { query: "Visible" } : {}),
        start_time: new Date(rangeStart * 1000)
          .toISOString()
          .replace(".000Z", "Z"),
        end_time: rangeStart + 1,
      };
      const filtered = await rpc("tools/call", { name, arguments: arguments_ });
      const content = await filtered.text();
      expect(filtered.status).toBe(200);
      expect(content).toContain("Visible to this grant");
      expect(content).not.toContain("Visible outside the range");
      const invalid = await rpc("tools/call", {
        name,
        arguments: { ...arguments_, end_time: rangeStart },
      });
      const error = await invalid.text();
      expect(error).toContain('"isError":true');
      expect(error).toContain("start_time must be earlier than end_time");
    }
    const imageUpdate = msg(2, "image via OAuth");
    imageUpdate.business_message!.photo = [
      { file_id: "oauth-photo", width: 1, height: 1 },
    ];
    await materialize(env.DB, i.id, imageUpdate);
    await stageImage(env, i.id, imageUpdate);
    mock("getFile", { file_path: "photos/oauth.png" });
    downloads.set("oauth.png", () => new Response(png));
    await processImages(env, i.id, token);
    const imageId = (await env.DB.prepare(
      "SELECT id FROM images WHERE installation_id=?",
    )
      .bind(i.id)
      .first<{ id: string }>())!.id;
    const imageResponse = await rpc("tools/call", {
      name: "get_image",
      arguments: { image_id: imageId },
    });
    const imageContent = await imageResponse.text();
    expect(imageResponse.status).toBe(200);
    expect(imageContent).toContain('"type":"image"');
    expect(imageContent).toContain(Buffer.from(png).toString("base64"));
    expect(imageContent).not.toContain("oauth-photo");
    expect(imageContent).not.toContain(token);
    const fileUpdate = documentUpdate(
      3,
      "oauth-file",
      "report.pdf",
      "application/pdf",
    );
    await materialize(env.DB, i.id, fileUpdate);
    await stageDocument(env, i.id, minimalUpdate(fileUpdate));
    mock("getFile", { file_path: "documents/oauth.pdf" });
    downloads.set("oauth.pdf", () => new Response(pdf));
    await processDocuments(env, i.id, token);
    const fileId = (await env.DB.prepare(
      "SELECT id FROM documents WHERE installation_id=?",
    )
      .bind(i.id)
      .first<{ id: string }>())!.id;
    const fileResponse = await rpc("tools/call", {
      name: "get_file",
      arguments: { file_id: fileId },
    });
    const fileContent = await fileResponse.text();
    expect(fileResponse.status).toBe(200);
    expect(fileContent).toContain('"type":"resource"');
    expect(fileContent).toContain("report.pdf");
    expect(fileContent).toContain(Buffer.from(pdf).toString("base64"));
    expect(fileContent).not.toContain("oauth-file");
    expect(fileContent).not.toContain(token);
    const unavailable = await rpc("tools/call", {
      name: "get_file",
      arguments: { file_id: "a".repeat(43) },
    });
    expect(await unavailable.text()).toContain("file_unavailable");
    expect(
      (
        await call(
          request("/mcp", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "get_image", arguments: { image_id: imageId } },
            }),
          }),
        )
      ).status,
    ).toBe(401);
    const legacy = await call(
      request("/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        }),
      }),
    );
    expect(legacy.status, await legacy.text()).toBe(200);
    const refreshed = await call(
      post("/oauth/token", {
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: client.clientId,
        resource: `${origin}/mcp`,
      }),
    );
    expect(refreshed.status).toBe(200);
    const rotated = await refreshed.json<{
      access_token: string;
      refresh_token: string;
    }>();
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    const manage = await call(
      request("/manage", { headers: { Cookie: browserCookie } }),
    );
    const revoked = await call(
      post(
        "/manage",
        { csrf: hidden(await manage.text(), "csrf"), action: "revoke" },
        browserCookie,
      ),
    );
    expect(revoked.status).toBe(200);
    expect((await rpc("tools/list")).status).toBe(401);
    const deadRefresh = await call(
      post("/oauth/token", {
        grant_type: "refresh_token",
        refresh_token: rotated.refresh_token,
        client_id: client.clientId,
        resource: `${origin}/mcp`,
      }),
    );
    expect(deadRefresh.status).toBe(400);
  });
});

const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  ),
);
async function imageFixture() {
  const { i, scope } = await fixture();
  const update = msg(1, "image caption");
  update.business_message!.photo = [
    { file_id: "image-file", width: 1, height: 1 },
  ];
  await materialize(env.DB, i.id, update);
  await stageImage(env, i.id, update);
  mock("getFile", { file_path: "photos/fixture.png" });
  downloads.set("fixture.png", () => new Response(png));
  await processImages(env, i.id, token);
  const row = (await env.DB.prepare(
    "SELECT id,object_key FROM images WHERE installation_id=?",
  )
    .bind(i.id)
    .first<{ id: string; object_key: string }>())!;
  return { i, scope, update, ...row };
}
describe("private image archive", () => {
  it("marks oversized and permanently invalid images without dropping their messages", async () => {
    const { i, scope } = await fixture();
    const large = msg(1, "oversized caption");
    large.business_message!.document = {
      file_id: "large-image",
      mime_type: "image/png",
      file_size: 20_000_001,
    };
    await materialize(env.DB, i.id, large);
    await stageImage(env, i.id, minimalUpdate(large));
    const invalid = msg(2, "invalid image caption");
    invalid.business_message!.photo = [
      { file_id: "expired-file", width: 1, height: 1 },
    ];
    await materialize(env.DB, i.id, invalid);
    await stageImage(env, i.id, invalid);
    mock("getFile", null, 400);
    await processImages(env, i.id, token);
    const rows = await queryMessages(env.DB, scope, { limit: 30 });
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "oversized caption",
          image_status: "skipped",
          image_error: "image_too_large",
        }),
        expect.objectContaining({
          text: "invalid image caption",
          image_status: "failed",
          image_error: "telegram_400",
        }),
      ]),
    );
    expect(
      (await env.DB.prepare("SELECT file_sealed FROM images").all()).results,
    ).toEqual([{ file_sealed: null }, { file_sealed: null }]);
    expect((await env.IMAGES.list()).objects).toHaveLength(0);
  });
  it("honors image download rate limits across the whole collector", async () => {
    mock("getMe", me);
    mock("getWebhookInfo", { url: "" });
    const i = await appEnv().SYNC.enroll(token);
    const stub = env.COLLECTORS.getByName(String(me.id));
    const photo = (n: number): TelegramUpdate => ({
      update_id: n,
      message: {
        message_id: n,
        date: now(),
        chat: { id: 22, type: "private" },
        photo: [{ file_id: `image-${n}`, width: 1, height: 1 }],
      },
    });
    mock("getWebhookInfo", { url: "" });
    mock("getUpdates", [photo(1), photo(2)]);
    mock("getFile", null, 429);
    await runDurableObjectAlarm(stub);
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([url]) => String(url).endsWith("/getFile")),
    ).toHaveLength(1);
    expect((await getInstallation(env.DB, i.id))?.error_code).toBe(
      "telegram_429",
    );
    expect(
      await runInDurableObject(stub, async (_, state) =>
        state.storage.getAlarm(),
      ),
    ).toBeGreaterThan(Date.now() + 110_000);
    const scope: GrantProps = {
      installationId: i.id,
      epoch: i.epoch,
      access: "bot",
    };
    expect(await queryMessages(env.DB, scope, { limit: 30 })).toHaveLength(2);
  });
  it("cleans an upload if retention removed its job during download", async () => {
    const { i } = await fixture();
    const update = msg(1, "expiring image");
    update.business_message!.photo = [
      { file_id: "expiring-file", width: 1, height: 1 },
    ];
    await materialize(env.DB, i.id, update);
    await stageImage(env, i.id, update);
    mock("getFile", { file_path: "photos/race.png" });
    const normal = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/race.png")) {
        await env.DB.prepare("UPDATE images SET expires_at=0").run();
        await cleanupImages(env);
        return new Response(png);
      }
      return normal(input, init);
    });
    await processImages(env, i.id, token);
    expect((await env.IMAGES.list()).objects).toHaveLength(0);
    expect(
      (await env.DB.prepare("SELECT id FROM images").all()).results,
    ).toHaveLength(0);
  });

  it("retries images independently, preserves the largest photo and exposes no file credentials", async () => {
    mock("getMe", me);
    mock("getWebhookInfo", { url: "" });
    const i = await appEnv().SYNC.enroll(token);
    const scope: GrantProps = {
      installationId: i.id,
      access: "bot",
      epoch: i.epoch,
    };
    const stub = env.COLLECTORS.getByName(String(me.id));
    const update: TelegramUpdate = {
      update_id: 100,
      message: {
        message_id: 1,
        date: now(),
        chat: { id: -100, type: "supergroup" },
        caption: "saved while image retries",
        photo: [
          { file_id: "small", width: 10, height: 10, file_size: 20 },
          {
            file_id: "largest",
            width: 100,
            height: 100,
            file_size: png.length,
          },
        ],
      },
    };
    mock("getWebhookInfo", { url: "" });
    mock("getUpdates", [update]);
    mock("getFile", null, 503);
    await runDurableObjectAlarm(stub);
    const row = (await env.DB.prepare(
      "SELECT * FROM images WHERE installation_id=?",
    )
      .bind(i.id)
      .first<{
        id: string;
        status: string;
        file_sealed: string;
        object_key: string;
      }>())!;
    expect(row.status).toBe("pending");
    expect(row.file_sealed).not.toContain("largest");
    expect(
      (await queryMessages(env.DB, scope, { limit: 30 }))[0],
    ).toMatchObject({
      text: "saved while image retries",
      image_status: "pending",
      image_id: row.id,
    });
    expect((await getInstallation(env.DB, i.id))?.error_code).toBeNull();
    expect(
      await runInDurableObject(
        stub,
        async (_, state) =>
          (await state.storage.get<{ offset: number }>("state"))!.offset,
      ),
    ).toBe(101);
    await env.DB.prepare("UPDATE images SET retry_at=0").run();
    mock("getUpdates", []);
    mock("getFile", { file_path: "photos/largest.png" });
    downloads.set("largest.png", () => new Response(png));
    await runDurableObjectAlarm(stub);
    const requests = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url).endsWith("/getFile"));
    expect(requests).toHaveLength(2);
    expect(JSON.parse(String(requests[1][1]?.body))).toEqual({
      file_id: "largest",
    });
    expect(await readImage(env, scope, row.id)).toEqual({
      type: "image",
      mimeType: "image/png",
      data: Buffer.from(png).toString("base64"),
    });
    expect(
      await env.DB.prepare("SELECT file_sealed,status FROM images WHERE id=?")
        .bind(row.id)
        .first(),
    ).toEqual({ file_sealed: null, status: "ready" });
    const exposed = JSON.stringify(
      await queryMessages(env.DB, scope, { limit: 30 }),
    );
    expect(exposed).not.toContain("largest");
    expect(exposed).not.toContain("object_key");
    expect(exposed).not.toContain(token);
    // Replaying the acknowledged update neither downloads again nor inserts a second object.
    mock("getUpdates", [update]);
    await runDurableObjectAlarm(stub);
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([url]) => String(url).endsWith("/getFile")),
    ).toHaveLength(2);
    expect((await env.IMAGES.list()).objects).toHaveLength(1);
  });
  it("isolates images by tenant, connection, group membership and grant epoch", async () => {
    const { i, scope, id } = await imageFixture();
    const other = await fixture();
    expect(await readImage(env, other.scope, id)).toBeNull();
    await saveConnection(env.DB, i.id, { ...connection, is_enabled: false });
    expect(await readImage(env, scope, id)).toBeNull();
    await saveConnection(env.DB, i.id, connection);
    await env.DB.prepare("UPDATE chats SET enabled=0 WHERE installation_id=?")
      .bind(i.id)
      .run();
    expect(await readImage(env, scope, id)).toBeNull();
    await env.DB.prepare("UPDATE chats SET enabled=1 WHERE installation_id=?")
      .bind(i.id)
      .run();
    expect(await readImage(env, scope, id)).not.toBeNull();
    await env.DB.prepare("UPDATE installations SET epoch=epoch+1 WHERE id=?")
      .bind(i.id)
      .run();
    await expect(readImage(env, scope, id)).rejects.toThrow("access_revoked");
  });
  it("removes replaced and Business-deleted images and enforces expiry before cleanup", async () => {
    const { i, scope, update, id, object_key } = await imageFixture();
    const edited: TelegramUpdate = {
      update_id: 2,
      edited_business_message: {
        ...update.business_message!,
        photo: undefined,
        document: {
          file_id: "document-png",
          mime_type: "image/png",
          file_size: png.length,
        },
      },
    };
    await materialize(env.DB, i.id, edited);
    await stageImage(env, i.id, minimalUpdate(edited));
    expect(await readImage(env, scope, id)).toBeNull();
    mock("getFile", { file_path: "documents/replacement.png" });
    downloads.set("replacement.png", () => new Response(png));
    await processImages(env, i.id, token);
    await cleanupImages(env);
    expect(await env.IMAGES.head(object_key)).toBeNull();
    const replacement = (await env.DB.prepare(
      "SELECT id,object_key FROM images WHERE installation_id=?",
    )
      .bind(i.id)
      .first<{ id: string; object_key: string }>())!;
    expect(await readImage(env, scope, replacement.id)).not.toBeNull();
    await materialize(env.DB, i.id, {
      update_id: 3,
      deleted_business_messages: {
        business_connection_id: connection.id,
        chat: { id: 77 },
        message_ids: [1],
      },
    });
    expect(await readImage(env, scope, replacement.id)).toBeNull();
    await cleanupImages(env);
    expect((await env.IMAGES.list()).objects).toHaveLength(0);
    const expired = await imageFixture();
    await env.DB.prepare("UPDATE images SET expires_at=? WHERE id=?")
      .bind(now() - 1, expired.id)
      .run();
    expect(await readImage(env, expired.scope, expired.id)).toBeNull();
    await cleanupImages(env);
    expect(await env.IMAGES.head(expired.object_key)).toBeNull();
  });
  it("deletes all installation objects including interrupted uploads", async () => {
    mock("getMe", me);
    mock("getWebhookInfo", { url: "" });
    const i = await appEnv().SYNC.enroll(token);
    await env.IMAGES.put(`images/${i.id}/interrupted`, png);
    await env.IMAGES.put(`documents/${i.id}/interrupted`, pdf);
    await env.IMAGES.put("documents/another-installation/keep", pdf);
    await env.IMAGES.put("images/another-installation/keep", png);
    await appEnv().SYNC.control(i.bot_id, "delete");
    expect(
      (await env.IMAGES.list({ prefix: `images/${i.id}/` })).objects,
    ).toHaveLength(0);
    expect(
      await env.IMAGES.head("images/another-installation/keep"),
    ).not.toBeNull();
    expect(await getInstallation(env.DB, i.id)).toBeNull();
    expect(
      (await env.IMAGES.list({ prefix: `documents/${i.id}/` })).objects,
    ).toHaveLength(0);
    expect(
      await env.IMAGES.head("documents/another-installation/keep"),
    ).not.toBeNull();
  });
  it("bounds file downloads, rejects credential redirects and rejects non-image bytes", async () => {
    mock("getFile", { file_path: "photos/large.jpg", file_size: 20_000_001 });
    await expect(downloadImage(token, "oversized")).rejects.toThrow(
      "image_too_large",
    );
    mock("getFile", { file_path: "../other" });
    await expect(downloadImage(token, "traversal")).rejects.toThrow(
      "invalid_file_path",
    );
    mock("getFile", { file_path: "photos/redirect.jpg" });
    downloads.set(
      "redirect.jpg",
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://example.com/steal" },
        }),
    );
    await expect(downloadImage(token, "redirect")).rejects.toThrow(
      "file_redirect_rejected",
    );
    expect(
      vi
        .mocked(fetch)
        .mock.calls.find(([url]) => String(url).endsWith("/redirect.jpg"))?.[1]
        ?.redirect,
    ).toBe("manual");
    mock("getFile", { file_path: "documents/fake.png" });
    downloads.set(
      "fake.png",
      () =>
        new Response("<svg onload='alert(1)'/>", {
          headers: { "Content-Type": "image/png" },
        }),
    );
    await expect(downloadImage(token, "fake")).rejects.toThrow(
      "unsupported_image",
    );
    mock("getFile", { file_path: "photos/stream.jpg" });
    downloads.set(
      "stream.jpg",
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(10_000_001));
              controller.enqueue(new Uint8Array(10_000_001));
              controller.close();
            },
          }),
        ),
    );
    await expect(downloadImage(token, "stream")).rejects.toThrow(
      "image_too_large",
    );
  });
});

const pdf = new TextEncoder().encode(
  "%PDF-1.7\noriginal document bytes\n%%EOF\n",
);
function documentUpdate(
  n: number,
  fileId = `doc-${n}`,
  filename = "报告.pdf",
  mime = "application/pdf",
): TelegramUpdate {
  return {
    update_id: n,
    message: {
      message_id: n,
      date: now(),
      chat: { id: -100, type: "supergroup" },
      caption: "attachment caption",
      document: { file_id: fileId, file_name: filename, mime_type: mime },
    },
  };
}
async function documentFixture() {
  const { i, scope } = await fixture();
  const update = documentUpdate(1);
  await materialize(env.DB, i.id, update);
  await stageDocument(env, i.id, minimalUpdate(update));
  mock("getFile", {
    file_path: "documents/fixture.pdf",
    file_size: pdf.length,
  });
  downloads.set("fixture.pdf", () => new Response(pdf));
  await processDocuments(env, i.id, token);
  const row = (await env.DB.prepare(
    "SELECT id,object_key FROM documents WHERE installation_id=?",
  )
    .bind(i.id)
    .first<{ id: string; object_key: string }>())!;
  return { i, scope, update, ...row };
}

describe("private document archive", () => {
  it.each([
    ["报告 100%_合同.pdf", "application/pdf", pdf],
    [
      "合同.doc",
      "application/msword",
      new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 255]),
    ],
    [
      "报告.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      new Uint8Array([80, 75, 3, 4, 0, 255, 1]),
    ],
    [
      "报表.xls",
      "application/vnd.ms-excel",
      new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 255, 2]),
    ],
    [
      "报表.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      new Uint8Array([80, 75, 3, 4, 0, 255, 3]),
    ],
    ["备份.zip", "application/zip", new Uint8Array([80, 75, 5, 6, 0, 255, 4])],
  ])(
    "preserves original filename, metadata and exact bytes for %s",
    async (filename, mime, bytes) => {
      const { i, scope } = await fixture();
      const update = documentUpdate(1, "private-document-id", filename, mime);
      await materialize(env.DB, i.id, update);
      await stageDocument(env, i.id, minimalUpdate(update));
      const row = (await env.DB.prepare(
        "SELECT id,object_key,file_sealed FROM documents WHERE installation_id=?",
      )
        .bind(i.id)
        .first<{ id: string; object_key: string; file_sealed: string }>())!;
      expect(row.file_sealed).not.toContain("private-document-id");
      expect(
        await unseal(
          JSON.parse(row.file_sealed),
          `document:${i.id}:${row.id}`,
          env.BOT_KEYS,
        ),
      ).toBe("private-document-id");
      expect(await readDocument(env, scope, row.id)).toBeNull();
      // getFile need not return the name or MIME supplied in the original message.
      mock("getFile", {
        file_path: "documents/file.bin",
        file_size: bytes.length,
      });
      downloads.set("file.bin", () => new Response(bytes));
      await processDocuments(env, i.id, token);
      const stored = await env.IMAGES.get(row.object_key);
      expect(stored?.httpMetadata?.contentType).toBe(
        "application/octet-stream",
      );
      expect(stored?.httpMetadata?.contentDisposition).toBe("attachment");
      expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(bytes);
      const file = await readDocument(env, scope, row.id);
      expect(file).toMatchObject({
        file_name: filename,
        mime_type: mime,
        byte_size: bytes.length,
      });
      expect(Buffer.from(file!.content.resource.blob, "base64")).toEqual(
        Buffer.from(bytes),
      );
      const messages = await queryMessages(env.DB, scope, {
        query: filename,
        limit: 30,
      });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        text: "attachment caption",
        media_type: "document",
        file_name: filename,
        file_id: row.id,
        file_status: "ready",
        file_bytes: bytes.length,
      });
      expect(JSON.stringify(messages)).not.toContain("private-document-id");
      expect(JSON.stringify(file)).not.toContain(row.object_key);
      expect(
        await env.DB.prepare("SELECT file_sealed FROM documents WHERE id=?")
          .bind(row.id)
          .first(),
      ).toEqual({ file_sealed: null });
      await stageDocument(env, i.id, minimalUpdate(update));
      await processDocuments(env, i.id, token);
      expect((await env.IMAGES.list()).objects).toHaveLength(1);
      expect(
        await queryMessages(env.DB, scope, {
          query: "does-not-match",
          limit: 30,
        }),
      ).toEqual([]);
    },
  );

  it("saves messages before retrying file downloads and replays without duplicating objects", async () => {
    mock("getMe", me);
    mock("getWebhookInfo", { url: "" });
    const i = await appEnv().SYNC.enroll(token);
    const scope: GrantProps = {
      installationId: i.id,
      access: "bot",
      epoch: i.epoch,
    };
    const stub = env.COLLECTORS.getByName(String(me.id));
    const update = documentUpdate(
      100,
      "retry-document",
      "retry.zip",
      "application/zip",
    );
    mock("getWebhookInfo", { url: "" });
    mock("getUpdates", [update]);
    mock("getFile", null, 503);
    await runDurableObjectAlarm(stub);
    expect(
      (await queryMessages(env.DB, scope, { limit: 30 }))[0],
    ).toMatchObject({
      file_status: "pending",
      file_name: "retry.zip",
      text: "attachment caption",
    });
    expect(
      await runInDurableObject(
        stub,
        async (_, state) =>
          (await state.storage.get<{ offset: number }>("state"))!.offset,
      ),
    ).toBe(101);
    await env.DB.prepare("UPDATE documents SET retry_at=0").run();
    mock("getUpdates", []);
    mock("getFile", { file_path: "documents/retry.zip" });
    downloads.set("retry.zip", () => new Response(pdf));
    await runDurableObjectAlarm(stub);
    expect(
      (await queryMessages(env.DB, scope, { limit: 30 }))[0],
    ).toMatchObject({ file_status: "ready" });
    mock("getUpdates", [update]);
    await runDurableObjectAlarm(stub);
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([u]) => String(u).endsWith("/getFile")),
    ).toHaveLength(2);
    expect((await env.IMAGES.list()).objects).toHaveLength(1);
  });

  it.each([401, 429])(
    "propagates Telegram %s from document jobs to the collector",
    async (code) => {
      mock("getMe", me);
      mock("getWebhookInfo", { url: "" });
      const i = await appEnv().SYNC.enroll(token);
      const stub = env.COLLECTORS.getByName(String(me.id));
      mock("getWebhookInfo", { url: "" });
      mock("getUpdates", [documentUpdate(1), documentUpdate(2)]);
      mock("getFile", null, code);
      await runDurableObjectAlarm(stub);
      expect(
        vi
          .mocked(fetch)
          .mock.calls.filter(([u]) => String(u).endsWith("/getFile")),
      ).toHaveLength(1);
      expect((await getInstallation(env.DB, i.id))?.error_code).toBe(
        `telegram_${code}`,
      );
      const alarm = await runInDurableObject(stub, async (_, state) =>
        state.storage.getAlarm(),
      );
      if (code === 429) expect(alarm).toBeGreaterThan(Date.now() + 110_000);
      else {
        expect(alarm).toBeNull();
        expect((await getInstallation(env.DB, i.id))?.status).toBe("invalid");
      }
    },
  );

  it("keeps oversized file metadata, retries truncation, and rejects redirects and oversized streams", async () => {
    const { i, scope } = await fixture();
    const big = documentUpdate(1);
    Object.assign(big.message!.document!, {
      file_size: MAX_DOCUMENT_BYTES + 1,
    });
    await materialize(env.DB, i.id, big);
    await stageDocument(env, i.id, minimalUpdate(big));
    await processDocuments(env, i.id, token);
    expect(
      (await queryMessages(env.DB, scope, { limit: 30 }))[0],
    ).toMatchObject({
      file_status: "skipped",
      file_error: "file_too_large",
      file_name: "报告.pdf",
    });
    expect(fetch).not.toHaveBeenCalled();
    const truncated = documentUpdate(2);
    await materialize(env.DB, i.id, truncated);
    await stageDocument(env, i.id, truncated);
    mock("getFile", {
      file_path: "documents/short.pdf",
      file_size: pdf.length + 1,
    });
    downloads.set("short.pdf", () => new Response(pdf));
    await processDocuments(env, i.id, token);
    expect(
      (await queryMessages(env.DB, scope, { limit: 30 }))[0],
    ).toMatchObject({ file_status: "pending", file_error: "telegram_502" });
    mock("getFile", { file_path: "documents/redirect.pdf" });
    downloads.set(
      "redirect.pdf",
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://example.com" },
        }),
    );
    await expect(
      downloadFileBytes(token, "redirect", MAX_DOCUMENT_BYTES, "file"),
    ).rejects.toThrow("file_redirect_rejected");
    mock("getFile", { file_path: "../invalid" });
    await expect(
      downloadFileBytes(token, "invalid", MAX_DOCUMENT_BYTES, "file"),
    ).rejects.toThrow("invalid_file_path");
    mock("getFile", { file_path: "documents/big.zip" });
    downloads.set(
      "big.zip",
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(10_000_001));
              c.enqueue(new Uint8Array(10_000_001));
              c.close();
            },
          }),
        ),
    );
    await expect(
      downloadFileBytes(token, "stream", MAX_DOCUMENT_BYTES, "file"),
    ).rejects.toThrow("file_too_large");
    expect((await env.IMAGES.list()).objects).toHaveLength(0);
  });

  it("isolates attachments across bots, membership and epochs, including revocation during R2 reads", async () => {
    const { i, scope, id } = await documentFixture();
    const other = await fixture();
    expect(await readDocument(env, other.scope, id)).toBeNull();
    await materialize(env.DB, i.id, {
      update_id: 2,
      my_chat_member: {
        chat: { id: -100, type: "supergroup" },
        new_chat_member: { status: "left" },
      },
    });
    expect(await readDocument(env, scope, id)).toBeNull();
    expect(
      await queryMessages(env.DB, scope, { query: "报告", limit: 30 }),
    ).toEqual([]);
    await materialize(env.DB, i.id, {
      update_id: 3,
      my_chat_member: {
        chat: { id: -100, type: "supergroup" },
        new_chat_member: { status: "member" },
      },
    });
    const get = env.IMAGES.get.bind(env.IMAGES);
    const revokeDuringRead = {
      ...env,
      IMAGES: new Proxy(env.IMAGES, {
        get(target, key) {
          if (key === "get")
            return async (...args: Parameters<R2Bucket["get"]>) => {
              await env.DB.prepare(
                "UPDATE installations SET epoch=epoch+1 WHERE id=?",
              )
                .bind(i.id)
                .run();
              return get(...args);
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    };
    await expect(readDocument(revokeDuringRead, scope, id)).rejects.toThrow(
      "access_revoked",
    );
    await expect(readDocument(env, scope, id)).rejects.toThrow(
      "access_revoked",
    );
  });

  it("removes replaced/deleted Business documents and expires both metadata and bytes", async () => {
    const { i, scope } = await fixture();
    const update = msg(1, "Business file");
    update.business_message!.document = {
      file_id: "business-file",
      file_name: "contract.pdf",
      mime_type: "application/pdf",
    };
    await materialize(env.DB, i.id, update);
    await stageDocument(env, i.id, update);
    mock("getFile", { file_path: "documents/business.pdf" });
    downloads.set("business.pdf", () => new Response(pdf));
    await processDocuments(env, i.id, token);
    const row = (await env.DB.prepare(
      "SELECT id,object_key FROM documents WHERE installation_id=?",
    )
      .bind(i.id)
      .first<{ id: string; object_key: string }>())!;
    await saveConnection(env.DB, i.id, { ...connection, is_enabled: false });
    expect(await readDocument(env, scope, row.id)).toBeNull();
    await saveConnection(env.DB, i.id, connection);
    const edited: TelegramUpdate = {
      update_id: 2,
      edited_business_message: {
        ...update.business_message!,
        document: { file_id: "new-file", file_name: "new.pdf" },
      },
    };
    await materialize(env.DB, i.id, edited);
    await stageDocument(env, i.id, edited);
    expect(await readDocument(env, scope, row.id)).toBeNull();
    await cleanupDocuments(env);
    expect(await env.IMAGES.head(row.object_key)).toBeNull();
    mock("getFile", { file_path: "documents/new.pdf" });
    downloads.set("new.pdf", () => new Response(pdf));
    await processDocuments(env, i.id, token);
    const current = (await env.DB.prepare(
      "SELECT id FROM documents WHERE installation_id=?",
    )
      .bind(i.id)
      .first<{ id: string }>())!;
    await materialize(env.DB, i.id, {
      update_id: 3,
      deleted_business_messages: {
        business_connection_id: connection.id,
        chat: { id: 77 },
        message_ids: [1],
      },
    });
    expect(await readDocument(env, scope, current.id)).toBeNull();
    await cleanupDocuments(env);
    expect((await env.IMAGES.list()).objects).toHaveLength(0);
    const expired = await documentFixture();
    await env.DB.prepare("UPDATE documents SET expires_at=0 WHERE id=?")
      .bind(expired.id)
      .run();
    expect(await readDocument(env, expired.scope, expired.id)).toBeNull();
    await cleanupDocuments(env);
    expect(await env.IMAGES.head(expired.object_key)).toBeNull();
  });

  it("removes objects uploaded while cleanup removes their pending jobs", async () => {
    const { i } = await fixture();
    const update = documentUpdate(1);
    await materialize(env.DB, i.id, update);
    await stageDocument(env, i.id, update);
    mock("getFile", { file_path: "documents/race.pdf" });
    const normal = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/race.pdf")) {
        await env.DB.prepare("UPDATE documents SET expires_at=0").run();
        await cleanupDocuments(env);
        return new Response(pdf);
      }
      return normal(input, init);
    });
    await processDocuments(env, i.id, token);
    expect(
      (await env.DB.prepare("SELECT id FROM documents").all()).results,
    ).toHaveLength(0);
    expect((await env.IMAGES.list()).objects).toHaveLength(0);
  });
});

describe("unified 90-day retention", () => {
  it("retains older text, images and documents until exactly 90 days from the original message", async () => {
    const { i, scope } = await fixture();
    const sentAt = now() - 45 * 86400;
    const text = msg(1, "text older than thirty days");
    text.business_message!.date = sentAt;
    const photo = msg(2, "photo older than thirty days");
    photo.business_message!.date = sentAt;
    photo.business_message!.photo = [
      { file_id: "old-photo", width: 1, height: 1 },
    ];
    const document = documentUpdate(3, "old-document", "old-report.pdf");
    document.message!.date = sentAt;
    for (const update of [text, photo, document]) {
      await materialize(env.DB, i.id, update);
      await stageImage(env, i.id, update);
      await stageDocument(env, i.id, update);
    }
    mock("getFile", { file_path: "photos/old.png" });
    downloads.set("old.png", () => new Response(png));
    await processImages(env, i.id, token);
    mock("getFile", { file_path: "documents/old.pdf" });
    downloads.set("old.pdf", () => new Response(pdf));
    await processDocuments(env, i.id, token);
    const image = (await env.DB.prepare(
      "SELECT id,expires_at FROM images WHERE installation_id=?",
    )
      .bind(i.id)
      .first<{ id: string; expires_at: number }>())!;
    const file = (await env.DB.prepare(
      "SELECT id,expires_at FROM documents WHERE installation_id=?",
    )
      .bind(i.id)
      .first<{ id: string; expires_at: number }>())!;
    const expiresAt = sentAt + 90 * 86400;
    expect(image.expires_at).toBe(expiresAt);
    expect(file.expires_at).toBe(expiresAt);
    await retain(env.DB);
    await cleanupImages(env);
    await cleanupDocuments(env);
    const clock = vi.spyOn(Date, "now");
    try {
      clock.mockReturnValue((expiresAt - 1) * 1000);
      expect(await queryMessages(env.DB, scope, { limit: 30 })).toHaveLength(3);
      expect(
        await queryMessages(env.DB, scope, {
          query: "old-report.pdf",
          limit: 30,
        }),
      ).toHaveLength(1);
      expect(await readImage(env, scope, image.id)).not.toBeNull();
      expect(await readDocument(env, scope, file.id)).not.toBeNull();
      const chats = await queryChats(env.DB, scope, { limit: 30 });
      expect(chats.reduce((n, c) => n + Number(c.message_count), 0)).toBe(3);
      clock.mockReturnValue(expiresAt * 1000);
      expect(await queryMessages(env.DB, scope, { limit: 30 })).toEqual([]);
      expect(await readImage(env, scope, image.id)).toBeNull();
      expect(await readDocument(env, scope, file.id)).toBeNull();
      expect(
        (await queryChats(env.DB, scope, { limit: 30 })).every(
          (c) => c.message_count === 0,
        ),
      ).toBe(true);
      await retain(env.DB);
      await cleanupImages(env);
      await cleanupDocuments(env);
      expect(
        (
          await env.DB.prepare(
            "SELECT text,deleted FROM messages WHERE installation_id=?",
          )
            .bind(i.id)
            .all()
        ).results,
      ).toEqual(Array(3).fill({ text: null, deleted: 1 }));
      expect((await env.IMAGES.list()).objects).toHaveLength(0);
      expect(
        (
          await env.DB.prepare(
            "SELECT id FROM images UNION ALL SELECT id FROM documents",
          ).all()
        ).results,
      ).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  });

  it("extends existing valid media during upgrade without reviving expired, deleted or superseded records", async () => {
    await reset();
    const migrations = inject("migrations");
    await applyD1Migrations(env.DB, migrations.slice(0, 4));
    const { i } = await fixture();
    const sentAt = now() - 20 * 86400;
    // Seed the pre-upgrade schema directly; current saveChat requires the new columns.
    await env.DB.prepare(
      "INSERT INTO chats(installation_id,source_key,chat_id,chat_type,title) VALUES(?,'business:conn-a','77','private','Legacy chat')",
    )
      .bind(i.id)
      .run();
    for (let n = 1; n <= 8; n++) {
      const update = msg(n, `legacy message ${n}`);
      update.business_message!.date = sentAt;
      if (n % 2)
        update.business_message!.photo = [
          { file_id: `legacy-${n}`, width: 1, height: 1 },
        ];
      else
        update.business_message!.document = {
          file_id: `legacy-${n}`,
          file_name: `legacy-${n}.pdf`,
        };
      await env.DB.prepare(
        "INSERT INTO messages(installation_id,source_key,chat_id,message_id,sent_at,text,media_type,last_update) VALUES(?,'business:conn-a','77',?,?,?,?,?)",
      )
        .bind(
          i.id,
          n,
          sentAt,
          `legacy message ${n}`,
          n % 2 ? "photo" : "document",
          n,
        )
        .run();
      await stageImage(env, i.id, update);
      await stageDocument(env, i.id, update);
    }
    await env.DB.batch([
      env.DB.prepare("UPDATE images SET expires_at=?").bind(
        sentAt + 30 * 86400,
      ),
      env.DB.prepare("UPDATE documents SET expires_at=?").bind(
        sentAt + 30 * 86400,
      ),
      env.DB.prepare("UPDATE images SET expires_at=0 WHERE message_id=3"),
      env.DB.prepare("UPDATE documents SET expires_at=0 WHERE message_id=4"),
      env.DB.prepare(
        "UPDATE messages SET deleted=1,text=NULL WHERE message_id IN (5,6)",
      ),
      env.DB.prepare(
        "UPDATE messages SET last_update=last_update+100 WHERE message_id IN (7,8)",
      ),
    ]);
    await applyD1Migrations(env.DB, migrations);
    const { results } = await env.DB.prepare(
      "SELECT message_id,expires_at FROM images UNION ALL SELECT message_id,expires_at FROM documents ORDER BY message_id",
    ).all<{ message_id: number; expires_at: number }>();
    expect(results).toEqual(
      Array.from({ length: 8 }, (_, index) => ({
        message_id: index + 1,
        expires_at:
          index < 2 ? sentAt + 90 * 86400 : index < 4 ? 0 : sentAt + 30 * 86400,
      })),
    );
    expect(
      (
        await env.DB.prepare(
          "SELECT text,deleted FROM messages WHERE message_id IN (5,6)",
        ).all()
      ).results,
    ).toEqual([
      { text: null, deleted: 1 },
      { text: null, deleted: 1 },
    ]);
    await applyD1Migrations(env.DB, migrations);
    expect(
      (
        await env.DB.prepare(
          "SELECT expires_at FROM images WHERE message_id=1",
        ).first()
      )?.expires_at,
    ).toBe(sentAt + 90 * 86400);
  });
});
