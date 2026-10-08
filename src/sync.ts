import {
  stageImage,
  processImages,
  cleanupImages,
  deleteInstallationImages,
} from "./images";
import {
  stageDocument,
  processDocuments,
  cleanupDocuments,
  deleteInstallationDocuments,
} from "./documents";
import { AuthFlowError, type AuthFailureCode } from "./auth-errors";
import { getManagedChannel, type LeaveResult } from "./channel-management";
import { writeInbox, readInbox, clearInbox, minimalUpdate } from "./inbox";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { hash, seal, unseal, type Sealed } from "./crypto";
import {
  getInstallation,
  getConnection,
  materialize,
  now,
  retain,
  saveConnection,
} from "./store";
import {
  telegram,
  leaveTelegramChannel,
  TelegramError,
  validateTokenFormat,
} from "./telegram";
import type { Installation, SyncEnv, TelegramUpdate } from "./types";

interface CollectorState {
  installationId: string;
  botId: string;
  token: Sealed;
  fingerprint: string;
  offset: number;
  failures: number;
  lastCheck: number;
  managementRetryAt?: number;
}
interface Inbox {
  nextOffset: number;
  updates: TelegramUpdate[];
}
export class BotCollector extends DurableObject<SyncEnv> {
  private tail: Promise<unknown> = Promise.resolve();
  // Serialize alarms and management RPC across network awaits, without a long blockConcurrencyWhile.
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
  async enroll(
    token: string,
    botId: string,
    username: string,
  ): Promise<Installation> {
    return this.exclusive(async () => {
      const prior = await this.ctx.storage.get<CollectorState>("state");
      const fingerprint = await hash(token);
      const old = await this.env.DB.prepare(
        "SELECT * FROM installations WHERE bot_id=?",
      )
        .bind(botId)
        .first<Installation>();
      const id = old?.id ?? crypto.randomUUID();
      const rotated = Boolean(old && prior?.fingerprint !== fingerprint);
      const encrypted = await seal(
        token,
        `bot:${id}:${botId}`,
        this.env.BOT_KEYS,
        this.env.ACTIVE_KEY_ID,
      );
      await this.env.DB.prepare(
        `INSERT INTO installations(id,bot_id,username,created_at,status) VALUES(?,?,?,?,'active')
        ON CONFLICT(id) DO UPDATE SET username=excluded.username,epoch=epoch+?,status=CASE WHEN ? OR status IN ('invalid','pending') THEN 'active' ELSE status END,error_code=NULL`,
      )
        .bind(id, botId, username, now(), Number(rotated), Number(rotated))
        .run();
      const state: CollectorState = {
        installationId: id,
        botId,
        token: encrypted,
        fingerprint,
        offset: old && prior ? prior.offset : 0,
        failures: 0,
        lastCheck: 0,
      };
      await this.ctx.storage.put("state", state);
      const result = (await getInstallation(this.env.DB, id))!;
      if (result.status !== "paused")
        await this.ctx.storage.setAlarm(Date.now() + 1000);
      return result;
    });
  }
  async wake() {
    return this.exclusive(async () => {
      const state = await this.ctx.storage.get<CollectorState>("state");
      if (!state) return;
      const i = await getInstallation(this.env.DB, state.installationId);
      if (!i || !["active", "pending"].includes(i.status)) return;
      // A future alarm may represent Telegram retry_after. The watchdog must not shorten it.
      if (!(await this.ctx.storage.getAlarm()))
        await this.ctx.storage.setAlarm(Date.now() + 1000);
    });
  }
  async discover(connectionId: string) {
    return this.exclusive(async () => {
      const state = await this.ctx.storage.get<CollectorState>("state");
      if (!state) throw new Error("installation_unavailable");
      const token = await unseal(
        state.token,
        `bot:${state.installationId}:${state.botId}`,
        this.env.BOT_KEYS,
      );
      const c = await telegram(token, "getBusinessConnection", {
        business_connection_id: connectionId,
      });
      await saveConnection(this.env.DB, state.installationId, c);
      return c.id;
    });
  }
  async control(action: "revoke" | "disconnect" | "delete" | "resume") {
    return this.exclusive(async () => {
      const state = await this.ctx.storage.get<CollectorState>("state");
      if (!state) return;
      const id = state.installationId;
      if (action === "delete") {
        await this.ctx.storage.deleteAlarm();
        await this.env.DB.prepare(
          "UPDATE installations SET status='paused',epoch=epoch+1 WHERE id=?",
        )
          .bind(id)
          .run();
        await deleteInstallationImages(this.env, id);
        await deleteInstallationDocuments(this.env, id);
        await this.env.DB.prepare("DELETE FROM installations WHERE id=?")
          .bind(id)
          .run();
        await this.ctx.storage.deleteAll();
        return;
      }
      if (action === "disconnect") {
        await this.env.DB.prepare(
          "UPDATE installations SET epoch=epoch+1,status='paused' WHERE id=?",
        )
          .bind(id)
          .run();
        await this.ctx.storage.transaction((tx) => clearInbox(tx));
        await this.ctx.storage.deleteAlarm();
      } else if (action === "revoke") {
        await this.env.DB.prepare(
          "UPDATE installations SET epoch=epoch+1 WHERE id=?",
        )
          .bind(id)
          .run();
      } else {
        await this.env.DB.prepare(
          "UPDATE installations SET status='active',error_code=NULL WHERE id=?",
        )
          .bind(id)
          .run();
        await this.ctx.storage.setAlarm(Date.now() + 1000);
      }
    });
  }
  async leaveChannel(
    sessionHash: string,
    confirmationHash: string,
  ): Promise<LeaveResult> {
    return this.exclusive(async () => {
      const state = await this.ctx.storage.get<CollectorState>("state");
      if (!state) return "invalid_request";
      const i = await getInstallation(this.env.DB, state.installationId);
      if (!i || !["active", "paused"].includes(i.status))
        return "invalid_request";
      // Validate and atomically consume the browser's confirmation inside the serialized RPC.
      // Neither a bot ID nor a chat ID supplied by a caller is sufficient authorization.
      const confirmed = await this.env.DB.prepare(
        `UPDATE sessions SET leave_token_hash=NULL,leave_expires_at=NULL
         WHERE token_hash=? AND installation_id=? AND epoch=? AND expires_at>?
         AND leave_token_hash=? AND leave_expires_at>? RETURNING leave_chat_id`,
      )
        .bind(sessionHash, i.id, i.epoch, now(), confirmationHash, now())
        .first<{ leave_chat_id: string }>();
      if (!confirmed || !/^-\d{1,19}$/.test(confirmed.leave_chat_id))
        return "invalid_request";
      const chatId = confirmed.leave_chat_id;
      const channel = await getManagedChannel(this.env.DB, i.id, chatId);
      if (!channel || (!channel.enabled && !channel.leave_pending))
        return "invalid_request";
      if ((state.managementRetryAt ?? 0) > now()) return "rate_limited";
      const token = await unseal(
        state.token,
        `bot:${i.id}:${state.botId}`,
        this.env.BOT_KEYS,
      );
      let attempted = false;
      try {
        const member = await telegram(token, "getChatMember", {
          chat_id: chatId,
          user_id: Number(state.botId),
        });
        if (["left", "kicked"].includes(member.status)) {
          await this.env.DB.prepare(
            "UPDATE chats SET enabled=0,left_at=?,leave_pending=0 WHERE installation_id=? AND source_key='bot' AND chat_id=?",
          )
            .bind(now(), i.id, chatId)
            .run();
          return "already_left";
        }
        if (!["member", "administrator", "creator"].includes(member.status))
          return "rejected";
        // The block survives crashes or ambiguous network outcomes, and prevents inbox replay
        // from re-enabling a channel while leaveChat is in flight.
        await this.env.DB.prepare(
          "UPDATE chats SET enabled=0,left_at=?,leave_pending=1 WHERE installation_id=? AND source_key='bot' AND chat_id=?",
        )
          .bind(now(), i.id, chatId)
          .run();
        attempted = true;
        if ((await leaveTelegramChannel(token, chatId)) !== true)
          throw new TelegramError(502);
        await this.env.DB.prepare(
          "UPDATE chats SET leave_pending=0 WHERE installation_id=? AND source_key='bot' AND chat_id=?",
        )
          .bind(i.id, chatId)
          .run();
        return "left";
      } catch (error) {
        if (
          error instanceof TelegramError &&
          [400, 403, 429].includes(error.code)
        ) {
          if (attempted)
            await this.env.DB.prepare(
              "UPDATE chats SET enabled=?,left_at=?,leave_pending=? WHERE installation_id=? AND source_key='bot' AND chat_id=?",
            )
              .bind(
                channel.enabled,
                channel.left_at,
                channel.leave_pending,
                i.id,
                chatId,
              )
              .run();
          if (error.code === 429) {
            state.managementRetryAt = now() + error.retryAfter;
            await this.ctx.storage.put("state", state);
            return "rate_limited";
          }
          return "rejected";
        }
        if (error instanceof TelegramError && error.code === 401) {
          await this.env.DB.prepare(
            "UPDATE installations SET status='invalid',epoch=epoch+1,error_code='telegram_401' WHERE id=?",
          )
            .bind(i.id)
            .run();
          await this.ctx.storage.deleteAlarm();
        }
        // Do not retry a mutation automatically or expose upstream error text/credential URLs.
        return attempted ? "uncertain" : "unavailable";
      }
    });
  }
  async alarm() {
    return this.exclusive(() => this.poll());
  }
  private async poll() {
    const state = await this.ctx.storage.get<CollectorState>("state");
    if (!state) return;
    const i = await getInstallation(this.env.DB, state.installationId);
    if (!i || !["pending", "active"].includes(i.status)) return;
    // Renew at the beginning too: a runtime crash must not silently stop this collector.
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    try {
      const token = await unseal(
        state.token,
        `bot:${state.installationId}:${state.botId}`,
        this.env.BOT_KEYS,
      );
      // An encrypted durable inbox is replayed before acknowledging another Telegram batch.
      const pending = await readInbox(this.ctx.storage);
      if (pending) {
        await this.applyInbox(
          state,
          JSON.parse(
            await unseal(
              pending,
              `inbox:${state.installationId}`,
              this.env.BOT_KEYS,
            ),
          ) as Inbox,
        );
        await processImages(this.env, state.installationId, token);
        await processDocuments(this.env, state.installationId, token);
        await this.finishPoll(state);
        return;
      }
      if (now() - state.lastCheck > 300) {
        if ((await telegram(token, "getWebhookInfo")).url)
          throw new TelegramError(409);
        const { results } = await this.env.DB.prepare(
          "SELECT connection_id FROM connections WHERE installation_id=? AND enabled=1",
        )
          .bind(state.installationId)
          .all<{ connection_id: string }>();
        for (const c of results) {
          try {
            await saveConnection(
              this.env.DB,
              state.installationId,
              await telegram(token, "getBusinessConnection", {
                business_connection_id: c.connection_id,
              }),
            );
          } catch (e) {
            if (e instanceof TelegramError && [400, 403].includes(e.code))
              await this.env.DB.prepare(
                "UPDATE connections SET enabled=0 WHERE installation_id=? AND connection_id=?",
              )
                .bind(state.installationId, c.connection_id)
                .run();
            else throw e;
          }
        }
        state.lastCheck = now();
      }
      const updates = await telegram(token, "getUpdates", {
        offset: state.offset,
        // Leave room for media jobs and D1 writes within an invocation's query budget.
        limit: 5,
        timeout: 10,
        allowed_updates: [
          "message",
          "edited_message",
          "channel_post",
          "edited_channel_post",
          "my_chat_member",
          "business_connection",
          "business_message",
          "edited_business_message",
          "deleted_business_messages",
        ],
      });
      if (updates.length) {
        const retained: TelegramUpdate[] = [];
        // Resolve newly seen Business connections before storing their messages, in update order.
        const connectionStates = new Map<string, boolean>();
        for (const update of updates) {
          if (update.business_connection) {
            connectionStates.set(
              update.business_connection.id,
              update.business_connection.is_enabled,
            );
            retained.push(minimalUpdate(update));
            continue;
          }
          const connectionId =
            (update.business_message ?? update.edited_business_message)
              ?.business_connection_id ??
            update.deleted_business_messages?.business_connection_id;
          if (connectionId) {
            if (!connectionStates.has(connectionId)) {
              let c = await getConnection(
                this.env.DB,
                state.installationId,
                connectionId,
              );
              if (!c) {
                try {
                  await saveConnection(
                    this.env.DB,
                    state.installationId,
                    await telegram(token, "getBusinessConnection", {
                      business_connection_id: connectionId,
                    }),
                  );
                } catch (e) {
                  if (e instanceof TelegramError && [400, 403].includes(e.code))
                    continue;
                  throw e;
                }
                c = await getConnection(
                  this.env.DB,
                  state.installationId,
                  connectionId,
                );
              }
              connectionStates.set(connectionId, Boolean(c?.enabled));
            }
            // A deletion must still erase retained data after the connection is disabled.
            if (
              !connectionStates.get(connectionId) &&
              !update.deleted_business_messages
            )
              continue;
          }
          retained.push(minimalUpdate(update));
        }
        const inbox: Inbox = {
          nextOffset: Math.max(...updates.map((u) => u.update_id)) + 1,
          updates: retained,
        };
        await writeInbox(
          this.ctx.storage,
          await seal(
            JSON.stringify(inbox),
            `inbox:${state.installationId}`,
            this.env.BOT_KEYS,
            this.env.ACTIVE_KEY_ID,
          ),
        );
        await this.applyInbox(state, inbox);
      }
      await processImages(this.env, state.installationId, token);
      await processDocuments(this.env, state.installationId, token);
      await this.finishPoll(state);
    } catch (error) {
      const code =
        error instanceof TelegramError
          ? `telegram_${error.code}`
          : "sync_failed";
      await this.env.DB.prepare(
        "UPDATE installations SET error_code=? WHERE id=?",
      )
        .bind(code, state.installationId)
        .run();
      if (error instanceof TelegramError && [401, 409].includes(error.code)) {
        await this.env.DB.prepare(
          "UPDATE installations SET epoch=epoch+1,status=? WHERE id=?",
        )
          .bind(error.code === 401 ? "invalid" : "paused", state.installationId)
          .run();
        await this.ctx.storage.deleteAlarm();
      } else {
        state.failures++;
        await this.ctx.storage.put("state", state);
        const seconds =
          error instanceof TelegramError && error.code === 429
            ? error.retryAfter
            : Math.min(900, 2 ** Math.min(state.failures, 9) * 5);
        await this.ctx.storage.setAlarm(Date.now() + seconds * 1000);
      }
      console.warn(JSON.stringify({ event: "collector_error", code }));
    }
  }
  private async finishPoll(state: CollectorState) {
    state.failures = 0;
    await this.ctx.storage.put("state", state);
    await this.env.DB.prepare(
      "UPDATE installations SET last_sync=?,error_code=NULL WHERE id=?",
    )
      .bind(now(), state.installationId)
      .run();
    await this.ctx.storage.setAlarm(Date.now() + 1000);
  }
  private async applyInbox(state: CollectorState, inbox: Inbox) {
    for (const update of inbox.updates) {
      await materialize(this.env.DB, state.installationId, update);
      await stageImage(this.env, state.installationId, update);
      await stageDocument(this.env, state.installationId, update);
    }
    await cleanupImages(this.env, state.installationId);
    await cleanupDocuments(this.env, state.installationId);
    state.offset = inbox.nextOffset;
    await this.ctx.storage.transaction(async (tx) => {
      await tx.put("state", state);
      await clearInbox(tx);
    });
  }
}

export default class SyncService extends WorkerEntrypoint<SyncEnv> {
  async fetch() {
    return new Response("Not found", { status: 404 });
  }
  // Return plain data: custom Error subclasses/properties do not survive Worker RPC.
  async enrollForAuth(
    token: string,
  ): Promise<
    | { ok: true; installation: Installation }
    | { ok: false; code: AuthFailureCode }
  > {
    try {
      return { ok: true, installation: await this.enroll(token.trim()) };
    } catch (error) {
      let code: AuthFailureCode = "enrollment_unavailable";
      if (error instanceof AuthFlowError) code = error.code;
      else if (error instanceof TelegramError) {
        code = [401, 404].includes(error.code)
          ? "bot_token_invalid"
          : error.code === 403
            ? "bot_access_denied"
            : error.code === 429
              ? "telegram_rate_limited"
              : "telegram_unavailable";
      }
      return { ok: false, code };
    }
  }
  async enroll(token: string): Promise<Installation> {
    validateTokenFormat(token);
    const me = await telegram(token, "getMe");
    if ((await telegram(token, "getWebhookInfo")).url)
      throw new AuthFlowError("webhook_conflict");
    return this.env.COLLECTORS.getByName(String(me.id)).enroll(
      token,
      String(me.id),
      me.username ?? String(me.id),
    );
  }
  async discover(botId: string, connectionId: string) {
    return this.env.COLLECTORS.getByName(botId).discover(connectionId);
  }
  async control(
    botId: string,
    action: "revoke" | "disconnect" | "delete" | "resume",
  ) {
    return this.env.COLLECTORS.getByName(botId).control(action);
  }
  async leaveChannel(
    botId: string,
    sessionHash: string,
    confirmationHash: string,
  ) {
    return this.env.COLLECTORS.getByName(botId).leaveChannel(
      sessionHash,
      confirmationHash,
    );
  }
  async scheduled() {
    await retain(this.env.DB);
    await cleanupImages(this.env);
    await cleanupDocuments(this.env);
    let after = "";
    for (;;) {
      const { results } = await this.env.DB.prepare(
        "SELECT bot_id FROM installations WHERE status IN ('active','pending') AND bot_id > ? ORDER BY bot_id LIMIT 100",
      )
        .bind(after)
        .all<{ bot_id: string }>();
      if (!results.length) break;
      for (let n = 0; n < results.length; n += 5)
        await Promise.all(
          results
            .slice(n, n + 5)
            .map((i) => this.env.COLLECTORS.getByName(i.bot_id).wake()),
        );
      after = results.at(-1)!.bot_id;
    }
  }
}
