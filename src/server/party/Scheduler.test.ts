import {
  applyD1Migrations,
  env,
  runInDurableObject,
  type D1Migration,
} from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { sendMail, sessionSecret } from "../services";
import { reserveDispatchBudget } from "./Scheduler";

type TestEnv = Cloudflare.Env & {
  readonly TEST_MIGRATIONS: readonly D1Migration[];
};

beforeAll(async () => {
  if (!("TEST_MIGRATIONS" in env)) {
    throw new Error("TEST_MIGRATIONS test binding is unavailable");
  }
  await applyD1Migrations(env.DB, [...(env as TestEnv).TEST_MIGRATIONS]);
});

describe("Scheduler durable delivery recovery", () => {
  it("reclaims a crash-window send with stable correlation and durable evidence", async () => {
    const idempotencyKey = "auth-magic-link:crash-token";
    const payload = {
      fromEmail: "Sender <sender@example.com>",
      replyToEmail: "reply@example.com",
      to: "recipient@example.com",
      subject: "Crash recovery",
      html: "<p>Crash recovery</p>",
      text: "Crash recovery",
      icsFilename: "recovery.ics",
      ics: "BEGIN:VCALENDAR\nEND:VCALENDAR",
      idempotencyKey,
    } as const;
    const providerBeforeCrash = await sendMail(env, payload);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users (id, email, name, version, created_at, updated_at) VALUES ('crash-user', 'crash@example.com', 'Crash User', 1, ?, ?)",
      ).bind(now, now),
      env.DB.prepare(
        "INSERT INTO auth_tokens (id, token_hash, user_id, kind, expires_at, consumed_at, created_at) VALUES ('crash-token', ?, 'crash-user', 'magic_link', ?, NULL, ?)",
      ).bind("c".repeat(64), now + 15 * 60_000, now),
      env.DB.prepare(
        `INSERT INTO mail_delivery_snapshots
          (id, event_id, template_id, recipient_user_id, recipient_email, recipient_name, from_email, reply_to_email, subject, rendered_html, rendered_text, ics_filename, ics_content, created_at)
         VALUES ('crash-snapshot', NULL, NULL, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        payload.to,
        payload.fromEmail,
        payload.replyToEmail,
        payload.subject,
        payload.html,
        payload.text,
        payload.icsFilename,
        payload.ics,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO mail_deliveries
          (id, snapshot_id, idempotency_key, status, scheduled_for, available_at, lease_owner, lease_expires_at, attempt_count, max_attempts, provider, provider_message_id, provider_result, last_error, sent_at, dead_lettered_at, created_at)
         VALUES ('crash-delivery', 'crash-snapshot', ?, 'claimed', ?, ?, 'dead-worker', ?, 1, 8, 'cloudflare-email', NULL, NULL, NULL, NULL, NULL, ?)`,
      ).bind(idempotencyKey, now, now, now - 1, now),
      env.DB.prepare(
        `INSERT INTO mail_delivery_attempts
          (id, delivery_id, attempt_number, lease_owner, status, provider_message_id, provider_result, error, started_at, completed_at)
         VALUES ('crash-attempt', 'crash-delivery', 1, 'dead-worker', 'started', NULL, NULL, NULL, ?, NULL)`,
      ).bind(now - 60_000),
    ]);
    await env.DB.prepare(
      "CREATE TRIGGER fail_auth_redaction BEFORE UPDATE OF rendered_html ON mail_delivery_snapshots WHEN new.redacted_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'forced redaction failure'); END",
    ).run();

    const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName("mail"));
    await runInDurableObject(stub, async (_instance, state) => state.storage.deleteAll());
    await stub.fetch("https://scheduler/poke", {
      method: "POST",
      headers: { "x-session-party-internal": sessionSecret(env) },
    });
    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });

    const delivery = await env.DB.prepare(
      "SELECT status, attempt_count, provider, provider_message_id, lease_owner, lease_expires_at FROM mail_deliveries WHERE id = 'crash-delivery'",
    ).first();
    expect(delivery).toEqual({
      status: "sent",
      attempt_count: 1,
      provider: "local-fake",
      provider_message_id: providerBeforeCrash.providerMessageId,
      lease_owner: null,
      lease_expires_at: null,
    });
    const attempts = await env.DB.prepare(
      "SELECT count(*) AS count, min(status) AS status, min(provider_message_id) AS provider_message_id, min(provider_result) AS provider_result FROM mail_delivery_attempts WHERE delivery_id = 'crash-delivery'",
    ).first<{ count: number; status: string; provider_message_id: string; provider_result: string }>();
    expect(attempts).toMatchObject({
      count: 1,
      status: "sent",
      provider_message_id: providerBeforeCrash.providerMessageId,
    });
    const attemptResult = JSON.parse(attempts?.provider_result ?? "{}") as Record<string, unknown>;
    expect(attemptResult.outboundCorrelationId).toBe(
      providerBeforeCrash.providerResult.outboundCorrelationId,
    );
    const retained = await env.DB.prepare(
      "SELECT redacted_at IS NOT NULL AS redacted, rendered_html, rendered_text, ics_filename, ics_content FROM mail_delivery_snapshots WHERE id = 'crash-snapshot'",
    ).first();
    expect(retained).toEqual({
      redacted: 0,
      rendered_html: payload.html,
      rendered_text: payload.text,
      ics_filename: payload.icsFilename,
      ics_content: payload.ics,
    });
    await env.DB.prepare("DROP TRIGGER fail_auth_redaction").run();
    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });
    const redacted = await env.DB.prepare(
      "SELECT redacted_at IS NOT NULL AS redacted, rendered_html, rendered_text, ics_filename, ics_content FROM mail_delivery_snapshots WHERE id = 'crash-snapshot'",
    ).first();
    expect(redacted).toEqual({
      redacted: 1,
      rendered_html: null,
      rendered_text: null,
      ics_filename: null,
      ics_content: null,
    });
  });
  it("atomically reserves account capacity while preserving auth headroom", async () => {
    const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName("mail"));
    const now = Date.UTC(2026, 7, 8, 12);
    const limits = { total: 5, campaign: 3, event: 2 } as const;
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAll();
      expect((await reserveDispatchBudget(state.storage, {
        eventId: "event-a",
        now,
        limits,
      })).ok).toBe(true);
      expect((await reserveDispatchBudget(state.storage, {
        eventId: "event-a",
        now,
        limits,
      })).ok).toBe(true);
      expect(await reserveDispatchBudget(state.storage, {
        eventId: "event-a",
        now,
        limits,
      })).toEqual({ ok: false, reason: "event-limit" });
      expect((await reserveDispatchBudget(state.storage, {
        eventId: "event-b",
        now,
        limits,
      })).ok).toBe(true);
      expect(await reserveDispatchBudget(state.storage, {
        eventId: "event-b",
        now,
        limits,
      })).toEqual({ ok: false, reason: "campaign-limit" });
      expect((await reserveDispatchBudget(state.storage, {
        eventId: null,
        now,
        limits,
      })).ok).toBe(true);

      const races = await Promise.all(Array.from({ length: 10 }, () =>
        reserveDispatchBudget(state.storage, {
          eventId: null,
          now,
          limits,
        })));
      expect(races.filter((result) => result.ok)).toHaveLength(1);
      expect(races.filter((result) => !result.ok && result.reason === "account-limit")).toHaveLength(9);
    });
  });

  it("records retry and dead-letter evidence when the account budget is exhausted", async () => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO mail_delivery_snapshots
          (id, event_id, recipient_email, from_email, subject, rendered_html, rendered_text, created_at)
         VALUES ('budget-retry-snapshot', NULL, 'retry@example.com', 'Session Party <welcome@sessionparty.com>', 'Retry', '<p>Retry</p>', 'Retry', ?)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO mail_delivery_snapshots
          (id, event_id, recipient_email, from_email, subject, rendered_html, rendered_text, created_at)
         VALUES ('budget-dead-snapshot', NULL, 'dead@example.com', 'Session Party <welcome@sessionparty.com>', 'Dead', '<p>Dead</p>', 'Dead', ?)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO mail_deliveries
          (id, snapshot_id, idempotency_key, scheduled_for, available_at, max_attempts, provider, created_at)
         VALUES ('budget-retry-delivery', 'budget-retry-snapshot', 'budget-retry-delivery', ?, ?, 8, 'cloudflare-email', ?)`,
      ).bind(now, now, now),
      env.DB.prepare(
        `INSERT INTO mail_deliveries
          (id, snapshot_id, idempotency_key, scheduled_for, available_at, max_attempts, provider, created_at)
         VALUES ('budget-dead-delivery', 'budget-dead-snapshot', 'budget-dead-delivery', ?, ?, 1, 'cloudflare-email', ?)`,
      ).bind(now, now, now),
    ]);
    const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName("mail"));
    await runInDurableObject(stub, async (_instance, state) => state.storage.deleteAll());
    await stub.fetch("https://scheduler/poke", {
      method: "POST",
      headers: { "x-session-party-internal": sessionSecret(env) },
    });
    const day = new Date(now).toISOString().slice(0, 10);
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put(`dispatch-budget:${day}:total`, 1_000);
      await instance.alarm();
    });
    const deliveries = await env.DB.prepare(
      `SELECT id, status, attempt_count, provider_message_id, last_error, dead_lettered_at IS NOT NULL AS dead_lettered
       FROM mail_deliveries
       WHERE id IN ('budget-retry-delivery', 'budget-dead-delivery')
       ORDER BY id`,
    ).all();
    expect(deliveries.results).toEqual([
      {
        id: "budget-dead-delivery",
        status: "dead_letter",
        attempt_count: 1,
        provider_message_id: null,
        last_error: "Daily email dispatch budget exhausted: account-limit",
        dead_lettered: 1,
      },
      {
        id: "budget-retry-delivery",
        status: "retry",
        attempt_count: 1,
        provider_message_id: null,
        last_error: "Daily email dispatch budget exhausted: account-limit",
        dead_lettered: 0,
      },
    ]);
    const attempts = await env.DB.prepare(
      `SELECT d.id, a.status, a.provider_message_id, a.error, a.completed_at IS NOT NULL AS completed
       FROM mail_delivery_attempts a
       JOIN mail_deliveries d ON d.id = a.delivery_id
       WHERE d.id IN ('budget-retry-delivery', 'budget-dead-delivery')
       ORDER BY d.id`,
    ).all();
    expect(attempts.results).toEqual([
      {
        id: "budget-dead-delivery",
        status: "failed",
        provider_message_id: null,
        error: "Daily email dispatch budget exhausted: account-limit",
        completed: 1,
      },
      {
        id: "budget-retry-delivery",
        status: "retry",
        provider_message_id: null,
        error: "Daily email dispatch budget exhausted: account-limit",
        completed: 1,
      },
    ]);
  });
  it("bounds auth requests without postponing an existing delivery alarm", async () => {
    const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName("auth-rate-limit-proof"));
    expect((await stub.fetch("https://scheduler/poke", {
      method: "POST",
      headers: { "x-session-party-internal": sessionSecret(env) },
    })).status).toBe(404);
    const scheduledAt = Date.now() + 5_000;
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.setAlarm(scheduledAt);
    });
    const statuses: number[] = [];
    for (let index = 0; index <= 100; index += 1) {
      const response = await stub.fetch("https://scheduler/auth/request-link/authorize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-session-party-internal": sessionSecret(env),
        },
        body: JSON.stringify({
          sourceHash: index.toString(16).padStart(64, "0"),
          recipientHash: (index + 1_000).toString(16).padStart(64, "0"),
        }),
      });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 100).every((status) => status === 200)).toBe(true);
    expect(statuses[100]).toBe(429);
    expect(await runInDurableObject(
      stub,
      async (_instance, state) => state.storage.getAlarm(),
    )).toBe(scheduledAt);

    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO mail_delivery_snapshots
          (id, event_id, recipient_email, from_email, subject, rendered_html, rendered_text, created_at)
         VALUES ('auth-limiter-guard-snapshot', NULL, 'guard@example.com', 'Session Party <welcome@sessionparty.com>', 'Guard', '<p>Guard</p>', 'Guard', ?)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO mail_deliveries
          (id, snapshot_id, idempotency_key, scheduled_for, available_at, provider, created_at)
         VALUES ('auth-limiter-guard-delivery', 'auth-limiter-guard-snapshot', 'auth-limiter-guard-delivery', ?, ?, 'cloudflare-email', ?)`,
      ).bind(now, now, now),
    ]);
    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });
    expect(await env.DB.prepare(
      "SELECT status, attempt_count FROM mail_deliveries WHERE id = 'auth-limiter-guard-delivery'",
    ).first()).toEqual({ status: "pending", attempt_count: 0 });
  });
});
