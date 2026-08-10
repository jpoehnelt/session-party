import {
  applyD1Migrations,
  createExecutionContext,
  env,
  runInDurableObject,
  runDurableObjectAlarm,
  SELF,
  type D1Migration,
} from "cloudflare:test";
import { Effect } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import { hashBearerMaterial } from "./auth";
import worker from "./index";
import {
  AppLayer,
  isExplicitLocalEnvironment,
  isExplicitPreviewEnvironment,
  mailFrom,
  MailQueue,
  requireMailConfiguration,
  sendMail,
  sessionSecret,
} from "./services";

type TestEnv = Cloudflare.Env & {
  readonly TEST_MIGRATIONS: readonly D1Migration[];
};

let sourceSequence = 0;
const requestLink = (
  email: string,
  name?: string,
  source = `192.0.2.${++sourceSequence}`,
  returnTo?: string,
): Promise<Response> =>
  SELF.fetch("https://example.test/api/v1/auth/request-link", {
    method: "POST",
    headers: {
      "cf-connecting-ip": source,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, name, returnTo }),
  });

const nonLocalAuthEnv = new Proxy(env, {
  get(target, property, receiver) {
    if (property === "LOCAL_MODE") return undefined;
    if (property === "SESSION_SECRET") return "explicit-local-only-session-secret-v1";
    if (property === "MAIL_FROM") return "Session Party <welcome@sessionparty.com>";
    if (property === "EMAIL") return { send: async () => ({ messageId: "test-email-id" }) };
    return Reflect.get(target, property, receiver);
  },
}) as Env;
const requestNonLocalLink = (
  email: string,
  source = `192.0.2.${++sourceSequence}`,
): Promise<Response> =>
  Promise.resolve(worker.fetch(
    new Request("https://example.test/api/v1/auth/request-link", {
      method: "POST",
      headers: {
        "cf-connecting-ip": source,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email }),
    }),
    nonLocalAuthEnv,
    createExecutionContext(),
  ));

const requestLinkBody = (
  body: string,
  source = `192.0.2.${++sourceSequence}`,
): Promise<Response> =>
  SELF.fetch("https://example.test/api/v1/auth/request-link", {
    method: "POST",
    headers: {
      "cf-connecting-ip": source,
      "Content-Type": "application/json",
    },
    body,
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

describe("hackathon demo authentication", () => {
  it.each([
    ["organizer", "sbek-organizer@example.com", "Jordan Alvarez", "/e/devflow-conf-2027"],
    ["speaker", "sbek-speaker@example.com", "Priya Raman", "/e/devflow-conf-2027/portal"],
    ["reviewer", "sbek-reviewer@example.com", "Sam Whitfield", "/e/devflow-conf-2027/review"],
  ])("issues a normal session for the %s persona", async (persona, email, name, defaultReturnTo) => {
    const response = await SELF.fetch("https://example.test/api/v1/auth/demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ persona }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      persona,
      email,
      name,
      event: { slug: "devflow-conf-2027", name: "DevFlow Conf 2027" },
      returnTo: defaultReturnTo,
    });
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toContain("sp_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");

    const me = await SELF.fetch("https://example.test/api/v1/auth/me", {
      headers: { Cookie: cookie?.split(";")[0] ?? "" },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      user: { kind: "browser-session", email, name },
    });
  });

  it("rejects unknown personas without creating a session", async () => {
    const response = await SELF.fetch("https://example.test/api/v1/auth/demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ persona: "admin" }),
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("seeds distinct organizer, reviewer, and provisioned speaker access", async () => {
    await SELF.fetch("https://example.test/api/v1/auth/demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ persona: "organizer" }),
    });

    const seed = await env.DB.prepare(
      `SELECT
        (SELECT count(*) FROM users WHERE email IN (?, ?, ?)) AS user_count,
        (SELECT count(*) FROM events WHERE slug = 'devflow-conf-2027' AND name = 'DevFlow Conf 2027') AS event_count,
        (SELECT count(*)
         FROM event_members m
         JOIN events e ON e.id = m.event_id
         JOIN users u ON u.id = m.user_id
         WHERE e.slug = 'devflow-conf-2027' AND u.email = ? AND m.role = 'owner') AS owner_count,
        (SELECT count(*)
         FROM event_members m
         JOIN events e ON e.id = m.event_id
         JOIN users u ON u.id = m.user_id
         WHERE e.slug = 'devflow-conf-2027' AND u.email = ? AND m.role = 'reviewer') AS reviewer_count,
        (SELECT count(*)
         FROM speakers s
         JOIN events e ON e.id = s.event_id
         JOIN users u ON u.id = s.user_id
         JOIN speaker_provisioning p ON p.event_id = s.event_id AND p.primary_speaker_id = s.id
         WHERE e.slug = 'devflow-conf-2027' AND u.email = ? AND p.status = 'provisioned') AS provisioned_speaker_count`,
    ).bind(
      "sbek-organizer@example.com",
      "sbek-reviewer@example.com",
      "sbek-speaker@example.com",
      "sbek-organizer@example.com",
      "sbek-reviewer@example.com",
      "sbek-speaker@example.com",
    ).first();

    expect(seed).toEqual({
      user_count: 3,
      event_count: 1,
      owner_count: 1,
      reviewer_count: 1,
      provisioned_speaker_count: 1,
    });
  });

  it("preserves a safe explicit return path for every persona", async () => {
    const response = await SELF.fetch("https://example.test/api/v1/auth/demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ persona: "reviewer", returnTo: "/events?from=demo#top" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ returnTo: "/events?from=demo#top" });
  });

  it("authorizes the reviewer desk and the provisioned speaker portal independently", async () => {
    const speakerLogin = await SELF.fetch("https://example.test/api/v1/auth/demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ persona: "speaker" }),
    });
    const speakerCookie = speakerLogin.headers.get("set-cookie")?.split(";")[0] ?? "";
    const speakerPortal = await SELF.fetch("https://example.test/api/v1/events/devflow-conf-2027/portal", {
      headers: { Cookie: speakerCookie },
    });
    expect(speakerPortal.status).toBe(200);
    expect(await speakerPortal.json()).toMatchObject({
      event: { slug: "devflow-conf-2027" },
      speaker: { displayName: "Priya Raman" },
      provisioningStatus: "provisioned",
    });

    const reviewerLogin = await SELF.fetch("https://example.test/api/v1/auth/demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ persona: "reviewer" }),
    });
    const reviewerPayload = await reviewerLogin.json<{ event: { id: string } }>();
    const reviewerCookie = reviewerLogin.headers.get("set-cookie")?.split(";")[0] ?? "";
    const reviewDesk = await SELF.fetch(
      `https://example.test/api/v1/events/${reviewerPayload.event.id}/review`,
      { headers: { Cookie: reviewerCookie } },
    );
    expect(reviewDesk.status).toBe(200);
    expect(await reviewDesk.json()).toMatchObject({
      eventId: reviewerPayload.event.id,
      viewerRole: "reviewer",
      queue: [{ title: "Designing reliable AI workflows" }],
    });
  });

  it("normalizes unsafe return paths", async () => {
    const response = await SELF.fetch("https://example.test/api/v1/auth/demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ persona: "organizer", returnTo: "//example.net/steal" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ returnTo: "/e/devflow-conf-2027" });
  });
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
      from_email: "Session Party <welcome@sessionparty.com>",
      reply_to_email: null,
      subject: "Sign in to Session Party",
      ics_filename: null,
      ics_content: null,
    });
    expect(snapshot?.idempotency_key).toBe(`auth-magic-link:${snapshot?.token_id}`);
  });
  it("issues a durable local magic link without touching Scheduler", async () => {
    const email = `local-scheduler-${crypto.randomUUID()}@example.com`;
    let schedulerTouched = false;
    const scheduler = new Proxy(env.SCHEDULER, {
      get() {
        schedulerTouched = true;
        throw new Error("SCHEDULER must not be accessed in explicit local mode");
      },
    });
    const localEnv = new Proxy(env, {
      get(target, property, receiver) {
        if (property === "LOCAL_MODE") return "1";
        if (property === "SCHEDULER") return scheduler;
        return Reflect.get(target, property, receiver);
      },
      has(target, property) {
        return property === "LOCAL_MODE" || Reflect.has(target, property);
      },
    }) as Env;
    const response = await worker.fetch(
      new Request("https://example.test/api/v1/auth/request-link", {
        method: "POST",
        headers: {
          "cf-connecting-ip": "203.0.113.99",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email }),
      }),
      localEnv,
      createExecutionContext(),
    );

    expect(response.status).toBe(202);
    expect(schedulerTouched).toBe(false);
    const counts = await env.DB.prepare(
      `SELECT
        (SELECT count(*) FROM users WHERE email = ?) AS users_count,
        (SELECT count(*) FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = ? AND t.kind = 'magic_link' AND t.consumed_at IS NULL) AS token_count,
        (SELECT count(*) FROM mail_delivery_snapshots WHERE recipient_email = ? AND redacted_at IS NULL AND rendered_html IS NOT NULL AND rendered_text IS NOT NULL) AS snapshot_count,
        (SELECT count(*) FROM mail_deliveries d JOIN mail_delivery_snapshots s ON s.id = d.snapshot_id WHERE s.recipient_email = ? AND d.status = 'pending') AS delivery_count`,
    ).bind(email, email, email, email).first();
    expect(counts).toEqual({
      users_count: 1,
      token_count: 1,
      snapshot_count: 1,
      delivery_count: 1,
    });
  });
  it("repokes an outstanding delivery after the initial notification fails", async () => {
    const email = "repoke-existing@example.com";
    let failPoke = true;
    const schedulerNamespace = env.SCHEDULER;
    const schedulerNamespaceKey = crypto.randomUUID();
    let pokeAttempts = 0;
    const mailSchedulerId = schedulerNamespace.idFromName(
      `${schedulerNamespaceKey}:mail`,
    );
    const scheduler = {
      idFromName(name: string): DurableObjectId {
        return name === "mail"
          ? mailSchedulerId
          : schedulerNamespace.idFromName(name);
      },
      get(id: DurableObjectId) {
        if (id.toString() !== mailSchedulerId.toString()) {
          return schedulerNamespace.get(id);
        }
        return {
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(input, init);
            if (new URL(request.url).pathname !== "/poke") {
              return new Response("Not Found", { status: 404 });
            }
            pokeAttempts += 1;
            return failPoke
              ? new Response("forced initial poke failure", { status: 503 })
              : new Response(null, { status: 202 });
          },
        };
      },
    } as unknown as Env["SCHEDULER"];
    const wrappedEnv = new Proxy(nonLocalAuthEnv, {
      get(target, property, receiver) {
        return property === "SCHEDULER"
          ? scheduler
          : Reflect.get(target, property, receiver);
      },
    }) as Env;
    const request = (source: string) => worker.fetch(
      new Request("https://example.test/api/v1/auth/request-link", {
        method: "POST",
        headers: {
          "cf-connecting-ip": source,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email }),
      }),
      wrappedEnv,
      createExecutionContext(),
    );

    expect((await request("203.0.113.10")).status).toBe(202);
    expect(pokeAttempts).toBe(1);

    failPoke = false;
    expect((await request("203.0.113.11")).status).toBe(202);
    expect(pokeAttempts).toBe(2);
    const counts = await env.DB.prepare(
      `SELECT
        (SELECT count(*) FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = ? AND t.kind = 'magic_link' AND t.consumed_at IS NULL) AS token_count,
        (SELECT count(*) FROM mail_delivery_snapshots WHERE recipient_email = ?) AS snapshot_count,
        (SELECT count(*) FROM mail_deliveries d JOIN mail_delivery_snapshots s ON s.id = d.snapshot_id WHERE s.recipient_email = ?) AS delivery_count`,
    ).bind(email, email, email).first();
    expect(counts).toEqual({
      token_count: 1,
      snapshot_count: 1,
      delivery_count: 1,
    });
  });

  it("never mutates an existing profile from an unauthenticated link request", async () => {
    const now = Date.now();
    const email = "protected-profile@example.com";
    await env.DB.prepare(
      "INSERT INTO users (id, email, name, version, created_at, updated_at) VALUES ('protected-profile-user', ?, 'Protected Name', 1, ?, ?)",
    ).bind(email, now, now).run();
    expect((await requestLink(email, "Attacker Name")).status).toBe(202);
    expect(await env.DB.prepare(
      "SELECT name, updated_at FROM users WHERE id = 'protected-profile-user'",
    ).first()).toEqual({ name: "Protected Name", updated_at: now });
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
  it("enforces per-source and per-recipient limits before durable writes", async () => {
    const source = "198.51.100.44";
    for (let index = 0; index < 10; index += 1) {
      expect((await requestNonLocalLink(`source-limit-${index}@example.com`, source)).status).toBe(202);
    }
    const rejectedEmail = "source-limit-rejected@example.com";
    expect((await requestNonLocalLink(rejectedEmail, source)).status).toBe(202);
    expect(await env.DB.prepare(
      `SELECT
        (SELECT count(*) FROM users WHERE email = ?) AS users_count,
        (SELECT count(*) FROM mail_delivery_snapshots WHERE recipient_email = ?) AS snapshot_count`,
    ).bind(rejectedEmail, rejectedEmail).first()).toEqual({
      users_count: 0,
      snapshot_count: 0,
    });

    const recipient = "recipient-limit@example.com";
    for (let index = 0; index < 5; index += 1) {
      expect((await requestNonLocalLink(recipient)).status).toBe(202);
    }
    const mailStub = env.SCHEDULER.get(env.SCHEDULER.idFromName("mail"));
    await runDurableObjectAlarm(mailStub);
    const delayedAlarm = Date.now() + 5 * 60_000;
    await runInDurableObject(mailStub, async (_instance, state) => {
      await state.storage.setAlarm(delayedAlarm);
    });
    const beforeRejected = await runInDurableObject(
      mailStub,
      async (_instance, state) => state.storage.getAlarm(),
    );
    expect(beforeRejected).not.toBeNull();
    expect((await requestNonLocalLink(recipient)).status).toBe(202);
    expect(await runInDurableObject(
      mailStub,
      async (_instance, state) => state.storage.getAlarm(),
    )).toBe(beforeRejected);
    expect(await env.DB.prepare(
      `SELECT
        (SELECT count(*) FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = ? AND t.kind = 'magic_link' AND t.consumed_at IS NULL) AS token_count,
        (SELECT count(*) FROM mail_delivery_snapshots WHERE recipient_email = ?) AS snapshot_count,
        (SELECT count(*) FROM mail_deliveries d JOIN mail_delivery_snapshots s ON s.id = d.snapshot_id WHERE s.recipient_email = ?) AS delivery_count`,
    ).bind(recipient, recipient, recipient).first()).toEqual({
      token_count: 1,
      snapshot_count: 1,
      delivery_count: 1,
    });
  });

  it("accepts exact request bounds and rejects each bound plus one", async () => {
    const exactEmail = `${"a".repeat(242)}@example.com`;
    const longEmail = `${"a".repeat(243)}@example.com`;
    expect(exactEmail).toHaveLength(254);
    expect(longEmail).toHaveLength(255);
    expect((await requestLink(exactEmail)).status).toBe(202);
    expect((await requestLink(longEmail)).status).toBe(400);

    const exactName = "n".repeat(120);
    const nameEmail = "exact-name@example.com";
    expect((await requestLink(nameEmail, exactName)).status).toBe(202);
    expect(await env.DB.prepare(
      "SELECT recipient_name FROM mail_delivery_snapshots WHERE recipient_email = ?",
    ).bind(nameEmail).first()).toEqual({ recipient_name: exactName });
    const longNameEmail = "long-name@example.com";
    expect((await requestLink(longNameEmail, `${exactName}n`)).status).toBe(400);

    const bodyEmail = "exact-body@example.com";
    const bodyJson = JSON.stringify({ email: bodyEmail });
    const exactBody = bodyJson + " ".repeat(1_024 - bodyJson.length);
    expect(new TextEncoder().encode(exactBody)).toHaveLength(1_024);
    expect((await requestLinkBody(exactBody)).status).toBe(202);
    const overBodyEmail = "over-body@example.com";
    const overBodyJson = JSON.stringify({ email: overBodyEmail });
    const overBody = overBodyJson + " ".repeat(1_025 - overBodyJson.length);
    expect(new TextEncoder().encode(overBody)).toHaveLength(1_025);
    expect((await requestLinkBody(overBody)).status).toBe(400);
    expect(await env.DB.prepare(
      `SELECT
        (SELECT count(*) FROM users WHERE email = ?) AS long_email_users,
        (SELECT count(*) FROM users WHERE email = ?) AS long_name_users,
        (SELECT count(*) FROM users WHERE email = ?) AS over_body_users`,
    ).bind(longEmail, longNameEmail, overBodyEmail).first()).toEqual({
      long_email_users: 0,
      long_name_users: 0,
      over_body_users: 0,
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
  it("carries only same-origin return paths through magic-link verification", async () => {
    const validEmail = `return-to-valid-${crypto.randomUUID()}@example.com`;
    const returnTo = "/events?scope=mine#upcoming";
    expect((await requestLink(validEmail, undefined, undefined, returnTo)).status).toBe(202);
    const validLink = await magicLinkFor(validEmail);
    expect(new URL(validLink).searchParams.get("returnTo")).toBe(returnTo);
    const validResponse = await SELF.fetch(validLink, { redirect: "manual" });
    expect(validResponse.status).toBe(302);
    expect(validResponse.headers.get("location")).toBe(returnTo);

    const hostileEmail = `return-to-hostile-${crypto.randomUUID()}@example.com`;
    expect((await requestLink(
      hostileEmail,
      undefined,
      undefined,
      "//attacker.example/collect",
    )).status).toBe(202);
    const hostileLink = new URL(await magicLinkFor(hostileEmail));
    expect(hostileLink.searchParams.get("returnTo")).toBe("/");
    hostileLink.searchParams.set("returnTo", "https://attacker.example/collect");
    const hostileResponse = await SELF.fetch(hostileLink, { redirect: "manual" });
    expect(hostileResponse.status).toBe(302);
    expect(hostileResponse.headers.get("location")).toBe("/");

    const normalizedHostileEmail = `return-to-normalized-hostile-${crypto.randomUUID()}@example.com`;
    expect((await requestLink(normalizedHostileEmail)).status).toBe(202);
    const normalizedHostileLink = new URL(await magicLinkFor(normalizedHostileEmail));
    normalizedHostileLink.searchParams.set("returnTo", "/..//attacker.example/collect");
    const normalizedHostileResponse = await SELF.fetch(normalizedHostileLink, {
      redirect: "manual",
    });
    expect(normalizedHostileResponse.status).toBe(302);
    expect(normalizedHostileResponse.headers.get("location")).toBe("/");
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
    const localCookie = responses.find(({ status }) => status === 302)?.headers.get("set-cookie");
    expect(localCookie).toContain("HttpOnly");
    expect(localCookie).not.toContain("Secure");

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
      text: "Stable",
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
    expect(first.providerResult.outboundCorrelationId).toBe(second.providerResult.outboundCorrelationId);
    expect(first.providerResult.outboundCorrelationId).toMatch(/^sp-[a-f0-9]{64}$/);
    expect(first.providerResult.outboundCorrelationId).not.toContain(payload.idempotencyKey);
  });
  it("forces deterministic local secrets and fake mail despite production-looking secrets", async () => {
    const localEnv = Object.assign(Object.create(env), {
      LOCAL_MODE: "1",
      SESSION_SECRET: "must-not-win",
      EMAIL: { send: async () => { throw new Error("local fake attempted egress"); } },
      MAIL_FROM: "must-not-win@example.com",
    }) as Env & {
      LOCAL_MODE: string;
      SESSION_SECRET: string;
    };
    expect(isExplicitLocalEnvironment(localEnv)).toBe(true);
    expect(sessionSecret(localEnv)).toBe("explicit-local-only-session-secret-v1");
    expect(mailFrom(localEnv)).toBe("Session Party <welcome@sessionparty.com>");
    expect((await sendMail(localEnv, {
      fromEmail: mailFrom(localEnv),
      to: "sensitive-recipient@example.com",
      subject: "Sensitive subject",
      html: "<p>Sensitive body</p>",
      text: "Sensitive body",
      idempotencyKey: "local-no-egress",
    })).provider).toBe("local-fake");
  });
  it("uses fake external services in preview while requiring an explicit session secret", async () => {
    const previewEnv = {
      PREVIEW_MODE: "1",
      SESSION_SECRET: "preview-session-secret",
      APP_URL: "https://session-party-pr-42.example.workers.dev",
    } as unknown as Env;

    expect(isExplicitPreviewEnvironment(previewEnv)).toBe(true);
    expect(isExplicitLocalEnvironment(previewEnv)).toBe(false);
    expect(sessionSecret(previewEnv)).toBe("preview-session-secret");
    expect(mailFrom(previewEnv)).toBe("Session Party <welcome@sessionparty.com>");
    expect((await sendMail(previewEnv, {
      fromEmail: mailFrom(previewEnv),
      to: "reviewer@example.com",
      subject: "Preview delivery",
      html: "<p>Preview</p>",
      text: "Preview",
      idempotencyKey: "preview-delivery",
    })).provider).toBe("local-fake");
  });
  it.each([
    ["production HTTPS", " https://SessionParty.EXAMPLE:443/ ", "https://sessionparty.example"],
    ["local HTTP", " http://LOCALHOST:5173 ", "http://localhost:5173"],
  ] as const)("exposes a canonical app origin for %s", async (_kind, configured, expected) => {
    const configuredEnv = Object.assign(Object.create(env), { APP_URL: configured }) as Env;
    const origin = await Effect.runPromise(
      Effect.gen(function* () {
        const queue = yield* MailQueue;
        return queue.appOrigin;
      }).pipe(Effect.provide(AppLayer(configuredEnv))),
    );
    expect(origin).toBe(expected);
    expect(new URL("/api/v1/test", origin).toString()).toBe(`${expected}/api/v1/test`);
  });
  it.each([
    ["missing", "   ", "Missing required binding: APP_URL"],
    ["malformed", "https://[", "Invalid required binding APP_URL: expected an absolute URL"],
    ["relative", "/events", "Invalid required binding APP_URL: expected an absolute URL"],
    ["scheme-relative", "//example.com", "Invalid required binding APP_URL: expected an absolute URL"],
    ["non-HTTP", "ftp://example.com", "Invalid required binding APP_URL: expected HTTP or HTTPS"],
    ["credentials", "https://user:password@example.com", "Invalid required binding APP_URL: credentials are not allowed"],
    ["path", "https://example.com/events", "Invalid required binding APP_URL: pathname must be empty or /"],
    ["query", "https://example.com?campaign=launch", "Invalid required binding APP_URL: query is not allowed"],
    ["hash", "https://example.com#agenda", "Invalid required binding APP_URL: hash is not allowed"],
  ] as const)("rejects an APP_URL with %s", (_kind, configured, message) => {
    const configuredEnv = Object.assign(Object.create(env), { APP_URL: configured }) as Env;
    expect(() => AppLayer(configuredEnv)).toThrowError(message);
  });

  it("provides the configured sender and wakes only the canonical mail scheduler", async () => {
    const configuredEnv = Object.assign(Object.create(env), {
      APP_URL: "http://localhost:5173",
    }) as Env;
    const sender = await Effect.runPromise(
      Effect.gen(function* () {
        const queue = yield* MailQueue;
        yield* queue.wake();
        return queue.fromEmail;
      }).pipe(Effect.provide(AppLayer(configuredEnv))),
    );
    expect(sender).toBe("Session Party <welcome@sessionparty.com>");
    const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName("mail"));
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get("mail-scheduler-enabled")).toBe(true);
    });
  });


  it("maps immutable content to Cloudflare Email with stable correlation metadata", async () => {
    const sent: EmailMessageBuilder[] = [];
    const productionEnv = Object.assign(Object.create(env), {
      LOCAL_MODE: undefined,
      EMAIL: {
        send: async (message: EmailMessageBuilder) => {
          sent.push(message);
          return { messageId: `cloudflare-${sent.length}` };
        },
      },
      MAIL_FROM: "Session Party <welcome@sessionparty.com>",
    }) as Env;
    const payload = {
      fromEmail: "Session Party <welcome@sessionparty.com>",
      replyToEmail: "organizer@example.com",
      to: "speaker@example.com",
      subject: "Session confirmed",
      html: "<p>Confirmed</p>",
      text: "Confirmed",
      icsFilename: "session.ics",
      ics: "BEGIN:VCALENDAR\nEND:VCALENDAR",
      idempotencyKey: "mail-delivery:stable",
    } as const;
    const first = await sendMail(productionEnv, payload);
    const second = await sendMail(productionEnv, payload);
    expect(first).toMatchObject({
      provider: "cloudflare-email",
      providerMessageId: "cloudflare-1",
    });
    expect(second.providerMessageId).toBe("cloudflare-2");
    expect(sent[0]).toMatchObject({
      from: payload.fromEmail,
      replyTo: payload.replyToEmail,
      to: payload.to,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
      attachments: [{
        disposition: "attachment",
        filename: payload.icsFilename,
        type: "text/calendar; charset=utf-8; method=REQUEST",
        content: btoa(payload.ics),
      }],
    });
    expect(sent[0]?.headers?.["Message-ID"]).toBeUndefined();
    expect(sent[0]?.headers?.["X-Session-Party-Delivery-ID"]).toBe(
      sent[1]?.headers?.["X-Session-Party-Delivery-ID"],
    );
    expect(first.providerResult.outboundCorrelationId).toBe(
      sent[0]?.headers?.["X-Session-Party-Delivery-ID"],
    );
    expect(first.providerResult.outboundCorrelationId).not.toContain(payload.idempotencyKey);
  });
  it("fails production secrets closed, hides local smoke, and sets Secure cookies", async () => {
    const productionMissing = Object.assign(Object.create(env), {
      LOCAL_MODE: undefined,
      SESSION_SECRET: undefined,
      EMAIL: undefined,
      MAIL_FROM: "Session Party <mail@example.com>",
    }) as Env;
    expect(isExplicitLocalEnvironment(productionMissing)).toBe(false);
    expect(() => sessionSecret(productionMissing)).toThrow(/SESSION_SECRET/);
    expect(() => requireMailConfiguration(productionMissing)).toThrow(/EMAIL/);
    const smokeContext = createExecutionContext();
    const smoke = await worker.fetch(
      new Request("https://example.test/__local/smoke", { method: "POST" }),
      productionMissing,
      smokeContext,
    );
    expect(smoke.status).toBe(404);

    const productionEnv = Object.assign(Object.create(env), {
      LOCAL_MODE: undefined,
      SESSION_SECRET: "production-cookie-test-secret",
      EMAIL: { send: async () => ({ messageId: "production-test" }) },
      MAIL_FROM: "Session Party <mail@example.com>",
    }) as Env;
    const rawToken = "production-secure-cookie-token";
    const now = Date.now();
    const tokenHash = await hashBearerMaterial(productionEnv, rawToken);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users (id, email, name, version, created_at, updated_at) VALUES ('production-cookie-user', 'production-cookie@example.com', 'Production Cookie', 1, ?, ?)",
      ).bind(now, now),
      env.DB.prepare(
        "INSERT INTO auth_tokens (id, token_hash, user_id, kind, expires_at, consumed_at, created_at) VALUES ('production-cookie-magic', ?, 'production-cookie-user', 'magic_link', ?, NULL, ?)",
      ).bind(tokenHash, now + 60_000, now),
    ]);
    const verifyContext = createExecutionContext();
    const verified = await worker.fetch(
      new Request(`https://example.test/api/v1/auth/verify?token=${rawToken}`),
      productionEnv,
      verifyContext,
    );
    expect(verified.status).toBe(302);
    expect(verified.headers.get("set-cookie")).toContain("Secure");
  });
});
