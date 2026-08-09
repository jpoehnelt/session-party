import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import type { AppError } from "contracts/errors";
import type {
  ApiScope,
  BrowserSessionPrincipal,
  EventApiKeyPrincipal,
} from "contracts/principal";
import { apiKeys, auditLog, domainChanges, eventMembers, events, integrations, users } from "contracts/schema";
import type { AcceleventsImportRun, AirtableConfig } from "contracts/types";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type AcceleventsImports,
  type Authorizer,
  type CurrentUser,
  AppLayer,
  CurrentUser as CurrentUserTag,
  type Db,
} from "@/server/services";
import {
  configureAcceleventsOperation,
  getAcceleventsConfigurationOperation,
  getAcceleventsImportStatusOperation,
  runAcceleventsImportOperation,
} from "./operations";
import {
  acceleventsCapabilityLabel,
  configurationTruth,
} from "./presentation";
import {
  configureAccelevents,
  getAcceleventsConfiguration,
  getAcceleventsImportStatus,
  listIntegrationConfigurations,
  runAcceleventsImport,
} from "./service";

interface TestEnv extends Cloudflare.Env {
  readonly TEST_MIGRATIONS: readonly D1Migration[];
}

const expiresAt = Date.UTC(2100, 0, 1);
const targetEventId = "integrations-event-target";
const targetEventSlug = "integrations-target-slug";
const otherEventId = "integrations-event-other";

const browserPrincipal = (
  userId: string,
  name: string,
): BrowserSessionPrincipal => ({
  kind: "browser-session",
  userId,
  email: `${userId}@example.com`,
  name,
  sessionId: `session-${userId}`,
  expiresAt,
});

const apiKeyPrincipal = (
  apiKeyId: string,
  eventId: string,
  scopes: readonly ApiScope[],
): EventApiKeyPrincipal => ({
  kind: "api-key",
  userId: `api-key:${apiKeyId}`,
  apiKeyId,
  eventId,
  name: apiKeyId,
  scopes,
  expiresAt,
});

const owner = browserPrincipal("integrations-owner", "Owner");
const admin = browserPrincipal("integrations-admin", "Admin");
const reviewer = browserPrincipal("integrations-reviewer", "Reviewer");
const outsider = browserPrincipal("integrations-outsider", "Outsider");

type Requirements = AcceleventsImports | Authorizer | CurrentUser | Db;

const runEitherAs = <A>(
  principal: BrowserSessionPrincipal | EventApiKeyPrincipal,
  effect: Effect.Effect<A, AppError, Requirements>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.either,
      Effect.provide(
        Layer.merge(AppLayer(env), Layer.succeed(CurrentUserTag, principal)),
      ),
    ),
  );

const runAs = async <A>(
  principal: BrowserSessionPrincipal | EventApiKeyPrincipal,
  effect: Effect.Effect<A, AppError, Requirements>,
): Promise<A> => {
  const result = await runEitherAs(principal, effect);
  if (result._tag === "Left") {
    throw new Error(`Unexpected Effect failure: ${JSON.stringify(result.left)}`);
  }
  return result.right;
};

const expectFailure = async (
  principal: BrowserSessionPrincipal | EventApiKeyPrincipal,
  effect: Effect.Effect<unknown, AppError, Requirements>,
  tag: AppError["_tag"],
) => {
  const result = await runEitherAs(principal, effect);
  if (result._tag === "Right") throw new Error(`Expected ${tag}`);
  expect(result.left._tag).toBe(tag);
};

const airtableConfiguration: AirtableConfig = {
  kind: "airtable",
  baseId: "appIntegrations",
  origin: "test-fixture",
  tables: {
    speakers: {
      tableId: "tblSpeakers",
      fields: {
        sessionPartyId: "fldSpeakerSessionPartyId",
        spRevision: "fldSpeakerRevision",
        spHash: "fldSpeakerHash",
        spOrigin: "fldSpeakerOrigin",
        displayName: "fldDisplayName",
        jobTitle: "fldJobTitle",
        company: "fldCompany",
        bio: "fldBio",
        visibility: "fldVisibility",
      },
    },
    submissions: {
      tableId: "tblSubmissions",
      fields: {
        sessionPartyId: "fldSubmissionSessionPartyId",
        spRevision: "fldSubmissionRevision",
        spHash: "fldSubmissionHash",
        spOrigin: "fldSubmissionOrigin",
        title: "fldSubmissionTitle",
        abstract: "fldAbstract",
        category: "fldCategory",
        status: "fldSubmissionStatus",
        submittedAt: "fldSubmittedAt",
        speakerLinks: "fldSubmissionSpeakers",
      },
    },
    talks: {
      tableId: "tblTalks",
      fields: {
        sessionPartyId: "fldTalkSessionPartyId",
        spRevision: "fldTalkRevision",
        spHash: "fldTalkHash",
        spOrigin: "fldTalkOrigin",
        title: "fldTalkTitle",
        description: "fldTalkDescription",
        track: "fldTrack",
        room: "fldRoom",
        startsAt: "fldStartsAt",
        durationMin: "fldDuration",
        status: "fldTalkStatus",
        speakerLinks: "fldTalkSpeakers",
        submissionLink: "fldTalkSubmission",
      },
    },
  },
};

beforeAll(async () => {
  if (!("TEST_MIGRATIONS" in env)) {
    throw new Error("TEST_MIGRATIONS test binding is unavailable");
  }
  await applyD1Migrations(env.DB, [...(env as TestEnv).TEST_MIGRATIONS]);
  const db = drizzle(env.DB);
  const now = new Date();
  await db.insert(users).values([owner, admin, reviewer, outsider].map((principal) => ({
    id: principal.userId,
    email: principal.email,
    name: principal.name,
    createdAt: now,
    updatedAt: now,
  }))).onConflictDoNothing().run();
  await db.insert(events).values([
    { id: targetEventId, slug: targetEventSlug, name: "Integrations target", createdAt: now, updatedAt: now },
    { id: otherEventId, slug: otherEventId, name: "Integrations other", createdAt: now, updatedAt: now },
  ]).run();
  await db.insert(eventMembers).values([
    { id: "integrations-member-owner", eventId: targetEventId, userId: owner.userId, role: "owner", createdAt: now, updatedAt: now },
    { id: "integrations-member-admin", eventId: targetEventId, userId: admin.userId, role: "admin", createdAt: now, updatedAt: now },
    { id: "integrations-member-reviewer", eventId: targetEventId, userId: reviewer.userId, role: "reviewer", createdAt: now, updatedAt: now },
    { id: "integrations-member-other-owner", eventId: otherEventId, userId: owner.userId, role: "owner", createdAt: now, updatedAt: now },
  ]).run();
  await db.insert(apiKeys).values({
    id: "accelevents-write",
    eventId: targetEventId,
    name: "Accelevents import test key",
    keyHash: "0".repeat(64),
    scopes: ["integrations:write"],
    expiresAt: new Date(expiresAt),
    createdBy: owner.userId,
    createdAt: now,
    updatedAt: now,
  }).run();
  await db.insert(integrations).values([
    {
      id: "integration-airtable-target",
      eventId: targetEventId,
      kind: "airtable",
      secretRef: "secret-ref-must-not-leak",
      config: {
        ...airtableConfiguration,
        apiToken: "raw-config-secret-must-not-leak",
      },
      cursor: "cursor-must-not-leak",
      lastError: "provider-error-must-not-leak",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "integration-accelevents-target",
      eventId: targetEventId,
      kind: "accelevents",
      secretRef: "fixture-secret-not-resolved",
      config: {
        kind: "accelevents",
        accelEventId: "fixture-event",
        eventUrl: "fixture-event",
      },
      createdAt: now,
      updatedAt: now,
    },
  ]).run();
});

describe("integrations configuration service", () => {
  it("resolves event IDs and slugs before enforcing organizer authorization", async () => {
    await expect(runAs(owner, listIntegrationConfigurations(targetEventSlug))).resolves.toHaveLength(2);
    await expect(runAs(admin, listIntegrationConfigurations(targetEventId))).resolves.toHaveLength(2);
    await expectFailure(reviewer, listIntegrationConfigurations(targetEventId), "Forbidden");
    await expectFailure(outsider, listIntegrationConfigurations(targetEventId), "Forbidden");

    const readKey = apiKeyPrincipal("integrations-read", targetEventId, ["integrations:read"]);
    const writeKey = apiKeyPrincipal("integrations-write", targetEventId, ["integrations:write"]);
    const crossEventKey = apiKeyPrincipal("integrations-other", otherEventId, ["integrations:read"]);
    await expect(runAs(readKey, listIntegrationConfigurations(targetEventId))).resolves.toHaveLength(2);
    await expectFailure(writeKey, listIntegrationConfigurations(targetEventId), "Forbidden");
    await expectFailure(crossEventKey, listIntegrationConfigurations(targetEventId), "Forbidden");
  });

  it("returns validated field maps without secret or runtime metadata", async () => {
    const result = await runAs(owner, listIntegrationConfigurations(targetEventId));
    expect(result).toEqual(expect.arrayContaining([
      airtableConfiguration,
      { kind: "accelevents", accelEventId: "fixture-event", eventUrl: "fixture-event" },
    ]));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret-ref-must-not-leak");
    expect(serialized).not.toContain("raw-config-secret-must-not-leak");
    expect(serialized).not.toContain("cursor-must-not-leak");
    expect(serialized).not.toContain("provider-error-must-not-leak");
  });

  it("derives configured and unconfigured provider truth from validated contracts", () => {
    expect(configurationTruth([])).toEqual({ airtable: false, accelevents: false });
    expect(configurationTruth([airtableConfiguration])).toEqual({
      airtable: true,
      accelevents: false,
    });
    expect(configurationTruth([
      airtableConfiguration,
      { kind: "accelevents", accelEventId: "accel-event", eventUrl: "accel-event" },
    ])).toEqual({ airtable: true, accelevents: true });
  });
});

describe("Accelevents import service", () => {
  it("authorizes status reads and reports the server-owned fixture capability", async () => {
    const readKey = apiKeyPrincipal("accelevents-read", targetEventId, ["integrations:read"]);
    const writeKey = apiKeyPrincipal("accelevents-write-only", targetEventId, ["integrations:write"]);

    await expect(runAs(owner, getAcceleventsImportStatus(targetEventSlug))).resolves.toMatchObject({
      configured: true,
      config: { kind: "accelevents", accelEventId: "fixture-event", eventUrl: "fixture-event" },
      capability: { mode: "fixture", state: "ready", reason: null },
    });
    await expect(runAs(readKey, getAcceleventsImportStatus(targetEventId))).resolves.toMatchObject({
      configured: true,
      capability: { mode: "fixture", state: "ready" },
    });
    await expectFailure(reviewer, getAcceleventsImportStatus(targetEventId), "Forbidden");
    await expectFailure(outsider, getAcceleventsImportStatus(targetEventId), "Forbidden");
    await expectFailure(writeKey, getAcceleventsImportStatus(targetEventId), "Forbidden");
  });

  it("requires write authorization and replays the same completed run idempotently", async () => {
    const writeKey = apiKeyPrincipal("accelevents-write", targetEventId, ["integrations:write"]);
    const readKey = apiKeyPrincipal("accelevents-read-only", targetEventId, ["integrations:read"]);
    const idempotencyKey = "integrations-import-idempotency";

    await expectFailure(reviewer, runAcceleventsImport(targetEventId, idempotencyKey), "Forbidden");
    await expectFailure(readKey, runAcceleventsImport(targetEventId, idempotencyKey), "Forbidden");

    const first = await runAs(writeKey, runAcceleventsImport(targetEventSlug, idempotencyKey));
    const replay = await runAs(writeKey, runAcceleventsImport(targetEventId, idempotencyKey));
    expect(first.status).toBe("succeeded");
    expect(first.mode).toBe("fixture");
    expect(first.counts).toEqual({
      total: 4,
      created: 4,
      updated: 0,
      unchanged: 0,
      failed: 0,
    });
    expect(replay).toEqual(first);

    const status = await runAs(owner, getAcceleventsImportStatus(targetEventId));
    expect(status.latestRun).toEqual(first);
  });
});

describe("Accelevents configuration service", () => {
  const fixtureInput = {
    idOrSlug: otherEventId,
    source: "fixture" as const,
    accelEventId: "fixture-event",
    eventUrl: "fixture-event",
    expectedVersion: 0,
    idempotencyKey: "configure-fixture-idempotency",
  };

  it("creates a truthfully labeled fixture mapping with replay, OCC, and durable evidence", async () => {
    const first = await runAs(owner, configureAccelevents(fixtureInput));
    expect(first).toMatchObject({
      configuration: {
        source: "fixture",
        config: { kind: "accelevents", accelEventId: "fixture-event", eventUrl: "fixture-event" },
        version: 1,
      },
      replayed: false,
    });
    const replay = await runAs(owner, configureAccelevents(fixtureInput));
    expect(replay).toEqual({ ...first, replayed: true });
    await expectFailure(owner, configureAccelevents({
      ...fixtureInput,
      idempotencyKey: "configure-wrong-version",
      expectedVersion: 0,
    }), "Conflict");
    await expectFailure(owner, configureAccelevents({
      ...fixtureInput,
      idempotencyKey: "configure-fixture-live-mismatch",
      source: "live",
    }), "Validation");

    await expect(runAs(owner, getAcceleventsConfiguration(otherEventId))).resolves.toEqual(first.configuration);
    const [changes, audits] = await Promise.all([
      drizzle(env.DB).select().from(domainChanges).where(eq(domainChanges.id, first.changeId)),
      drizzle(env.DB).select().from(auditLog).where(eq(auditLog.id, first.auditId)),
    ]);
    expect(changes[0]).toMatchObject({ eventType: "integrations.accelevents_configured", aggregateVersion: 1 });
    expect(audits[0]).toMatchObject({ action: "integrations.configureAccelevents", resourceType: "integration" });
  });
});

describe("Accelevents transport and route contracts", () => {
  it("exposes status and idempotent import through REST and MCP metadata", () => {
    expect(getAcceleventsImportStatusOperation.rest).toMatchObject({
      method: "get",
      path: "/events/:idOrSlug/integrations/accelevents/status",
      input: { path: ["idOrSlug"] },
    });
    expect(getAcceleventsImportStatusOperation.mcp.name).toBe("get_accelevents_import_status");
    expect(runAcceleventsImportOperation.rest).toMatchObject({
      method: "post",
      path: "/events/:idOrSlug/integrations/accelevents/imports",
      input: { path: ["idOrSlug"], body: ["idempotencyKey"] },
    });
    expect(runAcceleventsImportOperation.mcp.name).toBe("run_accelevents_import");
    expect(runAcceleventsImportOperation.idempotency).toBe("required");
    expect(configureAcceleventsOperation.rest).toMatchObject({
      method: "put",
      path: "/events/:idOrSlug/integrations/accelevents/configuration",
      input: { path: ["idOrSlug"] },
    });
    expect(configureAcceleventsOperation.mcp.name).toBe("configure_accelevents");
    expect(configureAcceleventsOperation.concurrency).toBe("required");
    expect(getAcceleventsConfigurationOperation.mcp.name).toBe("get_accelevents_configuration");
  });

  it("labels only server-reported ready modes as live or fixture", () => {
    const base = {
      configured: true,
      config: { kind: "accelevents" as const, accelEventId: "fixture-event", eventUrl: "fixture-event" },
      latestRun: null as AcceleventsImportRun | null,
    };
    expect(acceleventsCapabilityLabel({
      ...base,
      capability: { mode: "live", state: "ready", reason: null },
    })).toBe("Live");
    expect(acceleventsCapabilityLabel({
      ...base,
      capability: { mode: "fixture", state: "ready", reason: null },
    })).toBe("Fixture");
    expect(acceleventsCapabilityLabel({
      ...base,
      capability: { mode: "live", state: "unavailable", reason: "credential_unavailable" },
    })).toBe("Unavailable");
  });
});
