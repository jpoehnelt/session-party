import {
  applyD1Migrations,
  env,
  SELF,
  type D1Migration,
} from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { sendMail } from "./services";

type TestEnv = Cloudflare.Env & {
  readonly TEST_MIGRATIONS: readonly D1Migration[];
};

const requestLink = (email: string, name?: string): Promise<Response> =>
  SELF.fetch("https://example.test/api/v1/auth/request-link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, name }),
  });

const magicLinkFor = async (email: string): Promise<string> => {
  const row = await env.DB.prepare(
    "SELECT s.rendered_text FROM mail_delivery_snapshots s WHERE s.recipient_email = ? ORDER BY s.created_at DESC LIMIT 1",
  ).bind(email).first<{ rendered_text: string }>();
  const url = row?.rendered_text.match(/https?:\/\/\S+/)?.[0];
  if (!url) throw new Error("Magic-link snapshot is missing its server-only URL");
  return url;
};

beforeAll(async () => {
  if (!("TEST_MIGRATIONS" in env)) {
    throw new Error("TEST_MIGRATIONS test binding is unavailable");
  }
  await applyD1Migrations(env.DB, [...(env as TestEnv).TEST_MIGRATIONS]);
});

describe("durable magic-link authentication", () => {
  it("coalesces concurrent requests into one token, snapshot, and delivery", async () => {
    const email = "concurrent-auth@example.com";
    const responses = await Promise.all([
      requestLink(email, "Concurrent Auth"),
      requestLink(email, "Concurrent Auth"),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([202, 202]);

    const counts = await env.DB.prepare(
      `SELECT
        (SELECT count(*) FROM users WHERE email = ?) AS users_count,
        (SELECT count(*) FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = ? AND t.kind = 'magic_link' AND t.consumed_at IS NULL) AS token_count,
        (SELECT count(*) FROM mail_delivery_snapshots WHERE recipient_email = ?) AS snapshot_count,
        (SELECT count(*) FROM mail_deliveries d JOIN mail_delivery_snapshots s ON s.id = d.snapshot_id WHERE s.recipient_email = ?) AS delivery_count`,
    ).bind(email, email, email, email).first();
    expect(counts).toEqual({
      users_count: 1,
      token_count: 1,
      snapshot_count: 1,
      delivery_count: 1,
    });

    const snapshot = await env.DB.prepare(
      `SELECT
        s.event_id,
        s.template_id,
        s.recipient_email,
        s.recipient_name,
        s.from_email,
        s.reply_to_email,
        s.subject,
        s.ics_filename,
        s.ics_content,
        d.idempotency_key,
        t.id AS token_id
      FROM mail_delivery_snapshots s
      JOIN mail_deliveries d ON d.snapshot_id = s.id
      JOIN users u ON u.id = s.recipient_user_id
      JOIN auth_tokens t ON t.user_id = u.id AND t.kind = 'magic_link' AND t.consumed_at IS NULL
      WHERE s.recipient_email = ?`,
    ).bind(email).first();
    expect(snapshot).toMatchObject({
      event_id: null,
      template_id: null,
      recipient_email: email,
      recipient_name: "Concurrent Auth",
      from_email: "Session Party <onboarding@resend.dev>",
      reply_to_email: null,
      subject: "Sign in to Session Party",
      ics_filename: null,
      ics_content: null,
    });
    expect(snapshot?.idempotency_key).toBe(`auth-magic-link:${snapshot?.token_id}`);
  });
  it("invalidates an expired link and cancels its queued delivery before replacement", async () => {
    const email = "expired-replacement@example.com";
    expect((await requestLink(email)).status).toBe(202);
    const old = await env.DB.prepare(
      `SELECT t.id AS token_id
       FROM auth_tokens t
       JOIN users u ON u.id = t.user_id
       WHERE u.email = ? AND t.kind = 'magic_link' AND t.consumed_at IS NULL`,
    ).bind(email).first<{ token_id: string }>();
    if (!old) throw new Error("Expected outstanding magic link");
    await env.DB.batch([
      env.DB.prepare("UPDATE auth_tokens SET expires_at = ? WHERE id = ?")
        .bind(Date.now() - 1, old.token_id),
      env.DB.prepare(
        "UPDATE mail_deliveries SET status = 'pending', available_at = ?, lease_owner = NULL, lease_expires_at = NULL, provider_message_id = NULL, sent_at = NULL WHERE idempotency_key = ?",
      ).bind(Date.now() + 60_000, `auth-magic-link:${old.token_id}`),
    ]);

    expect((await requestLink(email)).status).toBe(202);
    const key = `auth-magic-link:${old.token_id}`;
    const state = await env.DB.prepare(
      `SELECT
        (SELECT consumed_at IS NOT NULL FROM auth_tokens WHERE id = ?) AS old_consumed,
        (SELECT status FROM mail_deliveries WHERE idempotency_key = ?) AS old_delivery_status,
        (SELECT s.redacted_at IS NOT NULL
         FROM mail_delivery_snapshots s
         JOIN mail_deliveries d ON d.snapshot_id = s.id
         WHERE d.idempotency_key = ?) AS old_snapshot_redacted,
        (SELECT s.rendered_html IS NULL
         FROM mail_delivery_snapshots s
         JOIN mail_deliveries d ON d.snapshot_id = s.id
         WHERE d.idempotency_key = ?) AS old_body_removed,
        (SELECT count(*) FROM mail_deliveries WHERE idempotency_key = ?) AS old_delivery_evidence,
        (SELECT count(*) FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = ? AND t.kind = 'magic_link' AND t.consumed_at IS NULL) AS active_magic`,
    ).bind(old.token_id, key, key, key, key, email).first();
    expect(state).toEqual({
      old_consumed: 1,
      old_delivery_status: "cancelled",
      old_snapshot_redacted: 1,
      old_body_removed: 1,
      old_delivery_evidence: 1,
      active_magic: 1,
    });
  });


  it("rolls back user, token, and snapshot when delivery enqueue fails", async () => {
    const email = "rollback-request@example.com";
    await env.DB.prepare(
      "CREATE TRIGGER fail_magic_delivery BEFORE INSERT ON mail_deliveries BEGIN SELECT RAISE(ABORT, 'forced enqueue rollback'); END",
    ).run();
    try {
      const response = await requestLink(email, "Rollback Request");
      expect(response.status).toBe(202);
      const counts = await env.DB.prepare(
        `SELECT
          (SELECT count(*) FROM users WHERE email = ?) AS users_count,
          (SELECT count(*) FROM mail_delivery_snapshots WHERE recipient_email = ?) AS snapshot_count`,
      ).bind(email, email).first();
      expect(counts).toEqual({ users_count: 0, snapshot_count: 0 });
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_magic_delivery").run();
    }
  });

  it("atomically consumes a link once under concurrent verification", async () => {
    const email = "double-verify@example.com";
    expect((await requestLink(email)).status).toBe(202);
    const link = await magicLinkFor(email);
    const responses = await Promise.all([
      SELF.fetch(link, { redirect: "manual" }),
      SELF.fetch(link, { redirect: "manual" }),
    ]);
    expect(responses.map(({ status }) => status).sort()).toEqual([302, 401]);

    const sessions = await env.DB.prepare(
      "SELECT count(*) AS count FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = ? AND t.kind = 'session' AND t.consumed_at IS NULL",
    ).bind(email).first<{ count: number }>();
    expect(sessions?.count).toBe(1);
  });

  it("rolls back session creation when magic-token consumption fails", async () => {
    const email = "rollback-verify@example.com";
    expect((await requestLink(email)).status).toBe(202);
    const link = await magicLinkFor(email);
    await env.DB.prepare(
      "CREATE TRIGGER fail_magic_consume BEFORE UPDATE OF consumed_at ON auth_tokens WHEN OLD.kind = 'magic_link' BEGIN SELECT RAISE(ABORT, 'forced verify rollback'); END",
    ).run();
    try {
      const response = await SELF.fetch(link, { redirect: "manual" });
      expect(response.status).toBe(502);
      const state = await env.DB.prepare(
        `SELECT
          (SELECT count(*) FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = ? AND t.kind = 'magic_link' AND t.consumed_at IS NULL) AS active_magic,
          (SELECT count(*) FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = ? AND t.kind = 'session') AS sessions`,
      ).bind(email, email).first();
      expect(state).toEqual({ active_magic: 1, sessions: 0 });
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_magic_consume").run();
    }
  });

  it("deduplicates local provider receipts without exposing the idempotency key", async () => {
    const payload = {
      fromEmail: "Sender <sender@example.com>",
      replyToEmail: "reply@example.com",
      to: "recipient@example.com",
      subject: "Stable delivery",
      html: "<p>Stable</p>",
      icsFilename: "session.ics",
      ics: "BEGIN:VCALENDAR\nEND:VCALENDAR",
      idempotencyKey: "private-stable-delivery-key",
    } as const;
    const first = await sendMail(env, payload);
    const second = await sendMail(env, payload);
    expect(first.provider).toBe("local-fake");
    expect(first.providerMessageId).toBe(second.providerMessageId);
    expect(first.providerMessageId).toMatch(/^local-fake:[a-f0-9]{64}$/);
    expect(first.providerMessageId).not.toContain(payload.idempotencyKey);
  });
});
