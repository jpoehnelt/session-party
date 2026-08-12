import { DurableObject } from "cloudflare:workers";
import type { AirtableAdapterService } from "../airtable";
import { AirtableAdapterError } from "../airtable";
import { internalServiceToken } from "../services";

const NEXT_SLOT_KEY = "airtable-pat-next-slot";
const GLOBAL_LIMITER_NAME = "airtable-pat-global";
export const AIRTABLE_GLOBAL_INTERVAL_MS = 20;

/** One account-wide lane enforces Airtable's 50 requests/second PAT ceiling. */
export class AirtableRateLimiter extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/acquire") {
      return new Response("Not found", { status: 404 });
    }
    let secret: string;
    try {
      secret = await internalServiceToken(this.env);
    } catch {
      return new Response("Airtable rate limiter unavailable", { status: 503 });
    }
    if (request.headers.get("x-session-party-internal") !== secret) {
      return new Response("Forbidden", { status: 403 });
    }
    const slotAt = await this.ctx.storage.transaction(async (transaction) => {
      const now = Date.now();
      const current = await transaction.get<number>(NEXT_SLOT_KEY) ?? 0;
      const reserved = Math.max(now, current);
      await transaction.put(NEXT_SLOT_KEY, reserved + AIRTABLE_GLOBAL_INTERVAL_MS);
      return reserved;
    });
    const waitMs = Math.max(0, slotAt - Date.now());
    if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    return Response.json({ slotAt });
  }
}

const acquireGlobalSlot = async (env: Env): Promise<void> => {
  const id = env.AIRTABLE_RATE_LIMITER.idFromName(GLOBAL_LIMITER_NAME);
  const response = await env.AIRTABLE_RATE_LIMITER.get(id).fetch("https://airtable-rate-limiter/acquire", {
    method: "POST",
    headers: { "x-session-party-internal": await internalServiceToken(env) },
  });
  if (!response.ok) {
    throw new AirtableAdapterError({
      code: "global_rate_limiter_unavailable",
      message: `Airtable global rate limiter returned ${response.status}`,
      retryable: response.status >= 500,
    });
  }
};

export const withGlobalAirtableRateLimit = (
  env: Env,
  adapter: AirtableAdapterService,
): AirtableAdapterService => ({
  mode: adapter.mode,
  upsertBatch: async (input) => {
    await acquireGlobalSlot(env);
    return adapter.upsertBatch(input);
  },
  deleteBatch: async (input) => {
    await acquireGlobalSlot(env);
    return adapter.deleteBatch(input);
  },
  listPage: async (input) => {
    await acquireGlobalSlot(env);
    return adapter.listPage(input);
  },
});

export default AirtableRateLimiter;
