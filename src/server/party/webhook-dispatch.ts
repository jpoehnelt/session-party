import { domainChanges, webhookDeliveries, webhookEndpoints } from "contracts/schema";
import { and, asc, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";

const ENQUEUE_BATCH = 100;
const DRAIN_BATCH = 50;
const DISPATCH_CONCURRENCY = 5;
const ATTEMPT_TIMEOUT_MS = 10_000;
const LEASE_MS = 5 * 60_000;
const RETRY_BASE_DELAY_MS = 60_000;
const RETRY_MAX_DELAY_MS = 60 * 60_000;

/**
 * Exponential backoff with deterministic per-delivery jitter of up to +25%,
 * derived from the delivery id and attempt number so schedules stay
 * reproducible in tests while a batch of simultaneous failures spreads out.
 */
export const webhookRetryDelayMs = (deliveryId: string, attemptCount: number): number => {
  const exponential = Math.min(
    RETRY_MAX_DELAY_MS,
    RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attemptCount - 1),
  );
  const source = `${deliveryId}:${attemptCount}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return exponential + ((hash >>> 0) % (Math.floor(exponential / 4) + 1));
};

/**
 * Kinds are dotted prefixes matched per segment: "review" matches
 * "review.decision.staged" but never "reviewers.added". "*" matches all.
 */
export const webhookKindMatches = (kinds: readonly string[], eventType: string): boolean =>
  kinds.some((kind) => kind === "*" || eventType === kind || eventType.startsWith(`${kind}.`));

const bytesToHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * v1 signature: HMAC-SHA256 over "<unix-seconds>.<body>". The timestamp is
 * part of the signed message so a captured request cannot be replayed later
 * by a receiver that enforces a tolerance window.
 */
export const webhookSignature = async (
  signingSecret: string,
  timestampSeconds: number,
  body: string,
): Promise<string> => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestampSeconds}.${body}`)));
};

const boundedPool = async <A>(
  values: readonly A[],
  concurrency: number,
  run: (value: A) => Promise<void>,
): Promise<void> => {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      await run(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
};

/**
 * Materializes deliveries by advancing each active endpoint's cursor over the
 * append-only domain change log. The delivery body is a notification, not a
 * payload: it carries change identity and ordering metadata, and the receiver
 * fetches canonical state through the API with its own credentials — so
 * privacy projection stays implemented exactly once.
 */
export const enqueueWebhookDeliveries = async (
  db: DrizzleD1Database,
  now: Date,
): Promise<number> => {
  const endpoints = await db.select().from(webhookEndpoints)
    .where(eq(webhookEndpoints.status, "active"));
  let enqueued = 0;
  for (const endpoint of endpoints) {
    const changes = await db
      .select({
        sequence: domainChanges.sequence,
        id: domainChanges.id,
        aggregateType: domainChanges.aggregateType,
        aggregateId: domainChanges.aggregateId,
        aggregateVersion: domainChanges.aggregateVersion,
        eventType: domainChanges.eventType,
        occurredAt: domainChanges.occurredAt,
      })
      .from(domainChanges)
      .where(and(
        eq(domainChanges.eventId, endpoint.eventId),
        gt(domainChanges.sequence, endpoint.cursorSequence),
      ))
      .orderBy(asc(domainChanges.sequence))
      .limit(ENQUEUE_BATCH);
    if (changes.length === 0) continue;
    const tail = changes[changes.length - 1]!.sequence;
    const matching = changes.filter((change) => webhookKindMatches(endpoint.kinds, change.eventType));
    await db.batch([
      // The cursor advance is compare-and-swapped so two overlapping passes
      // cannot both claim the same window; the idempotency-keyed inserts make
      // any raced duplicates a no-op rather than a double delivery.
      db.update(webhookEndpoints)
        .set({ cursorSequence: tail, updatedAt: now })
        .where(and(
          eq(webhookEndpoints.id, endpoint.id),
          eq(webhookEndpoints.cursorSequence, endpoint.cursorSequence),
        )),
      ...matching.map((change) =>
        db.insert(webhookDeliveries).values({
          id: `webhook_delivery_${nanoid()}`,
          endpointId: endpoint.id,
          eventId: endpoint.eventId,
          changeSequence: change.sequence,
          eventType: change.eventType,
          body: JSON.stringify({
            webhookId: endpoint.id,
            eventId: endpoint.eventId,
            kind: change.eventType,
            change: {
              sequence: change.sequence,
              id: change.id,
              aggregateType: change.aggregateType,
              aggregateId: change.aggregateId,
              aggregateVersion: change.aggregateVersion,
              occurredAt: change.occurredAt.getTime(),
            },
          }),
          idempotencyKey: `${endpoint.id}:${change.sequence}`,
          status: "pending",
          attemptCount: 0,
          maxAttempts: 8,
          availableAt: now,
          createdAt: now,
          updatedAt: now,
        }).onConflictDoNothing(),
      ),
    ]);
    enqueued += matching.length;
  }
  return enqueued;
};

export interface WebhookDrainOptions {
  readonly now: Date;
  readonly leaseOwner: string;
  /** Local and preview environments record deliveries without network egress. */
  readonly fake: boolean;
  readonly fetcher?: typeof fetch;
}

export const drainWebhookDeliveries = async (
  db: DrizzleD1Database,
  options: WebhookDrainOptions,
): Promise<void> => {
  const { now, leaseOwner, fake } = options;
  const due = await db
    .select({ delivery: webhookDeliveries, endpoint: webhookEndpoints })
    .from(webhookDeliveries)
    .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
    .where(and(
      inArray(webhookDeliveries.status, ["pending", "retry"]),
      lte(webhookDeliveries.availableAt, now),
      lt(webhookDeliveries.attemptCount, webhookDeliveries.maxAttempts),
      or(isNull(webhookDeliveries.leaseExpiresAt), lte(webhookDeliveries.leaseExpiresAt, now)),
      // A paused endpoint holds its queue rather than dead-lettering it.
      eq(webhookEndpoints.status, "active"),
    ))
    .orderBy(asc(webhookDeliveries.availableAt))
    .limit(DRAIN_BATCH);

  await boundedPool(due, DISPATCH_CONCURRENCY, async ({ delivery, endpoint }) => {
    const [claim] = await db.update(webhookDeliveries)
      .set({
        leaseOwner,
        leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        attemptCount: sql`${webhookDeliveries.attemptCount} + 1`,
        updatedAt: now,
      })
      .where(and(
        eq(webhookDeliveries.id, delivery.id),
        inArray(webhookDeliveries.status, ["pending", "retry"]),
        lt(webhookDeliveries.attemptCount, webhookDeliveries.maxAttempts),
        or(isNull(webhookDeliveries.leaseExpiresAt), lte(webhookDeliveries.leaseExpiresAt, now)),
      ))
      .returning({ attemptCount: webhookDeliveries.attemptCount, maxAttempts: webhookDeliveries.maxAttempts });
    if (!claim) return;

    let delivered = false;
    let responseStatus: number | null = null;
    let lastError: string | null = null;
    if (fake) {
      delivered = true;
      responseStatus = 200;
    } else {
      try {
        const timestampSeconds = Math.floor(now.getTime() / 1000);
        const signature = await webhookSignature(endpoint.signingSecret, timestampSeconds, delivery.body);
        const response = await (options.fetcher ?? fetch)(endpoint.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "SessionParty-Webhooks/1",
            "SP-Webhook-Id": endpoint.id,
            "SP-Delivery-Id": delivery.id,
            "SP-Event-Kind": delivery.eventType,
            "SP-Signature": `t=${timestampSeconds},v1=${signature}`,
          },
          body: delivery.body,
          signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
        });
        responseStatus = response.status;
        delivered = response.ok;
        if (!delivered) lastError = `Endpoint responded ${response.status}`;
        await response.body?.cancel().catch(() => undefined);
      } catch (error) {
        lastError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      }
    }

    const completedAt = new Date();
    if (delivered) {
      await db.update(webhookDeliveries)
        .set({
          status: "delivered",
          deliveredAt: completedAt,
          responseStatus,
          lastError: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: completedAt,
        })
        .where(and(eq(webhookDeliveries.id, delivery.id), eq(webhookDeliveries.leaseOwner, leaseOwner)));
      return;
    }
    const terminal = claim.attemptCount >= claim.maxAttempts;
    await db.update(webhookDeliveries)
      .set({
        status: terminal ? "dead_letter" : "retry",
        availableAt: terminal
          ? completedAt
          : new Date(completedAt.getTime() + webhookRetryDelayMs(delivery.id, claim.attemptCount)),
        responseStatus,
        lastError,
        deadLetteredAt: terminal ? completedAt : null,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: completedAt,
      })
      .where(and(eq(webhookDeliveries.id, delivery.id), eq(webhookDeliveries.leaseOwner, leaseOwner)));
  });
};
