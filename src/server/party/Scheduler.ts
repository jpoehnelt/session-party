import {
  mailDeliveries,
  mailDeliveryAttempts,
  mailDeliverySnapshots,
} from "contracts/schema";
import { DurableObject } from "cloudflare:workers";
import { and, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { sendMail, sessionSecret } from "../services";

const INTERVAL_MS = 60_000;
const LEASE_MS = 5 * 60_000;
const MAX_BATCH = 100;
const redactAuthSnapshot = async (
  db: DrizzleD1Database,
  snapshotId: string,
  idempotencyKey: string,
  redactedAt: Date,
): Promise<void> => {
  if (!idempotencyKey.startsWith("auth-magic-link:")) return;
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


export class Scheduler extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/poke") {
      return new Response("Not found", { status: 404 });
    }
    let secret: string;
    try {
      secret = sessionSecret(this.env);
    } catch {
      return new Response("Scheduler unavailable", { status: 503 });
    }
    if (request.headers.get("x-session-party-internal") !== secret) {
      return new Response("Forbidden", { status: 403 });
    }
    await this.ctx.storage.setAlarm(Date.now() + 1);
    return Response.json({ ok: true });
  }

  override async alarm(): Promise<void> {
    try {
      const db = drizzle(this.env.DB);
      const now = new Date();
      const nowMs = now.getTime();
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
      ]);
      const due = await db
        .select({
          id: mailDeliveries.id,
          snapshotId: mailDeliveries.snapshotId,
          idempotencyKey: mailDeliveries.idempotencyKey,
          status: mailDeliveries.status,
          provider: mailDeliveries.provider,
          fromEmail: mailDeliverySnapshots.fromEmail,
          replyToEmail: mailDeliverySnapshots.replyToEmail,
          to: mailDeliverySnapshots.recipientEmail,
          subject: mailDeliverySnapshots.subject,
          html: mailDeliverySnapshots.renderedHtml,
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
                eq(mailDeliveries.status, "claimed"),
                lte(mailDeliveries.leaseExpiresAt, now),
              ),
            ),
          ),
        )
        .limit(MAX_BATCH);

      for (const delivery of due) {
        if (delivery.html === null) continue;
        const leaseOwner = crypto.randomUUID();
        const reclaim = delivery.status === "claimed";
        const [claim] = reclaim
          ? await db
            .update(mailDeliveries)
            .set({
              leaseOwner,
              leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
            })
            .where(and(
              eq(mailDeliveries.id, delivery.id),
              eq(mailDeliveries.status, "claimed"),
              lte(mailDeliveries.leaseExpiresAt, now),
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
        if (!claim) continue;

        let attemptId = crypto.randomUUID();
        const [existingAttempt] = reclaim
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
              eq(mailDeliveryAttempts.attemptNumber, claim.attemptCount),
            ))
            .limit(1)
          : [];
        if (
          existingAttempt?.status === "sent" &&
          existingAttempt.providerMessageId
        ) {
          const [completed] = await db
            .update(mailDeliveries)
            .set({
              status: "sent",
              provider: existingAttempt.providerMessageId.startsWith("local-fake:")
                ? "local-fake"
                : delivery.provider,
              providerMessageId: existingAttempt.providerMessageId,
              providerResult: existingAttempt.providerResult,
              lastError: null,
              sentAt: existingAttempt.completedAt ?? now,
              leaseOwner: null,
              leaseExpiresAt: null,
            })
            .where(and(
              eq(mailDeliveries.id, delivery.id),
              eq(mailDeliveries.status, "claimed"),
              eq(mailDeliveries.leaseOwner, leaseOwner),
            ))
            .returning({ id: mailDeliveries.id });
          if (completed) {
            await redactAuthSnapshot(
              db,
              delivery.snapshotId,
              delivery.idempotencyKey,
              existingAttempt.completedAt ?? now,
            );
          }
          continue;
        }
        if (existingAttempt) {
          attemptId = existingAttempt.id;
          await db
            .update(mailDeliveryAttempts)
            .set({
              leaseOwner,
              status: "started",
              providerMessageId: null,
              providerResult: null,
              error: null,
              completedAt: null,
            })
            .where(eq(mailDeliveryAttempts.id, attemptId));
        } else {
          await db.insert(mailDeliveryAttempts).values({
            id: attemptId,
            deliveryId: delivery.id,
            attemptNumber: claim.attemptCount,
            leaseOwner,
            status: "started",
            startedAt: now,
          });
        }

        try {
          const receipt = await sendMail(this.env, {
            fromEmail: delivery.fromEmail,
            replyToEmail: delivery.replyToEmail ?? undefined,
            to: delivery.to,
            subject: delivery.subject,
            html: delivery.html,
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
                eq(mailDeliveries.status, "claimed"),
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
                eq(mailDeliveries.status, "claimed"),
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
      }
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + INTERVAL_MS);
    }
  }
}

export default Scheduler;
