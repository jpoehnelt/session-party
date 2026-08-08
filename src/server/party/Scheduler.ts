import { emailSends, users } from "contracts/schema";
import { DurableObject } from "cloudflare:workers";
import { and, eq, isNotNull, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { sendMail } from "../services";

const INTERVAL_MS = 60_000;

export class Scheduler extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/poke") {
      return new Response("Not found", { status: 404 });
    }
    await this.ctx.storage.setAlarm(Date.now() + 1);
    return Response.json({ ok: true });
  }

  override async alarm(): Promise<void> {
    try {
      const db = drizzle(this.env.DB);
      const now = new Date();
      const due = await db
        .select({
          id: emailSends.id,
          to: users.email,
          subject: emailSends.subject,
        })
        .from(emailSends)
        .innerJoin(users, eq(users.id, emailSends.toUserId))
        .where(
          and(
            eq(emailSends.status, "scheduled"),
            isNotNull(emailSends.scheduledFor),
            lte(emailSends.scheduledFor, now),
          ),
        )
        .limit(100);

      for (const email of due) {
        try {
          // The frozen email_sends contract persists the rendered subject but has no body column.
          // Until that contract grows one, use the subject as a safe, visible fallback body.
          await sendMail(this.env, {
            to: email.to,
            subject: email.subject,
            html: `<p>${email.subject}</p>`,
          });
          await db
            .update(emailSends)
            .set({ status: "sent", sentAt: new Date(), error: null, updatedAt: new Date() })
            .where(and(eq(emailSends.id, email.id), eq(emailSends.status, "scheduled")));
        } catch (error) {
          await db
            .update(emailSends)
            .set({
              status: "failed",
              error: error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000),
              updatedAt: new Date(),
            })
            .where(and(eq(emailSends.id, email.id), eq(emailSends.status, "scheduled")));
        }
      }
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + INTERVAL_MS);
    }
  }
}

export default Scheduler;

