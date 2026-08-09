import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import type { AppError } from "contracts/errors";
import type {
  ApiScope,
  BrowserSessionPrincipal,
  EventApiKeyPrincipal,
} from "contracts/principal";
import { eventMembers, events, integrations, users } from "contracts/schema";
import type { AirtableConfig } from "contracts/types";
import { drizzle } from "drizzle-orm/d1";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type Authorizer,
  type CurrentUser,
  AppLayer,
  CurrentUser as CurrentUserTag,
  type Db,
} from "@/server/services";
import { configurationTruth } from "./routes/integrations";
import { listIntegrationConfigurations } from "./service";

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

type Requirements = Authorizer | CurrentUser | Db;

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
    throw new Error(`Unexpected Effect failure: ${result.left._tag}`);
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
  await db.insert(integrations).values({
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
  }).run();
});

describe("integrations configuration service", () => {
  it("resolves event IDs and slugs before enforcing organizer authorization", async () => {
    await expect(runAs(owner, listIntegrationConfigurations(targetEventSlug))).resolves.toHaveLength(1);
    await expect(runAs(admin, listIntegrationConfigurations(targetEventId))).resolves.toHaveLength(1);
    await expectFailure(reviewer, listIntegrationConfigurations(targetEventId), "Forbidden");
    await expectFailure(outsider, listIntegrationConfigurations(targetEventId), "Forbidden");

    const readKey = apiKeyPrincipal("integrations-read", targetEventId, ["integrations:read"]);
    const writeKey = apiKeyPrincipal("integrations-write", targetEventId, ["integrations:write"]);
    const crossEventKey = apiKeyPrincipal("integrations-other", otherEventId, ["integrations:read"]);
    await expect(runAs(readKey, listIntegrationConfigurations(targetEventId))).resolves.toHaveLength(1);
    await expectFailure(writeKey, listIntegrationConfigurations(targetEventId), "Forbidden");
    await expectFailure(crossEventKey, listIntegrationConfigurations(targetEventId), "Forbidden");
  });

  it("returns validated field maps without secret or runtime metadata", async () => {
    const result = await runAs(owner, listIntegrationConfigurations(targetEventId));
    expect(result).toEqual([airtableConfiguration]);
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
      { kind: "accelevents", accelEventId: "accel-event" },
    ])).toEqual({ airtable: true, accelevents: true });
  });
});
