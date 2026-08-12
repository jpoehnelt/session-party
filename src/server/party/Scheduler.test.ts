import {
  applyD1Migrations,
  env,
  runInDurableObject,
  type D1Migration,
} from "cloudflare:test";
import { External } from "contracts/errors";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runScheduledEffect } from "../adapt";
import worker, { recoverMailScheduler } from "../index";
import { sendMail, sessionSecret } from "../services";
import {
  DEMO_RATE_SOURCE_LIMIT,
  MAIL_DISPATCH_CONCURRENCY,
  MAIL_SCHEDULER_NAME,
  processWithBoundedConcurrency,
  reserveDispatchBudget,
} from "./Scheduler";

type TestEnv = Cloudflare.Env & {
  readonly TEST_MIGRATIONS: readonly D1Migration[];
};

const mailScheduler = () => env.SCHEDULER.get(env.SCHEDULER.idFromName(MAIL_SCHEDULER_NAME));

async function resetMailScheduler(): Promise<ReturnType<typeof mailScheduler>> {
  const scheduler = mailScheduler();
  await runInDurableObject(scheduler, async (_instance, state) => {
    await state.storage.deleteAlarm();
    await state.storage.deleteAll();
    await state.storage.put("mail-scheduler-enabled", true);
  });
  return scheduler;
}

async function runMailSchedulerAlarm(
  scheduler: ReturnType<typeof mailScheduler>,
  setup?: (storage: DurableObjectStorage) => Promise<void>,
): Promise<void> {
  await runInDurableObject(scheduler, async (instance, state) => {
    await state.storage.deleteAlarm();
    if (setup) await setup(state.storage);
    try {
      await instance.alarm();
    } finally {
      await state.storage.deleteAlarm();
    }
  });
}

beforeAll(async () => {
  if (!("TEST_MIGRATIONS" in env)) {
    throw new Error("TEST_MIGRATIONS test binding is unavailable");
  }
  await applyD1Migrations(env.DB, [...(env as TestEnv).TEST_MIGRATIONS]);
});

afterAll(async () => {
  for (const name of [
    MAIL_SCHEDULER_NAME,
    "mail-recovery-wrong-name",
    "auth-rate-limit-proof",
    "demo-rate-limit-proof",
    "cfp-rate-limit-proof",
  ]) {
    const scheduler = env.SCHEDULER.get(env.SCHEDULER.idFromName(name));
    await runInDurableObject(scheduler, async (_instance, state) => {
      await state.storage.deleteAlarm();
      await state.storage.deleteAll();
    });
  }
});

describe("Scheduler durable delivery recovery", () => {
  it("contains and redacts scheduled Effect failures at the adapter boundary", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(runScheduledEffect(
        env,
        "scheduler.testFailure",
        Effect.fail(new External({ service: "test-service", detail: "expected failure" })),
      )).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
        message: "Application scheduled task failed",
        error: "External",
        operation: "scheduler.testFailure",
        service: "test-service",
      });
    } finally {
      error.mockRestore();
    }
  });

  it("dispatches concurrently without exceeding the scheduler worker bound", async () => {
    let active = 0;
    let maximumActive = 0;
    const completed: number[] = [];
    await processWithBoundedConcurrency(
      Array.from({ length: MAIL_DISPATCH_CONCURRENCY * 2 + 1 }, (_, index) => index),
      MAIL_DISPATCH_CONCURRENCY,
      async (value) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        completed.push(value);
        active -= 1;
      },
    );
    expect(maximumActive).toBe(MAIL_DISPATCH_CONCURRENCY);
    expect(completed).toHaveLength(MAIL_DISPATCH_CONCURRENCY * 2 + 1);
  });

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
      "CREATE TRIGGER fail_auth_redaction BEFORE UPDATE OF rendered_html ON mail_delivery_snapshots WHEN old.id = 'crash-snapshot' AND new.redacted_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'forced redaction failure'); END",
    ).run();

    const stub = await resetMailScheduler();
    try {
      await runMailSchedulerAlarm(stub);

      const delivery = await env.DB.prepare(
        "SELECT status, attempt_count, provider, provider_message_id, lease_owner, lease_expires_at FROM mail_deliveries WHERE id = 'crash-delivery'",
      ).first();
      expect(delivery).toEqual({
        status: "sent",
        attempt_count: 2,
        provider: "local-fake",
        provider_message_id: providerBeforeCrash.providerMessageId,
        lease_owner: null,
        lease_expires_at: null,
      });
      const attempts = await env.DB.prepare(
        "SELECT attempt_number, status, provider_message_id, provider_result, error FROM mail_delivery_attempts WHERE delivery_id = 'crash-delivery' ORDER BY attempt_number",
      ).all<{ attempt_number: number; status: string; provider_message_id: string | null; provider_result: string | null; error: string | null }>();
      expect(attempts.results).toEqual([
        {
          attempt_number: 1,
          status: "retry",
          provider_message_id: null,
          provider_result: null,
          error: "Delivery lease expired before completion; retrying with a new attempt",
        },
        expect.objectContaining({
          attempt_number: 2,
          status: "sent",
          provider_message_id: providerBeforeCrash.providerMessageId,
          error: null,
        }),
      ]);
      const attemptResult = JSON.parse(attempts.results[1]?.provider_result ?? "{}") as Record<string, unknown>;
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
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS fail_auth_redaction").run();
    }
    await runMailSchedulerAlarm(stub);
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

  it("dead-letters an expired crash-window lease at the maximum attempt count", async () => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO mail_delivery_snapshots
          (id, event_id, recipient_email, from_email, subject, rendered_html, rendered_text, created_at)
         VALUES ('exhausted-crash-snapshot', NULL, 'exhausted@example.com', 'Session Party <welcome@sessionparty.com>', 'Exhausted', '<p>Exhausted</p>', 'Exhausted', ?)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO mail_deliveries
          (id, snapshot_id, idempotency_key, status, scheduled_for, available_at, lease_owner, lease_expires_at, attempt_count, max_attempts, provider, created_at)
         VALUES ('exhausted-crash-delivery', 'exhausted-crash-snapshot', 'exhausted-crash-delivery', 'dispatching', ?, ?, 'dead-worker', ?, 2, 2, 'cloudflare-email', ?)`,
      ).bind(now, now, now - 1, now),
      env.DB.prepare(
        `INSERT INTO mail_delivery_attempts
          (id, delivery_id, attempt_number, lease_owner, status, started_at)
         VALUES ('exhausted-crash-attempt', 'exhausted-crash-delivery', 2, 'dead-worker', 'started', ?)`,
      ).bind(now - 60_000),
    ]);

    const scheduler = await resetMailScheduler();
    await runMailSchedulerAlarm(scheduler);
    expect(await env.DB.prepare(
      "SELECT status, attempt_count, last_error, dead_lettered_at IS NOT NULL AS dead_lettered, lease_owner FROM mail_deliveries WHERE id = 'exhausted-crash-delivery'",
    ).first()).toEqual({
      status: "dead_letter",
      attempt_count: 2,
      last_error: "Delivery lease expired after the maximum number of attempts",
      dead_lettered: 1,
      lease_owner: null,
    });
    expect(await env.DB.prepare(
      "SELECT status, error, completed_at IS NOT NULL AS completed FROM mail_delivery_attempts WHERE id = 'exhausted-crash-attempt'",
    ).first()).toEqual({
      status: "failed",
      error: "Delivery lease expired after the maximum number of attempts",
      completed: 1,
    });
  });

  it("redacts terminal reviewer-invitation mail containing a bearer token", async () => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, email, name, version, created_at, updated_at) VALUES ('invitation-owner', 'invitation-owner@example.com', 'Invitation Owner', 1, ?, ?)").bind(now, now),
      env.DB.prepare("INSERT INTO events (id, slug, name, timezone, version, created_at, updated_at) VALUES ('invitation-event', 'invitation-event', 'Invitation Event', 'UTC', 1, ?, ?)").bind(now, now),
      env.DB.prepare("INSERT INTO event_members (id, event_id, user_id, role, version, created_at, updated_at) VALUES ('invitation-owner-member', 'invitation-event', 'invitation-owner', 'owner', 1, ?, ?)").bind(now, now),
      env.DB.prepare(`INSERT INTO mail_delivery_snapshots
        (id, event_id, recipient_email, from_email, subject, rendered_html, rendered_text, created_at)
        VALUES ('invitation-snapshot', 'invitation-event', 'invitee@example.com', 'Session Party <welcome@sessionparty.com>', 'Reviewer invitation', '<a href="https://example.test/reviewer-invitations/accept?token=secret">Accept</a>', 'token=secret', ?)`)
        .bind(now),
      env.DB.prepare(`INSERT INTO mail_deliveries
        (id, snapshot_id, idempotency_key, status, scheduled_for, available_at, attempt_count, max_attempts, provider, provider_message_id, sent_at, created_at)
        VALUES ('invitation-delivery', 'invitation-snapshot', 'auth-reviewer-invitation:invitation-record', 'sent', ?, ?, 1, 8, 'local-fake', 'invitation-provider-id', ?, ?)`)
        .bind(now, now, now, now),
      env.DB.prepare(`INSERT INTO reviewer_invitations
        (id, event_id, email, token_hash, status, invited_by_user_id, accepted_by_user_id, delivery_id, expires_at, accepted_at, version, created_at, updated_at)
        VALUES ('invitation-record', 'invitation-event', 'invitee@example.com', ?, 'pending', 'invitation-owner', NULL, 'invitation-delivery', ?, NULL, 1, ?, ?)`)
        .bind("d".repeat(64), now + 86_400_000, now, now),
    ]);
    const scheduler = env.SCHEDULER.get(env.SCHEDULER.idFromName(MAIL_SCHEDULER_NAME));
    await runInDurableObject(scheduler, async (_instance, state) => state.storage.deleteAll());
    await recoverMailScheduler(env);
    await runInDurableObject(scheduler, async (instance) => instance.alarm());

    expect(await env.DB.prepare(
      "SELECT redacted_at IS NOT NULL AS redacted, rendered_html, rendered_text FROM mail_delivery_snapshots WHERE id = 'invitation-snapshot'",
    ).first()).toEqual({ redacted: 1, rendered_html: null, rendered_text: null });
    await runInDurableObject(scheduler, async (_instance, state) => {
      await state.storage.deleteAlarm();
      await state.storage.deleteAll();
    });
  });
  it("recovers a committed delivery through the canonical scheduled wake", async () => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO mail_delivery_snapshots
          (id, event_id, recipient_email, from_email, subject, rendered_html, rendered_text, created_at)
         VALUES ('scheduled-recovery-snapshot', NULL, 'recovery@example.com', 'Session Party <welcome@sessionparty.com>', 'Recovery', '<p>Recovery</p>', 'Recovery', ?)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO mail_deliveries
          (id, snapshot_id, idempotency_key, scheduled_for, available_at, provider, created_at)
         VALUES ('scheduled-recovery-delivery', 'scheduled-recovery-snapshot', 'scheduled-recovery-delivery', ?, ?, 'cloudflare-email', ?)`,
      ).bind(now, now, now),
    ]);
    expect(MAIL_SCHEDULER_NAME).toBe("mail");
    const canonical = env.SCHEDULER.get(env.SCHEDULER.idFromName(MAIL_SCHEDULER_NAME));
    const noncanonical = env.SCHEDULER.get(env.SCHEDULER.idFromName("mail-recovery-wrong-name"));
    await runInDurableObject(canonical, async (_instance, state) => state.storage.deleteAll());
    await runInDurableObject(canonical, async (instance) => instance.alarm());
    expect(await env.DB.prepare(
      "SELECT status, attempt_count FROM mail_deliveries WHERE id = 'scheduled-recovery-delivery'",
    ).first()).toEqual({ status: "pending", attempt_count: 0 });

    const waits: Promise<unknown>[] = [];
    worker.scheduled!(
      { cron: "* * * * *", scheduledTime: now, noRetry() {} } as ScheduledController,
      env,
      { waitUntil(promise: Promise<unknown>) { waits.push(promise); } } as unknown as ExecutionContext,
    );
    expect(waits).toHaveLength(2);
    await Promise.all(waits);
    expect(await runInDurableObject(
      canonical,
      async (_instance, state) => state.storage.get("mail-scheduler-enabled"),
    )).toBe(true);
    expect(await runInDurableObject(
      noncanonical,
      async (_instance, state) => state.storage.get("mail-scheduler-enabled"),
    )).toBeUndefined();
    await runMailSchedulerAlarm(canonical);
    expect(await env.DB.prepare(
      "SELECT status, attempt_count FROM mail_deliveries WHERE id = 'scheduled-recovery-delivery'",
    ).first()).toEqual({ status: "sent", attempt_count: 1 });

    await expect(recoverMailScheduler(env)).resolves.toBeUndefined();
  });
  it("cancels a superseded claimed delivery before sending its replacement", async () => {
    const now = Date.now();
    await env.DB.batch([
      ...["original", "replacement"].map((suffix) => env.DB.prepare(
        `INSERT INTO mail_delivery_snapshots
          (id, event_id, recipient_email, from_email, subject, rendered_html, rendered_text, created_at)
         VALUES (?, NULL, 'claimed@example.com', 'Session Party <welcome@sessionparty.com>', ?, '<p>Calendar</p>', 'Calendar', ?)`,
      ).bind(`claimed-${suffix}-snapshot`, suffix, now)),
      env.DB.prepare(
        `INSERT INTO mail_deliveries
          (id, snapshot_id, idempotency_key, status, scheduled_for, available_at, lease_owner, lease_expires_at,
           superseded_at, attempt_count, provider, created_at)
         VALUES ('claimed-original-delivery', 'claimed-original-snapshot', 'claimed-original', 'claimed', ?, ?,
           'expired-claim', ?, ?, 1, 'cloudflare-email', ?)`,
      ).bind(now, now, now - 1, now - 1_000, now),
      env.DB.prepare(
        `INSERT INTO mail_deliveries
          (id, snapshot_id, idempotency_key, status, scheduled_for, available_at, provider, created_at)
         VALUES ('claimed-replacement-delivery', 'claimed-replacement-snapshot', 'claimed-replacement', 'pending', ?, ?,
           'cloudflare-email', ?)`,
      ).bind(now, now, now),
    ]);
    const scheduler = await resetMailScheduler();
    await runMailSchedulerAlarm(scheduler);
    expect(await env.DB.prepare(
      `SELECT id, status, attempt_count FROM mail_deliveries
       WHERE id IN ('claimed-original-delivery', 'claimed-replacement-delivery') ORDER BY id`,
    ).all()).toMatchObject({
      results: [
        { id: "claimed-original-delivery", status: "cancelled", attempt_count: 1 },
        { id: "claimed-replacement-delivery", status: "sent", attempt_count: 1 },
      ],
    });
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM mail_delivery_attempts WHERE delivery_id = 'claimed-original-delivery'",
    ).first()).toEqual({ count: 0 });
  });


  it("redacts only terminal campaign snapshots at the ninety-day boundary", async () => {
    const now = Date.now();
    const retentionMs = 90 * 24 * 60 * 60_000;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO events (id, slug, name, timezone, version, created_at, updated_at)
         VALUES ('retention-event', 'retention-event', 'Retention event', 'UTC', 1, ?, ?)`,
      ).bind(now, now),
      ...[
        ["before", now - retentionMs + 60_000, "sent"],
        ["boundary", now - retentionMs, "sent"],
        ["after", now - retentionMs - 1, "dead_letter"],
        ["cancelled", now - retentionMs - 1, "cancelled"],
        ["pending", now - retentionMs - 1, "pending"],
      ].flatMap(([name, createdAt, status]) => [
        env.DB.prepare(
          `INSERT INTO mail_delivery_snapshots
            (id, event_id, recipient_email, from_email, subject, rendered_html, rendered_text, ics_filename, ics_content, created_at)
           VALUES (?, 'retention-event', ?, 'Agenda <agenda@example.com>', 'Retention', '<p>Retention</p>', 'Retention', 'retention.ics', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR', ?)`,
        ).bind(`retention-${name}-snapshot`, `${name}@example.com`, createdAt),
        env.DB.prepare(
          `INSERT INTO mail_deliveries
            (id, snapshot_id, idempotency_key, status, scheduled_for, available_at, attempt_count, max_attempts, provider, provider_message_id, sent_at, dead_lettered_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, 8, 'cloudflare-email', ?, ?, ?, ?)`,
        ).bind(
          `retention-${name}-delivery`,
          `retention-${name}-snapshot`,
          `comms:retention-${name}`,
          status,
          now + 86_400_000,
          now + 86_400_000,
          status === "sent" ? `provider-${name}` : null,
          status === "sent" ? now : null,
          status === "dead_letter" ? now : null,
          createdAt,
        ),
      ]),
    ]);
    const stub = await resetMailScheduler();
    await runMailSchedulerAlarm(stub);
    const snapshots = await env.DB.prepare(
      `SELECT substr(id, length('retention-') + 1, instr(substr(id, length('retention-') + 1), '-') - 1) AS name,
              redacted_at IS NOT NULL AS redacted,
              rendered_html,
              rendered_text,
              ics_filename,
              ics_content
       FROM mail_delivery_snapshots
       WHERE id LIKE 'retention-%-snapshot'
       ORDER BY id`,
    ).all();
    expect(snapshots.results).toEqual([
      { name: "after", redacted: 1, rendered_html: null, rendered_text: null, ics_filename: null, ics_content: null },
      { name: "before", redacted: 0, rendered_html: "<p>Retention</p>", rendered_text: "Retention", ics_filename: "retention.ics", ics_content: "BEGIN:VCALENDAR\r\nEND:VCALENDAR" },
      { name: "boundary", redacted: 1, rendered_html: null, rendered_text: null, ics_filename: null, ics_content: null },
      { name: "cancelled", redacted: 1, rendered_html: null, rendered_text: null, ics_filename: null, ics_content: null },
      { name: "pending", redacted: 0, rendered_html: "<p>Retention</p>", rendered_text: "Retention", ics_filename: "retention.ics", ics_content: "BEGIN:VCALENDAR\r\nEND:VCALENDAR" },
    ]);
    expect(await env.DB.prepare(
      "SELECT provider_message_id, sent_at IS NOT NULL AS sent FROM mail_deliveries WHERE id = 'retention-boundary-delivery'",
    ).first()).toEqual({ provider_message_id: "provider-boundary", sent: 1 });
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
    const stub = await resetMailScheduler();
    const day = new Date(now).toISOString().slice(0, 10);
    await runMailSchedulerAlarm(stub, async (storage) => {
      await storage.put(`dispatch-budget:${day}:total`, 1_000);
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
  it("rate-limits demo login attempts per source without consuming other sources", async () => {
    const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName("demo-rate-limit-proof"));
    const authorize = (sourceHash: string) => stub.fetch("https://scheduler/auth/demo/authorize", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-party-internal": sessionSecret(env),
      },
      body: JSON.stringify({ sourceHash }),
    });
    const source = "a".repeat(64);
    for (let index = 0; index < DEMO_RATE_SOURCE_LIMIT; index += 1) {
      expect((await authorize(source)).status).toBe(200);
    }
    expect((await authorize(source)).status).toBe(429);
    expect((await authorize("b".repeat(64))).status).toBe(200);
  });
  it("atomically enforces CFP hourly source and daily recipient budgets", async () => {
    const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName("cfp-rate-limit-proof"));
    const authorize = (source: number, recipient: number) => stub.fetch(
      "https://scheduler/cfp/authorize",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-session-party-internal": sessionSecret(env),
        },
        body: JSON.stringify({
          sourceHash: source.toString(16).padStart(64, "0"),
          recipientHash: recipient.toString(16).padStart(64, "0"),
          eventId: "demo-event",
          formId: "demo-form",
        }),
      },
    );

    const sourceStatuses = await Promise.all(
      Array.from({ length: 11 }, (_, index) => authorize(1, 1_000 + index)),
    );
    expect(sourceStatuses.filter((response) => response.status === 200)).toHaveLength(10);
    expect(sourceStatuses.filter((response) => response.status === 429)).toHaveLength(1);

    const recipientStatuses = await Promise.all(
      Array.from({ length: 4 }, (_, index) => authorize(100 + index, 2_000)),
    );
    expect(recipientStatuses.filter((response) => response.status === 200)).toHaveLength(3);
    expect(recipientStatuses.filter((response) => response.status === 429)).toHaveLength(1);

    const malformed = await stub.fetch("https://scheduler/cfp/authorize", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-party-internal": sessionSecret(env),
      },
      body: JSON.stringify({ sourceHash: "untrusted" }),
    });
    expect(malformed.status).toBe(400);
  });
});
