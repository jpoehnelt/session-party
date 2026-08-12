import {
  mailDeliveries,
  mailDeliveryAttempts,
  mailDeliverySnapshots,
} from "contracts/schema";
import { DurableObject } from "cloudflare:workers";
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { internalServiceToken, sendMail } from "../services";

const INTERVAL_MS = 60_000;
const LEASE_MS = 5 * 60_000;
const MAX_BATCH = 100;
export const MAIL_DISPATCH_CONCURRENCY = 5;
const MAIL_SNAPSHOT_RETENTION_MS = 90 * 24 * 60 * 60_000;
const AUTH_RATE_WINDOW_MS = 15 * 60_000;
const AUTH_RATE_GLOBAL_LIMIT = 100;
const AUTH_RATE_SOURCE_LIMIT = 10;
const AUTH_RATE_RECIPIENT_LIMIT = 5;
const AUTH_RATE_PREFIX = "auth-rate:";
const DEMO_RATE_WINDOW_MS = 15 * 60_000;
const DEMO_RATE_GLOBAL_LIMIT = 1_000;
export const DEMO_RATE_SOURCE_LIMIT = 30;
const DEMO_RATE_PREFIX = "demo-rate:";
const CFP_RATE_PREFIX = "cfp-rate:";
const CFP_RATE_SOURCE_LIMIT = 10;
const CFP_RATE_RECIPIENT_LIMIT = 3;

export const MAIL_SCHEDULER_NAME = "mail";
const MAIL_SCHEDULER_ENABLED_KEY = "mail-scheduler-enabled";

const setAlarmNoLaterThanInTransaction = async (
  transaction: DurableObjectTransaction,
  next: number,
): Promise<void> => {
  const current = await transaction.getAlarm();
  if (current === null || current > next) await transaction.setAlarm(next);
};

export const setSchedulerAlarmNoLaterThan = async (
  storage: DurableObjectStorage,
  next: number,
): Promise<void> => {
  await storage.transaction((transaction) =>
    setAlarmNoLaterThanInTransaction(transaction, next));
};

export const ACCOUNT_DAILY_EMAIL_LIMIT = 1_000;
export const ACCOUNT_DAILY_CAMPAIGN_LIMIT = 900;
export const EVENT_DAILY_EMAIL_LIMIT = 500;

export interface DispatchBudgetLimits {
  readonly total: number;
  readonly campaign: number;
  readonly event: number;
}

export type DispatchBudgetResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "account-limit" | "campaign-limit" | "event-limit" };

const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);
const nextUtcDay = (now: number): Date => {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next;
};

export const reserveDispatchBudget = async (
  storage: DurableObjectStorage,
  input: {
    readonly eventId: string | null;
    readonly now: number;
    readonly limits?: DispatchBudgetLimits;
  },
): Promise<DispatchBudgetResult> => {
  const limits = input.limits ?? {
    total: ACCOUNT_DAILY_EMAIL_LIMIT,
    campaign: ACCOUNT_DAILY_CAMPAIGN_LIMIT,
    event: EVENT_DAILY_EMAIL_LIMIT,
  };
  const day = utcDay(input.now);
  const prefix = `dispatch-budget:${day}:`;
  return storage.transaction(async (transaction) => {
    const totalKey = `${prefix}total`;
    const campaignKey = `${prefix}campaign`;
    const eventKey = input.eventId === null ? null : `${prefix}event:${input.eventId}`;
    const total = await transaction.get<number>(totalKey) ?? 0;
    if (total >= limits.total) return { ok: false, reason: "account-limit" };
    const campaign = input.eventId === null
      ? 0
      : await transaction.get<number>(campaignKey) ?? 0;
    if (input.eventId !== null && campaign >= limits.campaign) {
      return { ok: false, reason: "campaign-limit" };
    }
    const event = eventKey === null ? 0 : await transaction.get<number>(eventKey) ?? 0;
    if (eventKey !== null && event >= limits.event) {
      return { ok: false, reason: "event-limit" };
    }
    await transaction.put(totalKey, total + 1);
    if (input.eventId !== null) await transaction.put(campaignKey, campaign + 1);
    if (eventKey !== null) await transaction.put(eventKey, event + 1);
    return { ok: true };
  });
};

/** Run work in a small worker pool and wait for every started item to settle. */
export const processWithBoundedConcurrency = async <A>(
  values: readonly A[],
  concurrency: number,
  process: (value: A) => Promise<void>,
): Promise<void> => {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency must be a positive integer");
  }
  let cursor = 0;
  let firstError: unknown;
  const worker = async (): Promise<void> => {
    while (firstError === undefined) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      try {
        await process(values[index]!);
      } catch (error) {
        firstError = error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  if (firstError !== undefined) throw firstError;
};

const purgeDispatchBudgets = async (
  storage: DurableObjectStorage,
  now: number,
): Promise<void> => {
  const currentPrefix = `dispatch-budget:${utcDay(now)}:`;
  const entries = await storage.list({ prefix: "dispatch-budget:" });
  const stale = [...entries.keys()].filter((key) => !key.startsWith(currentPrefix));
  if (stale.length > 0) await storage.delete(stale);
};
type AuthRateCounter = {
  readonly windowStartedAt: number;
  readonly count: number;
};

type CfpRateCounter = {
  readonly expiresAt: number;
  readonly count: number;
};

const redactAuthSnapshot = async (
  db: DrizzleD1Database,
  snapshotId: string,
  idempotencyKey: string,
  redactedAt: Date,
): Promise<void> => {
  if (
    !idempotencyKey.startsWith("auth-magic-link:")
    && !idempotencyKey.startsWith("auth-reviewer-invitation:")
  ) return;
  try {
    await db
      .update(mailDeliverySnapshots)
      .set({
        renderedHtml: null,
        renderedText: null,
        icsFilename: null,
        icsContent: null,
        redactedAt,
      })
      .where(and(
        eq(mailDeliverySnapshots.id, snapshotId),
        isNull(mailDeliverySnapshots.redactedAt),
      ));
  } catch {
    // Delivery evidence is authoritative; the next alarm retries retention cleanup.
    console.error(JSON.stringify({
      message: "Auth mail snapshot redaction failed",
      snapshotId,
    }));
  }
};
export const authorizeMailDispatch = async (
  db: DrizzleD1Database,
  deliveryId: string,
  leaseOwner: string,
): Promise<boolean> => {
  const [authorized] = await db
    .update(mailDeliveries)
    .set({ status: "dispatching" })
    .where(and(
      eq(mailDeliveries.id, deliveryId),
      eq(mailDeliveries.status, "claimed"),
      eq(mailDeliveries.leaseOwner, leaseOwner),
      isNull(mailDeliveries.supersededAt),
    ))
    .returning({ id: mailDeliveries.id });
  if (authorized !== undefined) return true;
  await db
    .update(mailDeliveries)
    .set({ status: "cancelled", leaseOwner: null, leaseExpiresAt: null })
    .where(and(
      eq(mailDeliveries.id, deliveryId),
      eq(mailDeliveries.status, "claimed"),
      eq(mailDeliveries.leaseOwner, leaseOwner),
      isNotNull(mailDeliveries.supersededAt),
    ));
  return false;
};




export class Scheduler extends DurableObject<Env> {
  private isCanonicalMailScheduler(): boolean {
    return this.ctx.id.equals(this.env.SCHEDULER.idFromName(MAIL_SCHEDULER_NAME));
  }
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
    let secret: string;
    try {
      secret = await internalServiceToken(this.env);
    } catch {
      return new Response("Scheduler unavailable", { status: 503 });
    }
    if (request.headers.get("x-session-party-internal") !== secret) {
      return new Response("Forbidden", { status: 403 });
    }
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (url.pathname === "/poke") {
      if (!this.isCanonicalMailScheduler()) return new Response("Not found", { status: 404 });
      const next = Date.now() + 1;
      await this.ctx.storage.transaction(async (transaction) => {
        await transaction.put(MAIL_SCHEDULER_ENABLED_KEY, true);
        await setAlarmNoLaterThanInTransaction(transaction, next);
      });
      return Response.json({ ok: true });
    }
    if (url.pathname === "/auth/request-link/authorize") {
      const input = await request.json<unknown>().catch(() => null);
      if (
        typeof input !== "object"
        || input === null
        || !("sourceHash" in input)
        || !("recipientHash" in input)
        || typeof input.sourceHash !== "string"
        || typeof input.recipientHash !== "string"
        || !/^[a-f0-9]{64}$/.test(input.sourceHash)
        || !/^[a-f0-9]{64}$/.test(input.recipientHash)
      ) {
        return new Response("Invalid request", { status: 400 });
      }
      const allowed = await this.authorizeAuthRequest(input.sourceHash, input.recipientHash);
      return Response.json({ ok: allowed }, { status: allowed ? 200 : 429 });
    }
    if (url.pathname === "/auth/demo/authorize") {
      const input = await request.json<unknown>().catch(() => null);
      if (
        typeof input !== "object"
        || input === null
        || !("sourceHash" in input)
        || typeof input.sourceHash !== "string"
        || !/^[a-f0-9]{64}$/.test(input.sourceHash)
      ) {
        return new Response("Invalid request", { status: 400 });
      }
      const allowed = await this.authorizeDemoLogin(input.sourceHash);
      return Response.json({ ok: allowed }, { status: allowed ? 200 : 429 });
    }
    if (url.pathname === "/cfp/authorize") {
      const input = await request.json<unknown>().catch(() => null);
      if (
        typeof input !== "object"
        || input === null
        || !("sourceHash" in input)
        || !("recipientHash" in input)
        || !("eventId" in input)
        || !("formId" in input)
        || typeof input.sourceHash !== "string"
        || typeof input.recipientHash !== "string"
        || typeof input.eventId !== "string"
        || typeof input.formId !== "string"
        || !/^[a-f0-9]{64}$/.test(input.sourceHash)
        || !/^[a-f0-9]{64}$/.test(input.recipientHash)
        || !/^[A-Za-z0-9_-]{1,128}$/.test(input.eventId)
        || !/^[A-Za-z0-9_-]{1,128}$/.test(input.formId)
      ) {
        return new Response("Invalid request", { status: 400 });
      }
      const allowed = await this.authorizeCfpSubmission(input.sourceHash, input.recipientHash);
      return Response.json({ ok: allowed }, { status: allowed ? 200 : 429 });
    }
    return new Response("Not found", { status: 404 });
  }

  private async authorizeCfpSubmission(
    sourceHash: string,
    recipientHash: string,
  ): Promise<boolean> {
    const now = Date.now();
    const hourStartedAt = Math.floor(now / (60 * 60_000)) * 60 * 60_000;
    const hourExpiresAt = hourStartedAt + 60 * 60_000;
    const dayExpiresAt = nextUtcDay(now).getTime();
    const rules = [
      {
        key: `${CFP_RATE_PREFIX}source:${hourStartedAt}:${sourceHash}`,
        limit: CFP_RATE_SOURCE_LIMIT,
        expiresAt: hourExpiresAt,
      },
      {
        key: `${CFP_RATE_PREFIX}recipient:${utcDay(now)}:${recipientHash}`,
        limit: CFP_RATE_RECIPIENT_LIMIT,
        expiresAt: dayExpiresAt,
      },
    ] as const;
    const allowed = await this.ctx.storage.transaction(async (transaction) => {
      const next: Array<readonly [string, CfpRateCounter]> = [];
      for (const { key, limit, expiresAt } of rules) {
        const current = await transaction.get<CfpRateCounter>(key);
        const count = current && current.expiresAt > now ? current.count + 1 : 1;
        if (count > limit) return false;
        next.push([key, { count, expiresAt }]);
      }
      for (const [key, counter] of next) await transaction.put(key, counter);
      return true;
    });
    const cleanupAt = Math.min(hourExpiresAt, dayExpiresAt);
    const existingAlarm = await this.ctx.storage.getAlarm();
    if (existingAlarm === null || existingAlarm > cleanupAt) {
      await this.ctx.storage.setAlarm(cleanupAt);
    }
    return allowed;
  }

  private async authorizeAuthRequest(
    sourceHash: string,
    recipientHash: string,
  ): Promise<boolean> {
    const now = Date.now();
    const windowStartedAt = Math.floor(now / AUTH_RATE_WINDOW_MS) * AUTH_RATE_WINDOW_MS;
    const rules = [
      { key: `${AUTH_RATE_PREFIX}global`, limit: AUTH_RATE_GLOBAL_LIMIT },
      { key: `${AUTH_RATE_PREFIX}source:${sourceHash}`, limit: AUTH_RATE_SOURCE_LIMIT },
      { key: `${AUTH_RATE_PREFIX}recipient:${recipientHash}`, limit: AUTH_RATE_RECIPIENT_LIMIT },
    ] as const;
    const allowed = await this.ctx.storage.transaction(async (transaction) => {
      const next: Array<readonly [string, AuthRateCounter]> = [];
      for (const { key, limit } of rules) {
        const current = await transaction.get<AuthRateCounter>(key);
        const count = current?.windowStartedAt === windowStartedAt ? current.count + 1 : 1;
        if (count > limit) return false;
        next.push([key, { windowStartedAt, count }]);
      }
      for (const [key, counter] of next) await transaction.put(key, counter);
      return true;
    });
    const cleanupAt = now + AUTH_RATE_WINDOW_MS;
    const existingAlarm = await this.ctx.storage.getAlarm();
    if (existingAlarm === null || existingAlarm > cleanupAt) {
      await this.ctx.storage.setAlarm(cleanupAt);
    }
    return allowed;
  }

  private async authorizeDemoLogin(sourceHash: string): Promise<boolean> {
    const now = Date.now();
    const windowStartedAt = Math.floor(now / DEMO_RATE_WINDOW_MS) * DEMO_RATE_WINDOW_MS;
    const rules = [
      { key: `${DEMO_RATE_PREFIX}global`, limit: DEMO_RATE_GLOBAL_LIMIT },
      { key: `${DEMO_RATE_PREFIX}source:${sourceHash}`, limit: DEMO_RATE_SOURCE_LIMIT },
    ] as const;
    const allowed = await this.ctx.storage.transaction(async (transaction) => {
      const next: Array<readonly [string, AuthRateCounter]> = [];
      for (const { key, limit } of rules) {
        const current = await transaction.get<AuthRateCounter>(key);
        const count = current?.windowStartedAt === windowStartedAt ? current.count + 1 : 1;
        if (count > limit) return false;
        next.push([key, { windowStartedAt, count }]);
      }
      for (const [key, counter] of next) await transaction.put(key, counter);
      return true;
    });
    const cleanupAt = windowStartedAt + DEMO_RATE_WINDOW_MS;
    const existingAlarm = await this.ctx.storage.getAlarm();
    if (existingAlarm === null || existingAlarm > cleanupAt) {
      await this.ctx.storage.setAlarm(cleanupAt);
    }
    return allowed;
  }

  private async purgeAuthRateCounters(now: number): Promise<void> {
    const counters = await this.ctx.storage.list<AuthRateCounter>({ prefix: AUTH_RATE_PREFIX });
    const stale = [...counters]
      .filter(([, counter]) => counter.windowStartedAt + AUTH_RATE_WINDOW_MS <= now)
      .map(([key]) => key);
    if (stale.length > 0) await this.ctx.storage.delete(stale);
  }

  private async purgeDemoRateCounters(now: number): Promise<void> {
    const counters = await this.ctx.storage.list<AuthRateCounter>({ prefix: DEMO_RATE_PREFIX });
    const stale = [...counters]
      .filter(([, counter]) => counter.windowStartedAt + DEMO_RATE_WINDOW_MS <= now)
      .map(([key]) => key);
    if (stale.length > 0) await this.ctx.storage.delete(stale);
  }

  private async purgeCfpRateCounters(now: number): Promise<void> {
    const counters = await this.ctx.storage.list<CfpRateCounter>({ prefix: CFP_RATE_PREFIX });
    const stale = [...counters]
      .filter(([, counter]) => counter.expiresAt <= now)
      .map(([key]) => key);
    if (stale.length > 0) await this.ctx.storage.delete(stale);
  }

  override async alarm(): Promise<void> {
    let mailSchedulerEnabled = false;
    try {
      const now = new Date();
      const nowMs = now.getTime();
      await this.purgeAuthRateCounters(nowMs);
      await this.purgeDemoRateCounters(nowMs);
      await this.purgeCfpRateCounters(nowMs);
      mailSchedulerEnabled = this.isCanonicalMailScheduler()
        && await this.ctx.storage.get<boolean>(MAIL_SCHEDULER_ENABLED_KEY) === true;
      if (!mailSchedulerEnabled) return;
      const db = drizzle(this.env.DB);
      await purgeDispatchBudgets(this.ctx.storage, nowMs);
      await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE mail_deliveries
           SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL
           WHERE idempotency_key LIKE 'auth-magic-link:%'
             AND (
               status IN ('pending', 'retry')
               OR (status = 'claimed' AND lease_expires_at <= ?)
             )
             AND EXISTS (
               SELECT 1 FROM auth_tokens
               WHERE id = substr(mail_deliveries.idempotency_key, length('auth-magic-link:') + 1)
                 AND (consumed_at IS NOT NULL OR expires_at <= ?)
             )`,
        ).bind(nowMs, nowMs),
        this.env.DB.prepare(
          `UPDATE mail_delivery_snapshots
           SET rendered_html = NULL, rendered_text = NULL, ics_filename = NULL, ics_content = NULL, redacted_at = ?
           WHERE redacted_at IS NULL
             AND id IN (
               SELECT snapshot_id FROM mail_deliveries
               WHERE idempotency_key LIKE 'auth-magic-link:%' AND status IN ('cancelled', 'sent', 'dead_letter')
             )`,
        ).bind(nowMs),
        this.env.DB.prepare(
          `UPDATE mail_deliveries
           SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL
           WHERE idempotency_key LIKE 'auth-reviewer-invitation:%'
             AND (
               status IN ('pending', 'retry')
               OR (status = 'claimed' AND lease_expires_at <= ?)
             )
             AND EXISTS (
               SELECT 1 FROM reviewer_invitations
               WHERE id = substr(mail_deliveries.idempotency_key, length('auth-reviewer-invitation:') + 1)
                 AND (status <> 'pending' OR expires_at <= ?)
             )`,
        ).bind(nowMs, nowMs),
        this.env.DB.prepare(
          `UPDATE mail_delivery_snapshots
           SET rendered_html = NULL, rendered_text = NULL, ics_filename = NULL, ics_content = NULL, redacted_at = ?
           WHERE redacted_at IS NULL
             AND id IN (
               SELECT snapshot_id FROM mail_deliveries
               WHERE idempotency_key LIKE 'auth-reviewer-invitation:%' AND status IN ('cancelled', 'sent', 'dead_letter')
             )`,
        ).bind(nowMs),
        this.env.DB.prepare(
          `UPDATE mail_delivery_snapshots
           SET rendered_html = NULL, rendered_text = NULL, ics_filename = NULL, ics_content = NULL, redacted_at = ?
           WHERE event_id IS NOT NULL
             AND redacted_at IS NULL
             AND created_at <= ?
             AND EXISTS (
               SELECT 1 FROM mail_deliveries
               WHERE mail_deliveries.snapshot_id = mail_delivery_snapshots.id
                 AND mail_deliveries.idempotency_key NOT LIKE 'auth-magic-link:%'
                 AND mail_deliveries.idempotency_key NOT LIKE 'auth-reviewer-invitation:%'
                 AND mail_deliveries.status IN ('cancelled', 'sent', 'dead_letter')
             )`,
        ).bind(nowMs, nowMs - MAIL_SNAPSHOT_RETENTION_MS),
      ]);
      const due = await db
        .select({
          id: mailDeliveries.id,
          snapshotId: mailDeliveries.snapshotId,
          eventId: mailDeliverySnapshots.eventId,
          idempotencyKey: mailDeliveries.idempotencyKey,
          supersededAt: mailDeliveries.supersededAt,
          status: mailDeliveries.status,
          attemptCount: mailDeliveries.attemptCount,
          maxAttempts: mailDeliveries.maxAttempts,
          provider: mailDeliveries.provider,
          fromEmail: mailDeliverySnapshots.fromEmail,
          replyToEmail: mailDeliverySnapshots.replyToEmail,
          to: mailDeliverySnapshots.recipientEmail,
          subject: mailDeliverySnapshots.subject,
          html: mailDeliverySnapshots.renderedHtml,
          text: mailDeliverySnapshots.renderedText,
          ics: mailDeliverySnapshots.icsContent,
          icsFilename: mailDeliverySnapshots.icsFilename,
        })
        .from(mailDeliveries)
        .innerJoin(
          mailDeliverySnapshots,
          eq(mailDeliverySnapshots.id, mailDeliveries.snapshotId),
        )
        .where(
          and(
            isNull(mailDeliverySnapshots.redactedAt),
            or(
              and(
                inArray(mailDeliveries.status, ["pending", "retry"]),
                lt(mailDeliveries.attemptCount, mailDeliveries.maxAttempts),
                lte(mailDeliveries.availableAt, now),
                or(
                  isNull(mailDeliveries.leaseExpiresAt),
                  lte(mailDeliveries.leaseExpiresAt, now),
                ),
              ),
              and(
                inArray(mailDeliveries.status, ["claimed", "dispatching"]),
                lte(mailDeliveries.leaseExpiresAt, now),
              ),
            ),
          ),
        )
        .orderBy(
          asc(mailDeliveries.availableAt),
          asc(mailDeliveries.createdAt),
          asc(mailDeliveries.id),
        )
        .limit(MAX_BATCH);

      await processWithBoundedConcurrency(due, MAIL_DISPATCH_CONCURRENCY, async (delivery) => {
        if (delivery.html === null) return;
        if (delivery.supersededAt !== null && delivery.status !== "dispatching") {
          await db
            .update(mailDeliveries)
            .set({ status: "cancelled", leaseOwner: null, leaseExpiresAt: null })
            .where(and(
              eq(mailDeliveries.id, delivery.id),
              inArray(mailDeliveries.status, ["pending", "retry", "claimed"]),
              isNotNull(mailDeliveries.supersededAt),
            ));
          return;
        }
        const leaseOwner = crypto.randomUUID();
        const reclaim = delivery.status === "claimed" || delivery.status === "dispatching";
        const [reclaimedAttempt] = reclaim
          ? await db
            .select({
              id: mailDeliveryAttempts.id,
              status: mailDeliveryAttempts.status,
              providerMessageId: mailDeliveryAttempts.providerMessageId,
              providerResult: mailDeliveryAttempts.providerResult,
              completedAt: mailDeliveryAttempts.completedAt,
            })
            .from(mailDeliveryAttempts)
            .where(and(
              eq(mailDeliveryAttempts.deliveryId, delivery.id),
              eq(mailDeliveryAttempts.attemptNumber, delivery.attemptCount),
            ))
            .limit(1)
          : [];
        const storedReceiptAttempt = reclaimedAttempt?.status === "sent" && reclaimedAttempt.providerMessageId !== null
          ? { ...reclaimedAttempt, providerMessageId: reclaimedAttempt.providerMessageId }
          : undefined;
        if (reclaim && delivery.attemptCount >= delivery.maxAttempts && !storedReceiptAttempt) {
          const detail = "Delivery lease expired after the maximum number of attempts";
          await db.batch([
            db.update(mailDeliveryAttempts).set({
              status: "failed",
              error: detail,
              completedAt: now,
            }).where(and(
              eq(mailDeliveryAttempts.deliveryId, delivery.id),
              eq(mailDeliveryAttempts.attemptNumber, delivery.attemptCount),
              eq(mailDeliveryAttempts.status, "started"),
            )),
            db.update(mailDeliveries).set({
              status: "dead_letter",
              lastError: detail,
              deadLetteredAt: now,
              leaseOwner: null,
              leaseExpiresAt: null,
            }).where(and(
              eq(mailDeliveries.id, delivery.id),
              inArray(mailDeliveries.status, ["claimed", "dispatching"]),
              lte(mailDeliveries.leaseExpiresAt, now),
              sql`${mailDeliveries.attemptCount} >= ${mailDeliveries.maxAttempts}`,
            )),
          ]);
          await redactAuthSnapshot(db, delivery.snapshotId, delivery.idempotencyKey, now);
          return;
        }
        const [claim] = reclaim
          ? await db
            .update(mailDeliveries)
            .set({
              status: "dispatching",
              leaseOwner,
              leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
              attemptCount: storedReceiptAttempt
                ? delivery.attemptCount
                : sql`${mailDeliveries.attemptCount} + 1`,
            })
            .where(and(
              eq(mailDeliveries.id, delivery.id),
              inArray(mailDeliveries.status, ["claimed", "dispatching"]),
              lte(mailDeliveries.leaseExpiresAt, now),
              storedReceiptAttempt
                ? sql`${mailDeliveries.attemptCount} = ${delivery.attemptCount}`
                : lt(mailDeliveries.attemptCount, mailDeliveries.maxAttempts),
              or(
                eq(mailDeliveries.status, "dispatching"),
                isNull(mailDeliveries.supersededAt),
              ),
            ))
            .returning({
              attemptCount: mailDeliveries.attemptCount,
              maxAttempts: mailDeliveries.maxAttempts,
            })
          : await db
            .update(mailDeliveries)
            .set({
              status: "claimed",
              leaseOwner,
              leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
              attemptCount: sql`${mailDeliveries.attemptCount} + 1`,
            })
            .where(and(
              eq(mailDeliveries.id, delivery.id),
              inArray(mailDeliveries.status, ["pending", "retry"]),
              isNull(mailDeliveries.supersededAt),
              lt(mailDeliveries.attemptCount, mailDeliveries.maxAttempts),
              lte(mailDeliveries.availableAt, now),
              or(
                isNull(mailDeliveries.leaseExpiresAt),
                lte(mailDeliveries.leaseExpiresAt, now),
              ),
            ))
            .returning({
              attemptCount: mailDeliveries.attemptCount,
              maxAttempts: mailDeliveries.maxAttempts,
            });
        if (!claim) {
          await db
            .update(mailDeliveries)
            .set({ status: "cancelled", leaseOwner: null, leaseExpiresAt: null })
            .where(and(
              eq(mailDeliveries.id, delivery.id),
              eq(mailDeliveries.status, "claimed"),
              isNotNull(mailDeliveries.supersededAt),
            ));
          return;
        }

        const attemptId = crypto.randomUUID();
        const existingAttempt = reclaimedAttempt;
        if (storedReceiptAttempt) {
          const [completed] = await db
            .update(mailDeliveries)
            .set({
              status: "sent",
              provider: storedReceiptAttempt.providerMessageId.startsWith("local-fake:")
                ? "local-fake"
                : delivery.provider,
              providerMessageId: storedReceiptAttempt.providerMessageId,
              providerResult: storedReceiptAttempt.providerResult,
              lastError: null,
              sentAt: storedReceiptAttempt.completedAt ?? now,
              leaseOwner: null,
              leaseExpiresAt: null,
            })
            .where(and(
              eq(mailDeliveries.id, delivery.id),
              eq(mailDeliveries.status, "dispatching"),
              eq(mailDeliveries.leaseOwner, leaseOwner),
            ))
            .returning({ id: mailDeliveries.id });
          if (completed) {
            await redactAuthSnapshot(
              db,
              delivery.snapshotId,
              delivery.idempotencyKey,
              storedReceiptAttempt.completedAt ?? now,
            );
          }
          return;
        }
        if (!reclaim && !await authorizeMailDispatch(db, delivery.id, leaseOwner)) return;
        if (existingAttempt) {
          await db
            .update(mailDeliveryAttempts)
            .set({
              status: "retry",
              error: "Delivery lease expired before completion; retrying with a new attempt",
              completedAt: now,
            })
            .where(and(
              eq(mailDeliveryAttempts.id, existingAttempt.id),
              eq(mailDeliveryAttempts.status, "started"),
            ));
        }
        await db.insert(mailDeliveryAttempts).values({
          id: attemptId,
          deliveryId: delivery.id,
          attemptNumber: claim.attemptCount,
          leaseOwner,
          status: "started",
          startedAt: now,
        });

        const dispatchNow = Date.now();
        const budget = await reserveDispatchBudget(this.ctx.storage, {
          eventId: delivery.eventId,
          now: dispatchNow,
        });
        if (!budget.ok) {
          const completedAt = new Date();
          const detail = `Daily email dispatch budget exhausted: ${budget.reason}`;
          const terminal = claim.attemptCount >= claim.maxAttempts;
          await db
            .update(mailDeliveryAttempts)
            .set({
              status: terminal ? "failed" : "retry",
              error: detail,
              completedAt,
            })
            .where(eq(mailDeliveryAttempts.id, attemptId));
          await db
            .update(mailDeliveries)
            .set({
              status: terminal ? "dead_letter" : "retry",
              availableAt: terminal ? completedAt : nextUtcDay(dispatchNow),
              lastError: detail,
              deadLetteredAt: terminal ? completedAt : null,
              leaseOwner: null,
              leaseExpiresAt: null,
            })
            .where(and(
              eq(mailDeliveries.id, delivery.id),
              eq(mailDeliveries.status, "dispatching"),
              eq(mailDeliveries.leaseOwner, leaseOwner),
            ));
          return;
        }


        try {
          const receipt = await sendMail(this.env, {
            fromEmail: delivery.fromEmail,
            replyToEmail: delivery.replyToEmail ?? undefined,
            to: delivery.to,
            subject: delivery.subject,
            html: delivery.html,
            text: delivery.text ?? "",
            ics: delivery.ics ?? undefined,
            icsFilename: delivery.icsFilename ?? undefined,
            idempotencyKey: delivery.idempotencyKey,
          });
          const completedAt = new Date();
          await db
            .update(mailDeliveryAttempts)
            .set({
              status: "sent",
              providerMessageId: receipt.providerMessageId,
              providerResult: receipt.providerResult,
              completedAt,
            })
            .where(eq(mailDeliveryAttempts.id, attemptId));
          const [completed] = await db
            .update(mailDeliveries)
            .set({
              status: "sent",
              provider: receipt.provider,
              providerMessageId: receipt.providerMessageId,
              providerResult: receipt.providerResult,
              lastError: null,
              sentAt: completedAt,
              leaseOwner: null,
              leaseExpiresAt: null,
            })
            .where(
              and(
                eq(mailDeliveries.id, delivery.id),
                eq(mailDeliveries.status, "dispatching"),
                eq(mailDeliveries.leaseOwner, leaseOwner),
              ),
            )
            .returning({ id: mailDeliveries.id });
          if (completed) {
            await redactAuthSnapshot(
              db,
              delivery.snapshotId,
              delivery.idempotencyKey,
              completedAt,
            );
          }
        } catch (error) {
          const completedAt = new Date();
          const detail = error instanceof Error
            ? error.message.slice(0, 2_000)
            : String(error).slice(0, 2_000);
          const terminal = claim.attemptCount >= claim.maxAttempts;
          await db
            .update(mailDeliveryAttempts)
            .set({ status: "failed", error: detail, completedAt })
            .where(eq(mailDeliveryAttempts.id, attemptId));
          const [failed] = await db
            .update(mailDeliveries)
            .set({
              status: terminal ? "dead_letter" : "retry",
              availableAt: terminal
                ? completedAt
                : new Date(completedAt.getTime() + INTERVAL_MS),
              lastError: detail,
              deadLetteredAt: terminal ? completedAt : null,
              leaseOwner: null,
              leaseExpiresAt: null,
            })
            .where(
              and(
                eq(mailDeliveries.id, delivery.id),
                eq(mailDeliveries.status, "dispatching"),
                eq(mailDeliveries.leaseOwner, leaseOwner),
              ),
            )
            .returning({ id: mailDeliveries.id });
          if (terminal && failed) {
            await redactAuthSnapshot(
              db,
              delivery.snapshotId,
              delivery.idempotencyKey,
              completedAt,
            );
          }
        }
      });
    } finally {
      if (mailSchedulerEnabled) {
        await setSchedulerAlarmNoLaterThan(this.ctx.storage, Date.now() + INTERVAL_MS);
      }
    }
  }
}

export default Scheduler;
