import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import type { AppError } from "contracts/errors";
import type { BrowserSessionPrincipal, EventApiKeyPrincipal } from "contracts/principal";
import { eventMembers, events, installGrants, users } from "contracts/schema";
import { Cause, Effect, Exit, Layer } from "effect";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it } from "vitest";
import { getEvent, listEventAccess } from "@/features/events/service";
import { AppLayer, CurrentUser } from "@/server/services";
import { operationEffect, runEffect } from "@/server/adapt";
import { operations } from "./operations";
import { grantInstallStaff, listInstallGrants, revokeInstallStaff } from "./service";

type TestEnv = Cloudflare.Env & { readonly TEST_MIGRATIONS: readonly D1Migration[] };
const expiresAt = Date.UTC(2100, 0, 1);
const staff: BrowserSessionPrincipal = {
  kind: "browser-session",
  userId: "install-staff-primary",
  email: "staff-primary@example.com",
  name: "Primary Staff",
  sessionId: "session-install-staff-primary",
  expiresAt,
  installRole: "staff",
};
const returningStaff: BrowserSessionPrincipal = {
  kind: "browser-session",
  userId: "install-staff-returning",
  email: "staff-returning@example.com",
  name: "Returning Staff",
  sessionId: "session-install-staff-returning",
  expiresAt,
};
const eventOwner: BrowserSessionPrincipal = {
  kind: "browser-session",
  userId: "install-event-owner",
  email: "event-owner@example.com",
  name: "Event Owner",
  sessionId: "session-install-event-owner",
  expiresAt,
};

const configuredEnv = new Proxy(env, {
  get(target, property, receiver) {
    return property === "INITIAL_ADMIN_EMAIL"
      ? staff.email
      : Reflect.get(target, property, receiver);
  },
}) as Cloudflare.Env;

const runEither = <A, R>(
  runtime: Cloudflare.Env,
  principal: BrowserSessionPrincipal | EventApiKeyPrincipal,
  effect: Effect.Effect<A, AppError, R>,
) => Effect.runPromise(effect.pipe(
  Effect.either,
  Effect.provide(Layer.merge(AppLayer(runtime), Layer.succeed(CurrentUser, principal))),
) as Effect.Effect<import("effect").Either.Either<A, AppError>, never, never>);

const run = async <A, R>(
  principal: BrowserSessionPrincipal | EventApiKeyPrincipal,
  effect: Effect.Effect<A, AppError, R>,
): Promise<A> => {
  const result = await runEither(configuredEnv, principal, effect);
  if (result._tag === "Left") throw new Error(`Unexpected ${result.left._tag}`);
  return result.right;
};

beforeAll(async () => {
  if (!("TEST_MIGRATIONS" in env)) throw new Error("TEST_MIGRATIONS binding missing");
  await applyD1Migrations(env.DB, [...(env as TestEnv).TEST_MIGRATIONS]);
  const now = new Date("2026-08-12T12:00:00.000Z");
  const db = drizzle(env.DB);
  await db.insert(users).values([staff, returningStaff, eventOwner].map((principal) => ({
    id: principal.userId,
    email: principal.email,
    name: principal.name,
    createdAt: now,
    updatedAt: now,
  })));
  await db.insert(installGrants).values({
    id: "bootstrap-install-staff",
    userId: staff.userId,
    role: "staff",
    grantedByUserId: staff.userId,
    grantedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(events).values([
    { id: "install-event-one", slug: "install-event-one", name: "Install event one", createdAt: now, updatedAt: now },
    { id: "install-event-two", slug: "install-event-two", name: "Install event two", createdAt: now, updatedAt: now },
  ]);
  await db.insert(eventMembers).values([
    { id: "install-event-one-owner", eventId: "install-event-one", userId: eventOwner.userId, role: "owner", createdAt: now, updatedAt: now },
    { id: "install-event-two-owner", eventId: "install-event-two", userId: eventOwner.userId, role: "owner", createdAt: now, updatedAt: now },
  ]);
});

describe("install staff spine", () => {
  it("keeps install staff administration out of MCP and Party transports", () => {
    expect(operations.every((operation) => !("mcp" in operation) && !("party" in operation))).toBe(true);
  });

  it("refuses staff operations with the named error when open registration is enabled", async () => {
    const operation = operations.find((candidate) => candidate.id === "install.grantStaff");
    if (!operation) throw new Error("install.grantStaff operation missing");
    const result = await runEffect(env, staff, operationEffect(operation, {
      email: returningStaff.email,
      idempotencyKey: "open-registration-grant-refusal",
    }, staff));
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isSuccess(result)) throw new Error("Expected open-registration refusal");
    expect(Cause.failureOption(result.cause)).toEqual(expect.objectContaining({
      _tag: "Some",
      value: expect.objectContaining({ _tag: "OpenRegistrationStaffUnavailable" }),
    }));
  });

  it("grants idempotently, exposes audited history, and revokes immediately", async () => {
    const input = {
      email: `  ${returningStaff.email.toUpperCase()}  `,
      idempotencyKey: "grant-returning-install-staff",
    } as const;
    const granted = await run(staff, grantInstallStaff(input));
    const replay = await run(staff, grantInstallStaff(input));
    expect(granted).toMatchObject({ created: true, idempotent: false, grant: { email: returningStaff.email, role: "staff", version: 1 } });
    expect(replay).toMatchObject({ created: true, idempotent: true, grant: { id: granted.grant.id } });

    const history = await run(staff, listInstallGrants());
    expect(history).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: granted.grant.id, grantedByUserId: staff.userId, revokedAt: null }),
      expect.objectContaining({ id: "bootstrap-install-staff", userId: staff.userId }),
    ]));

    const access = await run(returningStaff, listEventAccess());
    expect(access.map(({ event, staff: isStaff, memberRole }) => ({ id: event.id, isStaff, memberRole })))
      .toEqual([
        { id: "install-event-one", isStaff: true, memberRole: null },
        { id: "install-event-two", isStaff: true, memberRole: null },
      ]);
    await expect(run(returningStaff, getEvent("install-event-two")))
      .resolves.toEqual(expect.objectContaining({ id: "install-event-two" }));

    const crossEventKey: EventApiKeyPrincipal = {
      kind: "api-key",
      userId: "api-key:install-event-one-key",
      apiKeyId: "install-event-one-key",
      eventId: "install-event-one",
      name: "Event one only",
      scopes: ["event:read"],
      expiresAt,
    };
    const denied = await runEither(configuredEnv, crossEventKey, getEvent("install-event-two"));
    expect(denied).toEqual(expect.objectContaining({ _tag: "Left", left: expect.objectContaining({ _tag: "Forbidden" }) }));
    const installDenied = await runEffect(configuredEnv, crossEventKey, operationEffect(
      operations.find((candidate) => candidate.id === "install.listStaff")!,
      {},
      crossEventKey,
    ));
    expect(Exit.isFailure(installDenied)).toBe(true);
    if (Exit.isSuccess(installDenied)) throw new Error("Expected browser-only install denial");
    expect(Cause.failureOption(installDenied.cause)).toEqual(expect.objectContaining({
      _tag: "Some",
      value: expect.objectContaining({ _tag: "Forbidden" }),
    }));

    const revoked = await run(staff, revokeInstallStaff({
      grantId: granted.grant.id,
      expectedVersion: granted.grant.version,
      idempotencyKey: "revoke-returning-install-staff",
    }));
    expect(revoked).toMatchObject({ revoked: true, idempotent: false, grant: { version: 2, revokedByUserId: staff.userId } });
    const afterRevocation = await runEither(configuredEnv, returningStaff, getEvent("install-event-two"));
    expect(afterRevocation).toEqual(expect.objectContaining({ _tag: "Left", left: expect.objectContaining({ _tag: "Forbidden" }) }));
    const lastStaff = await runEither(configuredEnv, staff, revokeInstallStaff({
      grantId: "bootstrap-install-staff",
      expectedVersion: 1,
      idempotencyKey: "retain-final-install-staff",
    }));
    expect(lastStaff).toEqual(expect.objectContaining({
      _tag: "Left",
      left: expect.objectContaining({ _tag: "Conflict" }),
    }));
  });
});
