import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import type { AppError } from "contracts/errors";
import type { BrowserSessionPrincipal } from "contracts/principal";
import { domainChanges, eventMembers, events, users, webhookDeliveries, webhookEndpoints } from "contracts/schema";
import { drizzle } from "drizzle-orm/d1";
import { and, asc, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type Authorizer,
  type CurrentUser,
  AppLayer,
  CurrentUser as CurrentUserTag,
  type Db,
} from "@/server/services";
import {
  drainWebhookDeliveries,
  enqueueWebhookDeliveries,
  webhookKindMatches,
  webhookRetryDelayMs,
  webhookSignature,
} from "@/server/party/webhook-dispatch";
import {
  createWebhook,
  deleteWebhook,
  listWebhookDeliveries,
  listWebhooks,
  redeliverWebhook,
  updateWebhook,
  validateWebhookUrl,
} from "./webhooks";

interface TestEnv extends Cloudflare.Env {
  readonly TEST_MIGRATIONS: readonly D1Migration[];
}

const expiresAt = Date.UTC(2100, 0, 1);
const eventId = "webhooks-event-target";
const eventSlug = "webhooks-target-slug";

const principal = (userId: string, name: string): BrowserSessionPrincipal => ({
  kind: "browser-session",
  userId,
  email: `${userId}@example.com`,
  name,
  sessionId: `session-${userId}`,
  expiresAt,
});

const owner = principal("webhooks-owner", "Owner");
const reviewer = principal("webhooks-reviewer", "Reviewer");

type Requirements = Authorizer | CurrentUser | Db;

const runEitherAs = <A>(
  actor: BrowserSessionPrincipal,
  effect: Effect.Effect<A, AppError, Requirements>,
) =>
  Effect.runPromise(effect.pipe(
    Effect.either,
    Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUserTag, actor))),
  ));

const runAs = async <A>(
  actor: BrowserSessionPrincipal,
  effect: Effect.Effect<A, AppError, Requirements>,
): Promise<A> => {
  const result = await runEitherAs(actor, effect);
  if (result._tag === "Left") throw new Error(`Unexpected Effect failure: ${JSON.stringify(result.left)}`);
  return result.right;
};

const db = drizzle(env.DB);
let changeCounter = 0;

const insertChange = async (eventType: string): Promise<void> => {
  changeCounter += 1;
  await db.insert(domainChanges).values({
    id: `webhooks-change-${changeCounter}`,
    eventId,
    aggregateType: "webhookTestAggregate",
    aggregateId: `aggregate-${changeCounter}`,
    aggregateVersion: 1,
    eventType,
    audiences: [{ kind: "admins" }],
    payload: { counter: changeCounter },
    actorUserId: owner.userId,
    actorApiKeyId: null,
    requestId: `webhooks-test-${changeCounter}`,
    occurredAt: new Date(),
  }).run();
};

beforeAll(async () => {
  if (!("TEST_MIGRATIONS" in env)) throw new Error("TEST_MIGRATIONS test binding is unavailable");
  await applyD1Migrations(env.DB, [...(env as TestEnv).TEST_MIGRATIONS]);
  const now = new Date();
  await db.insert(users).values([owner, reviewer].map((actor) => ({
    id: actor.userId,
    email: actor.email,
    name: actor.name,
    createdAt: now,
    updatedAt: now,
  }))).onConflictDoNothing().run();
  await db.insert(events).values({
    id: eventId,
    slug: eventSlug,
    name: "Webhooks target",
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing().run();
  await db.insert(eventMembers).values([
    { id: "webhooks-member-owner", eventId, userId: owner.userId, role: "owner", createdAt: now, updatedAt: now },
    { id: "webhooks-member-reviewer", eventId, userId: reviewer.userId, role: "reviewer", createdAt: now, updatedAt: now },
  ]).onConflictDoNothing().run();
});

describe("webhook building blocks", () => {
  it("accepts only public https targets", () => {
    expect(validateWebhookUrl("https://hooks.example.com/session-party")).not.toBeNull();
    expect(validateWebhookUrl("http://hooks.example.com/x")).toBeNull();
    expect(validateWebhookUrl("https://user:pass@hooks.example.com/x")).toBeNull();
    expect(validateWebhookUrl("https://localhost/x")).toBeNull();
    expect(validateWebhookUrl("https://gateway.internal/x")).toBeNull();
    expect(validateWebhookUrl("https://printer.local/x")).toBeNull();
    expect(validateWebhookUrl("https://10.0.0.8/x")).toBeNull();
    expect(validateWebhookUrl("https://172.20.1.1/x")).toBeNull();
    expect(validateWebhookUrl("https://192.168.1.1/x")).toBeNull();
    expect(validateWebhookUrl("https://169.254.1.1/x")).toBeNull();
    expect(validateWebhookUrl("https://127.0.0.1/x")).toBeNull();
    expect(validateWebhookUrl("https://[::1]/x")).toBeNull();
    expect(validateWebhookUrl("https://[fd00::1]/x")).toBeNull();
    expect(validateWebhookUrl(`https://hooks.example.com/${"a".repeat(2_100)}`)).toBeNull();
    expect(validateWebhookUrl("https://8.8.8.8/x")).not.toBeNull();
  });

  it("matches kinds per dotted segment", () => {
    expect(webhookKindMatches(["*"], "anything.at.all")).toBe(true);
    expect(webhookKindMatches(["review"], "review.decision.staged")).toBe(true);
    expect(webhookKindMatches(["review"], "review")).toBe(true);
    expect(webhookKindMatches(["review"], "reviewers.added")).toBe(false);
    expect(webhookKindMatches(["review.decision"], "review.decision.staged")).toBe(true);
    expect(webhookKindMatches(["review.decision"], "review.round.created")).toBe(false);
    expect(webhookKindMatches(["agenda", "comms"], "comms.template.created")).toBe(true);
  });

  it("signs the timestamped body with a stable, verifiable HMAC", async () => {
    const signature = await webhookSignature("whsec_testvector", 1_700_000_000, '{"kind":"agenda.published"}');
    expect(signature).toBe("6aa119616da1ad499f21e1b39d4290be58db311d03e4d8543e2d98e792ed8f44");
    const differentBody = await webhookSignature("whsec_testvector", 1_700_000_000, '{"kind":"agenda.retracted"}');
    expect(differentBody).not.toBe(signature);
    const differentTimestamp = await webhookSignature("whsec_testvector", 1_700_000_001, '{"kind":"agenda.published"}');
    expect(differentTimestamp).not.toBe(signature);
  });

  it("backs off exponentially with bounded deterministic jitter", () => {
    const first = webhookRetryDelayMs("delivery-x", 1);
    expect(first).toBeGreaterThanOrEqual(60_000);
    expect(first).toBeLessThanOrEqual(75_000);
    expect(webhookRetryDelayMs("delivery-x", 3)).toBe(webhookRetryDelayMs("delivery-x", 3));
    const seventh = webhookRetryDelayMs("delivery-x", 7);
    expect(seventh).toBeGreaterThanOrEqual(3_600_000);
    expect(seventh).toBeLessThanOrEqual(4_500_000);
  });
});

describe("webhook endpoint lifecycle", () => {
  it("creates, lists, updates, rotates, and deletes under optimistic concurrency", async () => {
    const created = await runAs(owner, createWebhook({
      idOrSlug: eventSlug,
      url: "https://hooks.example.com/lifecycle",
      description: "Lifecycle test",
      kinds: ["review", "agenda"],
      idempotencyKey: "webhooks-lifecycle-create-001",
    }));
    expect(created.signingSecret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(created.webhook.status).toBe("active");
    expect(created.replayed).toBe(false);

    const replayed = await runAs(owner, createWebhook({
      idOrSlug: eventSlug,
      url: "https://hooks.example.com/lifecycle",
      description: "Lifecycle test",
      kinds: ["review", "agenda"],
      idempotencyKey: "webhooks-lifecycle-create-001",
    }));
    expect(replayed.replayed).toBe(true);
    expect(replayed.signingSecret).toBe("");

    const duplicate = await runEitherAs(owner, createWebhook({
      idOrSlug: eventSlug,
      url: "https://hooks.example.com/lifecycle",
      kinds: ["*"],
      idempotencyKey: "webhooks-lifecycle-create-002",
    }));
    expect(duplicate._tag).toBe("Left");
    if (duplicate._tag === "Left") expect(duplicate.left._tag).toBe("Conflict");

    const invalidUrl = await runEitherAs(owner, createWebhook({
      idOrSlug: eventSlug,
      url: "https://192.168.0.20/hook",
      kinds: ["*"],
      idempotencyKey: "webhooks-lifecycle-create-003",
    }));
    expect(invalidUrl._tag).toBe("Left");
    if (invalidUrl._tag === "Left") expect(invalidUrl.left._tag).toBe("Validation");

    const forbidden = await runEitherAs(reviewer, createWebhook({
      idOrSlug: eventSlug,
      url: "https://hooks.example.com/forbidden",
      kinds: ["*"],
      idempotencyKey: "webhooks-lifecycle-create-004",
    }));
    expect(forbidden._tag).toBe("Left");
    if (forbidden._tag === "Left") expect(forbidden.left._tag).toBe("Forbidden");

    const listed = await runAs(owner, listWebhooks(eventSlug));
    const listedEndpoint = listed.webhooks.find((webhook) => webhook.id === created.webhook.id);
    expect(listedEndpoint).toMatchObject({ url: "https://hooks.example.com/lifecycle", deadLetterCount: 0 });

    const paused = await runAs(owner, updateWebhook({
      idOrSlug: eventSlug,
      webhookId: created.webhook.id,
      expectedVersion: 1,
      status: "paused",
      rotateSecret: true,
      idempotencyKey: "webhooks-lifecycle-update-001",
    }));
    expect(paused.webhook.status).toBe("paused");
    expect(paused.webhook.version).toBe(2);
    expect(paused.signingSecret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(paused.signingSecret).not.toBe(created.signingSecret);

    const staleVersion = await runEitherAs(owner, updateWebhook({
      idOrSlug: eventSlug,
      webhookId: created.webhook.id,
      expectedVersion: 1,
      status: "active",
      idempotencyKey: "webhooks-lifecycle-update-002",
    }));
    expect(staleVersion._tag).toBe("Left");
    if (staleVersion._tag === "Left") expect(staleVersion.left._tag).toBe("Conflict");

    const deleted = await runAs(owner, deleteWebhook({
      idOrSlug: eventSlug,
      webhookId: created.webhook.id,
      expectedVersion: 2,
      idempotencyKey: "webhooks-lifecycle-delete-001",
    }));
    expect(deleted.deleted).toBe(true);
    const [gone] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, created.webhook.id));
    expect(gone).toBeUndefined();
  });
});

describe("webhook dispatch", () => {
  it("advances cursors, filters kinds, enqueues once, and delivers with fake egress", async () => {
    const created = await runAs(owner, createWebhook({
      idOrSlug: eventSlug,
      url: "https://hooks.example.com/dispatch",
      kinds: ["review"],
      idempotencyKey: "webhooks-dispatch-create-001",
    }));
    await insertChange("review.decision.staged");
    await insertChange("comms.template.created");
    await insertChange("review.round.created");

    const now = new Date();
    const enqueued = await enqueueWebhookDeliveries(db, now);
    expect(enqueued).toBe(2);
    const rerun = await enqueueWebhookDeliveries(db, new Date());
    expect(rerun).toBe(0);

    const deliveries = await db.select().from(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, created.webhook.id))
      .orderBy(asc(webhookDeliveries.changeSequence));
    expect(deliveries).toHaveLength(2);
    expect(deliveries.map((delivery) => delivery.eventType)).toEqual([
      "review.decision.staged",
      "review.round.created",
    ]);
    const body = JSON.parse(deliveries[0]!.body) as { kind: string; change: { sequence: number } };
    expect(body.kind).toBe("review.decision.staged");
    expect(body.change.sequence).toBe(deliveries[0]!.changeSequence);

    await drainWebhookDeliveries(db, { now: new Date(), leaseOwner: "test-fake", fake: true });
    const drained = await db.select().from(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, created.webhook.id));
    expect(drained.every((delivery) => delivery.status === "delivered")).toBe(true);
    expect(drained.every((delivery) => delivery.responseStatus === 200)).toBe(true);
  });

  it("signs real attempts, retries with backoff, dead-letters, and redelivers", async () => {
    const created = await runAs(owner, createWebhook({
      idOrSlug: eventSlug,
      url: "https://hooks.example.com/failing",
      kinds: ["agenda"],
      idempotencyKey: "webhooks-dispatch-create-002",
    }));
    await insertChange("agenda.published");
    const now = new Date();
    await enqueueWebhookDeliveries(db, now);

    const requests: { url: string; headers: Record<string, string>; body: string }[] = [];
    const failingFetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: String(init?.body),
      });
      return new Response("upstream unavailable", { status: 503 });
    }) as typeof fetch;

    await drainWebhookDeliveries(db, { now: new Date(), leaseOwner: "test-real-1", fake: false, fetcher: failingFetcher });
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe("https://hooks.example.com/failing");
    expect(request.headers["sp-event-kind"]).toBe("agenda.published");
    const signatureHeader = request.headers["sp-signature"]!;
    const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(signatureHeader);
    expect(match).not.toBeNull();
    const expected = await webhookSignature(created.signingSecret, Number(match![1]), request.body);
    expect(match![2]).toBe(expected);

    const [failed] = await db.select().from(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, created.webhook.id));
    expect(failed).toMatchObject({ status: "retry", attemptCount: 1, responseStatus: 503 });
    expect(failed!.availableAt.getTime()).toBeGreaterThan(Date.now());

    // Exhaust the remaining attempts against a dead endpoint.
    await db.update(webhookDeliveries)
      .set({ attemptCount: 7, availableAt: new Date(0), leaseExpiresAt: null })
      .where(eq(webhookDeliveries.id, failed!.id));
    await drainWebhookDeliveries(db, { now: new Date(), leaseOwner: "test-real-2", fake: false, fetcher: failingFetcher });
    const [dead] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, failed!.id));
    expect(dead).toMatchObject({ status: "dead_letter", attemptCount: 8 });
    expect(dead!.deadLetteredAt).not.toBeNull();

    const redelivered = await runAs(owner, redeliverWebhook({
      idOrSlug: eventSlug,
      deliveryId: failed!.id,
      idempotencyKey: "webhooks-redeliver-001",
    }));
    expect(redelivered.status).toBe("pending");
    const [reset] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, failed!.id));
    expect(reset).toMatchObject({ status: "pending", attemptCount: 0, deadLetteredAt: null });

    await drainWebhookDeliveries(db, { now: new Date(), leaseOwner: "test-fake-2", fake: true });
    const [recovered] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, failed!.id));
    expect(recovered).toMatchObject({ status: "delivered", responseStatus: 200 });

    const history = await runAs(owner, listWebhookDeliveries({
      idOrSlug: eventSlug,
      webhookId: created.webhook.id,
    }));
    expect(history.deliveries).toHaveLength(1);
    expect(history.deliveries[0]).toMatchObject({ status: "delivered", canRedeliver: false });
  });

  it("holds the queue for paused endpoints instead of dead-lettering it", async () => {
    const created = await runAs(owner, createWebhook({
      idOrSlug: eventSlug,
      url: "https://hooks.example.com/paused",
      kinds: ["forms"],
      idempotencyKey: "webhooks-dispatch-create-003",
    }));
    await insertChange("forms.versionClaim");
    await enqueueWebhookDeliveries(db, new Date());
    await runAs(owner, updateWebhook({
      idOrSlug: eventSlug,
      webhookId: created.webhook.id,
      expectedVersion: 1,
      status: "paused",
      idempotencyKey: "webhooks-pause-001",
    }));

    await drainWebhookDeliveries(db, { now: new Date(), leaseOwner: "test-paused", fake: true });
    const held = await db.select().from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.endpointId, created.webhook.id), eq(webhookDeliveries.status, "pending")));
    expect(held).toHaveLength(1);

    await runAs(owner, updateWebhook({
      idOrSlug: eventSlug,
      webhookId: created.webhook.id,
      expectedVersion: 2,
      status: "active",
      idempotencyKey: "webhooks-resume-001",
    }));
    await drainWebhookDeliveries(db, { now: new Date(), leaseOwner: "test-resumed", fake: true });
    const [resumed] = await db.select().from(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, created.webhook.id));
    expect(resumed).toMatchObject({ status: "delivered" });
  });
});
