import type { EventRoomBroadcast, ServerMessage } from "contracts/protocol";
import { DurableObject } from "cloudflare:workers";
import {
  AirtableAdapterError,
  createFakeAirtableAdapter,
  createLiveAirtableAdapter,
  type AirtableAdapterService,
} from "../airtable";
import { isExplicitLocalEnvironment, sessionSecret } from "../services";
import {
  drainAirtableBase,
  type AirtableProjectionCursor,
} from "./airtable-engine";
import { withGlobalAirtableRateLimit } from "./AirtableRateLimiter";

const BASE_ID_KEY = "airtable-base-id";
const PROJECTION_CURSOR_PREFIX = "airtable-projection-cursor:";
const MAX_BASE_ID_LENGTH = 128;

type AirtableEnv = Env & { readonly AIRTABLE_PAT?: string };

const baseIdFrom = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const baseId = Reflect.get(value, "baseId");
  return typeof baseId === "string"
    && baseId.length > 0
    && baseId.length <= MAX_BASE_ID_LENGTH
    && /^[A-Za-z0-9_-]+$/.test(baseId)
    ? baseId
    : null;
};

const unavailableAdapter = (): AirtableAdapterService => {
  const fail = (): never => {
    throw new AirtableAdapterError({
      code: "missing_credentials",
      message: "AIRTABLE_PAT is not configured",
      retryable: false,
    });
  };
  return {
    mode: "live",
    upsertBatch: async () => fail(),
    deleteBatch: async () => fail(),
    listPage: async () => fail(),
  };
};

export const setAirtableAlarmNoLaterThan = async (
  storage: DurableObjectStorage,
  next: number,
): Promise<void> => {
  await storage.transaction(async (transaction) => {
    const current = await transaction.getAlarm();
    if (current === null || current > next) await transaction.setAlarm(next);
  });
};

export class AirtableSyncLane extends DurableObject<Env> {
  private adapter(): AirtableAdapterService {
    if (isExplicitLocalEnvironment(this.env)) {
      return withGlobalAirtableRateLimit(this.env, createFakeAirtableAdapter(this.ctx.storage));
    }
    const pat = (this.env as AirtableEnv).AIRTABLE_PAT?.trim();
    return withGlobalAirtableRateLimit(
      this.env,
      pat ? createLiveAirtableAdapter(pat) : unavailableAdapter(),
    );
  }

  private async bindBase(baseId: string): Promise<boolean> {
    return this.ctx.storage.transaction(async (transaction) => {
      const existing = await transaction.get<string>(BASE_ID_KEY);
      if (existing && existing !== baseId) return false;
      if (!existing) await transaction.put(BASE_ID_KEY, baseId);
      return true;
    });
  }

  private async broadcast(eventId: string, message: ServerMessage): Promise<void> {
    const id = this.env.EVENT_ROOM.idFromName(eventId);
    const response = await this.env.EVENT_ROOM.get(id).fetch("https://event-room/broadcast", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-party-internal": sessionSecret(this.env),
      },
      body: JSON.stringify({ message } satisfies EventRoomBroadcast),
    });
    if (!response.ok) throw new Error(`EventRoom broadcast returned ${response.status}`);
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
    let secret: string;
    try {
      secret = sessionSecret(this.env);
    } catch {
      return new Response("Airtable sync unavailable", { status: 503 });
    }
    if (request.headers.get("x-session-party-internal") !== secret) {
      return new Response("Forbidden", { status: 403 });
    }
    const url = new URL(request.url);
    if (url.pathname !== "/poke") return new Response("Not found", { status: 404 });
    const baseId = baseIdFrom(await request.json<unknown>().catch(() => null));
    if (!baseId) return new Response("Invalid request", { status: 400 });
    if (!(await this.bindBase(baseId))) {
      return new Response("Durable Object is already bound to another Airtable base", { status: 409 });
    }
    const next = Date.now() + 1;
    await setAirtableAlarmNoLaterThan(this.ctx.storage, next);
    return Response.json({ ok: true });
  }

  override async alarm(): Promise<void> {
    const baseId = await this.ctx.storage.get<string>(BASE_ID_KEY);
    if (!baseId) return;
    try {
      const result = await drainAirtableBase({
        database: this.env.DB,
        adapter: this.adapter(),
        broadcast: (eventId, message) => this.broadcast(eventId, message),
        projectionCursor: {
          get: (integrationId) => this.ctx.storage.get<AirtableProjectionCursor>(
            `${PROJECTION_CURSOR_PREFIX}${integrationId}`,
          ),
          set: (integrationId, cursor) => this.ctx.storage.put(
            `${PROJECTION_CURSOR_PREFIX}${integrationId}`,
            cursor,
          ),
        },
      }, baseId);
      await setAirtableAlarmNoLaterThan(this.ctx.storage, result.nextAlarmAt);
    } catch (error) {
      console.error(JSON.stringify({
        message: "Airtable sync lane failed",
        baseId,
        error: error instanceof Error ? error.message : String(error),
      }));
      await setAirtableAlarmNoLaterThan(this.ctx.storage, Date.now() + 60_000);
    }
  }
}

export default AirtableSyncLane;
