import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { External } from "contracts/errors";
import * as schema from "contracts/schema";
import type { AcceleventsImportRun, AcceleventsSnapshot } from "contracts/types";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Effect, Exit } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createAcceleventsImports,
  createFixtureAcceleventsAdapter,
  createLiveAcceleventsAdapter,
  createSecretResolver,
  type AcceleventsAdapterService,
  type ResolvedSecret,
} from "./accelevents";

interface TestEnv extends Cloudflare.Env {
  readonly TEST_MIGRATIONS: readonly D1Migration[];
}

const db = drizzle(env.DB, { schema });
let sequence = 0;

const hash = async (value: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const seed = async (
  options: {
    readonly secretRef?: string;
    readonly lastSyncAt?: Date | null;
    readonly eventUrl?: string;
    readonly accelEventId?: string;
  } = {},
) => {
  const id = `accelevents-${++sequence}`;
  const now = new Date(1_800_000_000_000 + sequence * 1_000);
  const eventId = `${id}-event`;
  const userId = `${id}-user`;
  const integrationId = `${id}-integration`;
  await db.batch([
    db.insert(schema.users).values({
      id: userId,
      email: `${id}@example.com`,
      name: "Import Owner",
      version: 1,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(schema.events).values({
      id: eventId,
      slug: id,
      name: `Event ${id}`,
      timezone: "UTC",
      version: 1,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(schema.integrations).values({
      id: integrationId,
      eventId,
      kind: "accelevents",
      secretRef: options.secretRef ?? "ACCELEVENTS_API_TOKEN",
      config: {
        kind: "accelevents",
        accelEventId: options.accelEventId ?? `${id}-provider`,
        eventUrl: options.eventUrl ?? `${id}-url`,
      },
      cursor: null,
      lastSyncAt: options.lastSyncAt ?? null,
      lastError: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }),
  ]);
  return { eventId, userId, integrationId, now };
};

const actor = (id: string) => ({ kind: "user" as const, id });

beforeAll(async () => {
  if (!("TEST_MIGRATIONS" in env)) throw new Error("TEST_MIGRATIONS binding unavailable");
  await applyD1Migrations(env.DB, [...(env as TestEnv).TEST_MIGRATIONS]);
});

describe("Accelevents shared import seam", () => {
  it("labels and persists the deterministic fixture, then replays without duplicates", async () => {
    const seeded = await seed();
    let clock = seeded.now.getTime();
    const imports = createAcceleventsImports({
      db,
      adapter: createFixtureAcceleventsAdapter(),
      secrets: createSecretResolver(undefined),
      now: () => ++clock,
    });

    const before = await Effect.runPromise(imports.status(seeded.eventId));
    expect(before).toMatchObject({
      configured: true,
      capability: { mode: "fixture", state: "ready", reason: null },
      latestRun: null,
    });

    const input = {
      eventId: seeded.eventId,
      idempotencyKey: "fixture-import-key",
      actor: actor(seeded.userId),
    };
    const first = await Effect.runPromise(imports.run(input));
    const replay = await Effect.runPromise(imports.run(input));
    const second = await Effect.runPromise(imports.run({ ...input, idempotencyKey: "fixture-import-key-2" }));

    expect(first).toMatchObject({
      mode: "fixture",
      status: "succeeded",
      counts: { total: 4, created: 4, updated: 0, unchanged: 0, failed: 0 },
    });
    expect(replay).toEqual(first);
    expect(second).toMatchObject({
      counts: { total: 4, created: 0, updated: 0, unchanged: 4, failed: 0 },
    });
    expect(await db.$count(schema.speakers, eq(schema.speakers.eventId, seeded.eventId))).toBe(2);
    expect(await db.$count(schema.talks, eq(schema.talks.eventId, seeded.eventId))).toBe(2);
    expect(await db.$count(
      schema.acceleventsExternalIdentities,
      eq(schema.acceleventsExternalIdentities.eventId, seeded.eventId),
    )).toBe(4);
    expect((await Effect.runPromise(imports.status(seeded.eventId))).latestRun?.runId).toBe(second.runId);
    const [integration] = await db.select().from(schema.integrations).where(
      eq(schema.integrations.id, seeded.integrationId),
    );
    expect(integration?.lastSyncAt).not.toBeNull();
    expect(integration?.lastError).toBeNull();
  });

  it("selects the reserved fixture configuration in production-shaped live mode only", async () => {
    const fixtureSeed = await seed({ accelEventId: "fixture-event", eventUrl: "fixture-event" });
    const liveSeed = await seed();
    let liveCalls = 0;
    const liveAdapter: AcceleventsAdapterService = {
      mode: "live",
      fetchSnapshot: () => {
        liveCalls += 1;
        return Effect.fail(new External({ service: "accelevents", detail: "live unavailable" }));
      },
    };
    const imports = createAcceleventsImports({
      db,
      adapter: liveAdapter,
      fixtureAdapter: createFixtureAcceleventsAdapter(),
      secrets: createSecretResolver(undefined),
    });

    expect((await Effect.runPromise(imports.status(fixtureSeed.eventId))).capability).toEqual({
      mode: "fixture",
      state: "ready",
      reason: null,
    });
    const fixtureRun = await Effect.runPromise(imports.run({
      eventId: fixtureSeed.eventId,
      idempotencyKey: "production-shaped-fixture-key",
      actor: actor(fixtureSeed.userId),
    }));
    expect(fixtureRun).toMatchObject({ mode: "fixture", status: "succeeded" });

    expect((await Effect.runPromise(imports.status(liveSeed.eventId))).capability).toEqual({
      mode: "live",
      state: "unavailable",
      reason: "credential_unavailable",
    });
    const liveRun = await Effect.runPromise(imports.run({
      eventId: liveSeed.eventId,
      idempotencyKey: "production-shaped-live-key",
      actor: actor(liveSeed.userId),
    }));
    expect(liveRun).toMatchObject({ mode: "live", status: "failed" });
    expect(liveCalls).toBe(0);
  });

  it("turns a concurrent same-key claim collision into replay or conflict, never an external failure", async () => {
    const seeded = await seed();
    const imports = createAcceleventsImports({
      db,
      adapter: createFixtureAcceleventsAdapter(),
      secrets: createSecretResolver(undefined),
    });
    const input = {
      eventId: seeded.eventId,
      idempotencyKey: "concurrent-key",
      actor: actor(seeded.userId),
    };
    const outcomes = await Promise.allSettled([
      Effect.runPromise(imports.run(input)),
      Effect.runPromise(imports.run(input)),
    ]);
    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<AcceleventsImportRun> =>
        outcome.status === "fulfilled",
    );
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(new Set(fulfilled.map(({ value }) => value.runId)).size).toBe(1);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        expect(String(outcome.reason)).toContain("Conflict");
        expect(String(outcome.reason)).not.toContain("External");
      }
    }
    expect(await db.$count(
      schema.acceleventsImportRuns,
      eq(schema.acceleventsImportRuns.eventId, seeded.eventId),
    )).toBe(1);
    expect(await db.$count(
      schema.acceleventsExternalIdentities,
      eq(schema.acceleventsExternalIdentities.eventId, seeded.eventId),
    )).toBe(4);
  });

  it("preserves valid rows and durable item evidence when one talk cannot link a speaker", async () => {
    const seeded = await seed();
    const snapshot: AcceleventsSnapshot = {
      providerEventId: `${seeded.eventId.replace(/-event$/, "")}-provider`,
      speakers: [{
        externalId: "partial-speaker",
        displayName: "Partial Speaker",
        title: null,
        company: null,
        bio: null,
      }],
      talks: [{
        externalId: "partial-talk",
        title: "Broken reference",
        description: null,
        startsAt: null,
        durationMin: 30,
        status: "confirmed",
        speakerExternalIds: ["missing-speaker"],
      }],
    };
    const adapter: AcceleventsAdapterService = {
      mode: "fixture",
      fetchSnapshot: () => Effect.succeed(snapshot),
    };
    const imports = createAcceleventsImports({ db, adapter, secrets: createSecretResolver(undefined) });
    const run = await Effect.runPromise(imports.run({
      eventId: seeded.eventId,
      idempotencyKey: "partial-import-key",
      actor: actor(seeded.userId),
    }));

    expect(run).toMatchObject({
      status: "partial",
      counts: { total: 2, created: 1, failed: 1 },
    });
    expect(run.items[1]).toMatchObject({
      entityType: "talk",
      action: "failed",
      localId: null,
      errorCode: "speaker_not_imported",
    });
    const persisted = await db.select().from(schema.acceleventsImportItems).where(and(
      eq(schema.acceleventsImportItems.eventId, seeded.eventId),
      eq(schema.acceleventsImportItems.runId, run.runId),
    ));
    expect(persisted).toHaveLength(2);
    expect(await db.$count(schema.speakers, eq(schema.speakers.eventId, seeded.eventId))).toBe(1);
    expect(await db.$count(schema.talks, eq(schema.talks.eventId, seeded.eventId))).toBe(0);
    const [integration] = await db.select().from(schema.integrations).where(
      eq(schema.integrations.id, seeded.integrationId),
    );
    expect(integration?.lastSyncAt).not.toBeNull();
    expect(integration?.lastError).toBeNull();
  });

  it("classifies an all-item failure as failed without advancing sync freshness", async () => {
    const lastSyncAt = new Date(1_799_998_000_000);
    const seeded = await seed({ lastSyncAt });
    const adapter: AcceleventsAdapterService = {
      mode: "fixture",
      fetchSnapshot: () => Effect.succeed({
        providerEventId: `${seeded.eventId.replace(/-event$/, "")}-provider`,
        speakers: [],
        talks: [{
          externalId: "all-failed-talk",
          title: "Unlinkable talk",
          description: null,
          startsAt: null,
          durationMin: 30,
          status: "confirmed",
          speakerExternalIds: ["missing-speaker"],
        }],
      }),
    };
    const imports = createAcceleventsImports({ db, adapter, secrets: createSecretResolver(undefined) });
    const run = await Effect.runPromise(imports.run({
      eventId: seeded.eventId,
      idempotencyKey: "all-failed-key",
      actor: actor(seeded.userId),
    }));
    expect(run).toMatchObject({
      status: "failed",
      counts: { total: 1, created: 0, updated: 0, unchanged: 0, failed: 1 },
      errorCode: "all_items_failed",
      errorDetail: "Every imported item failed",
    });
    expect(run.items).toHaveLength(1);
    const [integration] = await db.select().from(schema.integrations).where(
      eq(schema.integrations.id, seeded.integrationId),
    );
    expect(integration?.lastSyncAt).toEqual(lastSyncAt);
    expect(integration?.lastError).toBe("Every imported item failed");
  });

  it("fails closed in live mode, retains lastSyncAt, and exposes no secret material", async () => {
    const lastSyncAt = new Date(1_799_999_000_000);
    const seeded = await seed({ lastSyncAt });
    const unavailable: AcceleventsAdapterService = {
      mode: "live",
      fetchSnapshot: () => Effect.fail(
        new External({ service: "accelevents", detail: "upstream unavailable" }),
      ),
    };
    const imports = createAcceleventsImports({
      db,
      adapter: unavailable,
      secrets: createSecretResolver(undefined),
    });

    const status = await Effect.runPromise(imports.status(seeded.eventId));
    expect(status.capability).toEqual({
      mode: "live",
      state: "unavailable",
      reason: "credential_unavailable",
    });
    const run = await Effect.runPromise(imports.run({
      eventId: seeded.eventId,
      idempotencyKey: "missing-secret-key",
      actor: actor(seeded.userId),
    }));
    expect(run).toMatchObject({ status: "failed", errorCode: "snapshot_unavailable" });
    const [integration] = await db.select().from(schema.integrations).where(
      eq(schema.integrations.id, seeded.integrationId),
    );
    expect(integration?.lastSyncAt).toEqual(lastSyncAt);
    expect(JSON.stringify({ status, run })).not.toContain("ACCELEVENTS_API_TOKEN");
  });

  it("uses an injected live credential internally without serializing it", async () => {
    const seeded = await seed();
    const secret = "super-secret-accelevents-token";
    let observed: ResolvedSecret | null = null;
    const adapter: AcceleventsAdapterService = {
      mode: "live",
      fetchSnapshot: (config, credential) => {
        observed = credential;
        return Effect.succeed({ providerEventId: config.accelEventId, speakers: [], talks: [] });
      },
    };
    const imports = createAcceleventsImports({
      db,
      adapter,
      secrets: createSecretResolver(secret),
    });
    const run = await Effect.runPromise(imports.run({
      eventId: seeded.eventId,
      idempotencyKey: "live-import-key",
      actor: actor(seeded.userId),
    }));
    expect(observed).toBe(secret);
    expect(run).toMatchObject({ mode: "live", status: "succeeded" });
    expect(JSON.stringify(await Effect.runPromise(imports.status(seeded.eventId)))).not.toContain(secret);
  });

  it("reads every live provider page before constructing the snapshot", async () => {
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(`${url.pathname}?page=${url.searchParams.get("page")}`);
      expect(new Headers(init?.headers).get("Authorization")).toBe("pagination-secret");
      const page = Number(url.searchParams.get("page"));
      if (url.pathname.includes("/speaker")) {
        const count = page === 0 ? 500 : 1;
        return Response.json({
          content: Array.from({ length: count }, (_, index) => ({
            speakerId: `speaker-${page}-${index}`,
            name: `Speaker ${page}-${index}`,
          })),
        });
      }
      return Response.json({ data: [] });
    };
    const adapter = createLiveAcceleventsAdapter(fetchImpl);
    const snapshot = await Effect.runPromise(adapter.fetchSnapshot(
      { kind: "accelevents", accelEventId: "provider-event", eventUrl: "provider-url" },
      "pagination-secret" as ResolvedSecret,
    ));
    expect(snapshot.speakers).toHaveLength(501);
    expect(snapshot.talks).toEqual([]);
    expect(requests).toEqual(expect.arrayContaining([
      "/rest/host/event/provider-url/speaker?page=0",
      "/rest/host/event/provider-url/speaker?page=1",
      "/rest/events/provider-url/session/v2/get-all-sessions?page=0",
    ]));
  });

  it("retires an expired crash-shaped claim and completes one replacement without duplicate identities", async () => {
    const seeded = await seed();
    const providerEventId = `${seeded.eventId.replace(/-event$/, "")}-provider`;
    const eventUrl = `${seeded.eventId.replace(/-event$/, "")}-url`;
    let clock = seeded.now.getTime() + 100;
    const imports = createAcceleventsImports({
      db,
      adapter: createFixtureAcceleventsAdapter(),
      secrets: createSecretResolver(undefined),
      now: () => ++clock,
    });
    await Effect.runPromise(imports.run({
      eventId: seeded.eventId,
      idempotencyKey: "identity-seed-key",
      actor: actor(seeded.userId),
    }));
    expect(await db.$count(
      schema.acceleventsExternalIdentities,
      eq(schema.acceleventsExternalIdentities.eventId, seeded.eventId),
    )).toBe(4);

    const staleKey = "expired-crash-key";
    const staleKeyHash = await hash(staleKey);
    const requestHash = await hash(JSON.stringify({
      eventId: seeded.eventId,
      integrationId: seeded.integrationId,
      providerEventId,
      eventUrl,
    }));
    const crashedAt = new Date(clock + 1_000);
    const expiredAt = new Date(crashedAt.getTime() + 86_400_000);
    const staleRunId = `${seeded.eventId}-stale-run`;
    const staleRecordId = `${seeded.eventId}-stale-claim`;
    await db.batch([
      db.insert(schema.idempotencyRecords).values({
        id: staleRecordId,
        eventId: seeded.eventId,
        operationId: "integrations.runAcceleventsImport",
        principalId: `user:${seeded.userId}`,
        keyHash: staleKeyHash,
        requestHash,
        status: "in_progress",
        responseStatus: null,
        responseBody: { runId: staleRunId },
        expiresAt: expiredAt,
        completedAt: null,
        createdAt: crashedAt,
      }),
      db.insert(schema.acceleventsImportRuns).values({
        id: staleRunId,
        eventId: seeded.eventId,
        integrationId: seeded.integrationId,
        sourceEventId: providerEventId,
        eventUrl,
        mode: "fixture",
        status: "running",
        totalCount: 0,
        createdCount: 0,
        updatedCount: 0,
        unchangedCount: 0,
        failedCount: 0,
        errorCode: null,
        errorDetail: null,
        startedAt: crashedAt,
        completedAt: null,
      }),
    ]);
    clock = expiredAt.getTime() + 100;

    const replacement = await Effect.runPromise(imports.run({
      eventId: seeded.eventId,
      idempotencyKey: staleKey,
      actor: actor(seeded.userId),
    }));
    expect(replacement).toMatchObject({
      status: "succeeded",
      counts: { total: 4, created: 0, updated: 0, unchanged: 4, failed: 0 },
    });
    expect(await db.$count(
      schema.acceleventsExternalIdentities,
      eq(schema.acceleventsExternalIdentities.eventId, seeded.eventId),
    )).toBe(4);
    const [retiredRun] = await db.select().from(schema.acceleventsImportRuns).where(
      eq(schema.acceleventsImportRuns.id, staleRunId),
    );
    expect(retiredRun).toMatchObject({
      status: "failed",
      errorCode: "import_interrupted",
      errorDetail: "The previous import did not complete",
    });
    expect(retiredRun?.completedAt).not.toBeNull();
    const [retiredClaim] = await db.select().from(schema.idempotencyRecords).where(
      eq(schema.idempotencyRecords.id, staleRecordId),
    );
    expect(retiredClaim?.status).toBe("failed");
    expect(retiredClaim?.keyHash).not.toBe(staleKeyHash);
    const activeClaims = await db.select().from(schema.idempotencyRecords).where(and(
      eq(schema.idempotencyRecords.eventId, seeded.eventId),
      eq(schema.idempotencyRecords.operationId, "integrations.runAcceleventsImport"),
      eq(schema.idempotencyRecords.principalId, `user:${seeded.userId}`),
      eq(schema.idempotencyRecords.keyHash, staleKeyHash),
    ));
    expect(activeClaims).toHaveLength(1);
    expect(activeClaims[0]?.status).toBe("completed");
    const responseBody = activeClaims[0]?.responseBody;
    expect(
      responseBody !== null
        && typeof responseBody === "object"
        && "runId" in responseBody
        && typeof responseBody.runId === "string"
        ? responseBody.runId
        : null,
    ).toBe(replacement.runId);
  });

  it("isolates identities by event and rejects a reused key after source reconfiguration", async () => {
    const first = await seed();
    const second = await seed({ accelEventId: `${first.eventId.replace(/-event$/, "")}-provider` });
    const imports = createAcceleventsImports({
      db,
      adapter: createFixtureAcceleventsAdapter(),
      secrets: createSecretResolver(undefined),
    });
    const firstRun = await Effect.runPromise(imports.run({
      eventId: first.eventId,
      idempotencyKey: "event-scope-key",
      actor: actor(first.userId),
    }));
    const secondRun = await Effect.runPromise(imports.run({
      eventId: second.eventId,
      idempotencyKey: "event-scope-key",
      actor: actor(second.userId),
    }));
    expect(firstRun.eventId).not.toBe(secondRun.eventId);
    expect(await db.$count(schema.acceleventsExternalIdentities)).toBeGreaterThanOrEqual(8);

    await db.update(schema.integrations).set({
      config: { kind: "accelevents", accelEventId: "changed-provider", eventUrl: "changed-url" },
    }).where(and(
      eq(schema.integrations.eventId, first.eventId),
      eq(schema.integrations.id, first.integrationId),
    ));
    const exit = await Effect.runPromiseExit(imports.run({
      eventId: first.eventId,
      idempotencyKey: "event-scope-key",
      actor: actor(first.userId),
    }));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("Idempotency key");
  });
});
