import { env, applyD1Migrations, type D1Migration } from "cloudflare:test";
import { eventMembers, events } from "contracts/schema";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it } from "vitest";
import { type Db, AppLayer, CurrentUser, type CurrentUserValue } from "@/server/services";
import { Effect, Layer } from "effect";
import { createEvent, getEvent, listEvents, updateEvent } from "./service";

type TestEnv = Cloudflare.Env & {
  readonly TEST_MIGRATIONS: readonly D1Migration[];
};

function hasTestMigrations(env: Cloudflare.Env): env is TestEnv {
  return "TEST_MIGRATIONS" in env;
}

const owner: CurrentUserValue = {
  userId: "user-owner",
  email: "owner@example.com",
  name: "Owner",
};

const runAs = <A, E>(user: CurrentUserValue, effect: Effect.Effect<A, E, Db | CurrentUser>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUser, user))),
    ),
  );

beforeAll(async () => {
  if (!hasTestMigrations(env)) {
    throw new Error("TEST_MIGRATIONS test binding is unavailable");
  }

  await applyD1Migrations(env.DB, [...env.TEST_MIGRATIONS]);
});

describe("events service", () => {
  it("creates, lists, and gets an event", async () => {
    const created = await runAs(
      owner,
      createEvent({ name: "Effect Summit", slug: "effect-summit" }),
    );

    expect(created.slug).toBe("effect-summit");
    await expect(runAs(owner, listEvents())).resolves.toEqual([created]);
    await expect(runAs(owner, getEvent(created.id))).resolves.toEqual(created);
    await expect(runAs(owner, getEvent(created.slug))).resolves.toEqual(created);
  });

  it("fails with Conflict for a duplicate slug", async () => {
    await runAs(owner, createEvent({ name: "First", slug: "duplicate-event" }));
    const result = await Effect.runPromise(
      createEvent({ name: "Second", slug: "duplicate-event" }).pipe(
        Effect.either,
        Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUser, owner))),
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left._tag).toBe("Conflict");
  });

  it("forbids updates by a non-member", async () => {
    const created = await runAs(owner, createEvent({ name: "Private", slug: "private-event" }));
    const outsider: CurrentUserValue = {
      userId: "user-outsider",
      email: "outside@example.com",
      name: "Outsider",
    };
    const result = await Effect.runPromise(
      updateEvent(created.id, { name: "Changed" }).pipe(
        Effect.either,
        Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUser, outsider))),
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left._tag).toBe("Forbidden");

    const db = drizzle(env.DB);
    const memberships = await db
      .select()
      .from(eventMembers)
      .where(and(eq(eventMembers.eventId, created.id), eq(eventMembers.userId, outsider.userId)));
    expect(memberships).toHaveLength(0);

    const [event] = await db.select().from(events).where(eq(events.id, created.id)).limit(1);
    expect(event?.name).toBe(created.name);
  });
});

