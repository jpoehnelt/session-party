import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import type { AppError } from "contracts/errors";
import type { BrowserSessionPrincipal, EventApiKeyPrincipal } from "contracts/principal";
import {
  eventMembers,
  events,
  forms,
  formVersions,
  installGrants,
  managedSpeakerEmails,
  speakerContacts,
  speakerProfiles,
  speakers,
  submissionSpeakers,
  submissions,
  talks,
  talkSpeakers,
  users,
} from "contracts/schema";
import { Effect, Exit, Layer } from "effect";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it } from "vitest";
import { operationEffect, runEffect } from "@/server/adapt";
import { AppLayer, CurrentUser } from "@/server/services";
import { operations } from "./operations";
import { listSpeakerDirectory } from "./service";

type TestEnv = Cloudflare.Env & { readonly TEST_MIGRATIONS: readonly D1Migration[] };
const expiresAt = Date.UTC(2100, 0, 1);
const principal = (userId: string, email: string, name: string): BrowserSessionPrincipal => ({
  kind: "browser-session",
  userId,
  email,
  name,
  sessionId: `session-${userId}`,
  expiresAt,
});
const staff = principal("directory-staff", "directory-staff@example.com", "Directory Staff");
const admin = principal("directory-admin", "directory-admin@example.com", "Event Admin");
const claimed = principal("directory-claimed", "ada@example.com", "Ada Lovelace");
const sameName = principal("directory-same-name", "ada.other@example.com", "Ada Lovelace");

const configuredEnv = new Proxy(env, {
  get(target, property, receiver) {
    return property === "INITIAL_ADMIN_EMAIL" ? staff.email : Reflect.get(target, property, receiver);
  },
}) as Cloudflare.Env;

const runEither = <A>(
  actor: BrowserSessionPrincipal | EventApiKeyPrincipal,
  effect: Effect.Effect<A, AppError, CurrentUser | import("@/server/services").Authorizer | import("@/server/services").Db>,
) => Effect.runPromise(effect.pipe(
  Effect.either,
  Effect.provide(Layer.merge(AppLayer(configuredEnv), Layer.succeed(CurrentUser, actor))),
));

const run = async <A>(actor: BrowserSessionPrincipal, effect: Parameters<typeof runEither<A>>[1]): Promise<A> => {
  const result = await runEither(actor, effect);
  if (result._tag === "Left") throw new Error(`Unexpected ${result.left._tag}`);
  return result.right;
};

beforeAll(async () => {
  if (!("TEST_MIGRATIONS" in env)) throw new Error("TEST_MIGRATIONS binding missing");
  await applyD1Migrations(env.DB, [...(env as TestEnv).TEST_MIGRATIONS]);
  const db = drizzle(env.DB);
  const now = new Date("2026-08-12T12:00:00.000Z");
  await db.insert(users).values([staff, admin, claimed, sameName].map((actor) => ({
    id: actor.userId,
    email: actor.email,
    name: actor.name,
    createdAt: now,
    updatedAt: now,
  })));
  await db.insert(installGrants).values({
    id: "directory-staff-grant",
    userId: staff.userId,
    role: "staff",
    grantedByUserId: staff.userId,
    grantedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(events).values([
    { id: "directory-event-a", slug: "directory-event-a", name: "First Summit", createdAt: now, updatedAt: now },
    { id: "directory-event-b", slug: "directory-event-b", name: "Second Summit", createdAt: now, updatedAt: now },
  ]);
  await db.insert(eventMembers).values([
    { id: "directory-admin-a", eventId: "directory-event-a", userId: admin.userId, role: "admin", createdAt: now, updatedAt: now },
    { id: "directory-admin-b", eventId: "directory-event-b", userId: admin.userId, role: "admin", createdAt: now, updatedAt: now },
  ]);
  await db.insert(forms).values([
    { id: "directory-form-a", eventId: "directory-event-a", kind: "cfp", name: "First CFP", status: "closed", createdAt: now, updatedAt: now },
    { id: "directory-form-b", eventId: "directory-event-b", kind: "cfp", name: "Second CFP", status: "closed", createdAt: now, updatedAt: now },
  ]);
  await db.insert(formVersions).values([
    { id: "directory-form-version-a", eventId: "directory-event-a", formId: "directory-form-a", versionNumber: 1, name: "First CFP", publishedAt: now, createdAt: now },
    { id: "directory-form-version-b", eventId: "directory-event-b", formId: "directory-form-b", versionNumber: 1, name: "Second CFP", publishedAt: now, createdAt: now },
  ]);
  await db.insert(speakerProfiles).values({
    id: "directory-reusable-profile",
    userId: claimed.userId,
    slug: "ada-lovelace-directory",
    displayName: "Ada Lovelace",
    title: "Principal mathematician",
    company: "Analytical Engines",
    bio: "Computing pioneer and recurring speaker.",
    headshotUrl: "https://example.com/ada.jpg",
    links: [{ label: "Profile", url: "https://example.com/ada" }],
    visible: true,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(speakers).values([
    {
      id: "directory-speaker-claimed",
      eventId: "directory-event-a",
      userId: claimed.userId,
      contactEmail: claimed.email,
      displayName: "Ada Lovelace",
      title: "Mathematician",
      company: "Analytical Engines",
      bio: "First event snapshot",
      profileSourceId: "directory-reusable-profile",
      profileSourceVersion: 1,
      profileReviewStatus: "approved",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "directory-speaker-managed",
      eventId: "directory-event-b",
      contactEmail: " ADA@example.com ",
      displayName: "Ada Lovelace",
      title: "Guest speaker",
      company: "Analytical Engines",
      bio: "Managed identity before account linking",
      profileReviewStatus: "draft",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "directory-speaker-same-name",
      eventId: "directory-event-a",
      userId: sameName.userId,
      contactEmail: sameName.email,
      displayName: "Ada Lovelace",
      title: "Different person",
      profileReviewStatus: "approved",
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.insert(managedSpeakerEmails).values({
    id: "directory-managed-email",
    eventId: "directory-event-b",
    normalizedEmail: "ada@example.com",
    speakerId: "directory-speaker-managed",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(submissions).values([
    { id: "directory-submission-a", eventId: "directory-event-a", formId: "directory-form-a", formVersionId: "directory-form-version-a", title: "Machines that reason", status: "accepted", submittedAt: now, acceptedAt: now, createdAt: now, updatedAt: now },
    { id: "directory-submission-b", eventId: "directory-event-b", formId: "directory-form-b", formVersionId: "directory-form-version-b", title: "Engines revisited", status: "submitted", submittedAt: now, createdAt: now, updatedAt: now },
    { id: "directory-submission-c", eventId: "directory-event-a", formId: "directory-form-a", formVersionId: "directory-form-version-a", title: "A different Ada", status: "submitted", submittedAt: now, createdAt: now, updatedAt: now },
  ]);
  await db.insert(submissionSpeakers).values([
    { id: "directory-association-a", eventId: "directory-event-a", submissionId: "directory-submission-a", speakerId: "directory-speaker-claimed", isPrimary: true, createdAt: now },
    { id: "directory-association-b", eventId: "directory-event-b", submissionId: "directory-submission-b", speakerId: "directory-speaker-managed", isPrimary: true, createdAt: now },
    { id: "directory-association-c", eventId: "directory-event-a", submissionId: "directory-submission-c", speakerId: "directory-speaker-same-name", isPrimary: true, createdAt: now },
  ]);
  await db.insert(talks).values({
    id: "directory-talk-b",
    eventId: "directory-event-b",
    submissionId: "directory-submission-b",
    title: "Engines revisited",
    startsAt: new Date("2026-07-01T12:00:00.000Z"),
    status: "confirmed",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(talkSpeakers).values({
    id: "directory-talk-speaker-b",
    eventId: "directory-event-b",
    talkId: "directory-talk-b",
    speakerId: "directory-speaker-managed",
    createdAt: now,
  });
  await db.insert(speakerContacts).values({
    id: "directory-contact-b",
    eventId: "directory-event-b",
    speakerId: "directory-speaker-managed",
    actorUserId: staff.userId,
    medium: "personalEmail",
    note: "Asked about returning next year.",
    contactedAt: now,
    createdAt: now,
  });
});

describe("installation speaker directory", () => {
  it("groups only by normalized email while preserving member identities, histories, contacts, and same-name suggestions", async () => {
    const result = await run(staff, listSpeakerDirectory({ page: 1, pageSize: 25 }));
    expect(result.total).toBe(2);
    expect(result.events.map((event) => event.name)).toEqual(["First Summit", "Second Summit"]);
    const ada = result.entries.find((entry) => entry.normalizedEmail === "ada@example.com");
    expect(ada).toMatchObject({
      displayName: "Ada Lovelace",
      reusableProfile: { company: "Analytical Engines", version: 1 },
      members: [
        expect.objectContaining({ speakerId: "directory-speaker-claimed", kind: "claimed" }),
        expect.objectContaining({ speakerId: "directory-speaker-managed", kind: "managed" }),
      ],
      contacts: [expect.objectContaining({ id: "directory-contact-b", medium: "personalEmail" })],
    });
    expect(ada?.participation).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventId: "directory-event-a", submitted: true, accepted: true, spoke: false }),
      expect.objectContaining({ eventId: "directory-event-b", submitted: true, accepted: false, spoke: true }),
    ]));
    expect(ada?.sameNameSuggestions).toEqual([
      expect.objectContaining({ normalizedEmail: "ada.other@example.com" }),
    ]);
    const other = result.entries.find((entry) => entry.normalizedEmail === "ada.other@example.com");
    expect(other?.members).toHaveLength(1);
    expect(other?.sameNameSuggestions).toEqual([expect.objectContaining({ normalizedEmail: "ada@example.com" })]);
  });

  it("searches profile fields, filters participation, and paginates grouped identities", async () => {
    await expect(run(staff, listSpeakerDirectory({ query: "analytical engines", page: 1, pageSize: 25 })))
      .resolves.toMatchObject({ total: 1, entries: [expect.objectContaining({ normalizedEmail: "ada@example.com" })] });
    await expect(run(staff, listSpeakerDirectory({ eventId: "directory-event-b", status: "spoke", page: 1, pageSize: 25 })))
      .resolves.toMatchObject({ total: 1, entries: [expect.objectContaining({ normalizedEmail: "ada@example.com" })] });
    const first = await run(staff, listSpeakerDirectory({ page: 1, pageSize: 1 }));
    const second = await run(staff, listSpeakerDirectory({ page: 2, pageSize: 1 }));
    expect(first).toMatchObject({ total: 2, page: 1, pageSize: 1, hasMore: true });
    expect(second).toMatchObject({ total: 2, page: 2, pageSize: 1, hasMore: false });
    expect(first.entries[0]?.groupKey).not.toBe(second.entries[0]?.groupKey);
  });

  it("denies event admins and event-scoped API keys and has no MCP or Party projection", async () => {
    const denied = await runEither(admin, listSpeakerDirectory({}));
    expect(denied).toEqual(expect.objectContaining({ _tag: "Left", left: expect.objectContaining({ _tag: "Forbidden" }) }));
    const operation = operations.find((candidate) => candidate.id === "directory.listSpeakers");
    if (!operation) throw new Error("directory.listSpeakers operation missing");
    expect("mcp" in operation).toBe(false);
    expect("party" in operation).toBe(false);
    const key: EventApiKeyPrincipal = {
      kind: "api-key",
      userId: "api-key:directory-key",
      apiKeyId: "directory-key",
      eventId: "directory-event-a",
      name: "Directory key",
      scopes: ["event:read", "speakers:read"],
      expiresAt,
    };
    const exit = await runEffect(configuredEnv, key, operationEffect(operation, {}, key));
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
