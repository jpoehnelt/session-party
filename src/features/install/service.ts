import {
  Conflict,
  External,
  Forbidden,
  NotFound,
  OpenRegistrationStaffUnavailable,
  type AppError,
} from "contracts/errors";
import { installStaffAuthorization } from "contracts/principal";
import { installGrants, users } from "contracts/schema";
import { Effect } from "effect";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  Authorizer,
  CurrentUser,
  Db,
  InstallationConfig,
} from "@/server/services";
import type {
  GrantInstallStaffInput,
  GrantInstallStaffOutput,
  InstallGrant as InstallGrantOutput,
  RevokeInstallStaffInput,
  RevokeInstallStaffOutput,
} from "./schema";

const database = <A>(run: () => Promise<A>): Effect.Effect<A, External> =>
  Effect.tryPromise({
    try: run,
    catch: (error) => new External({
      service: "database",
      detail: error instanceof Error ? error.message : String(error),
    }),
  });

const hash = (value: string): Effect.Effect<string, External> =>
  Effect.tryPromise({
    try: async () => Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join(""),
    catch: (error) => new External({ service: "crypto", detail: String(error) }),
  });

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const requireClosedInstall = (): Effect.Effect<void, OpenRegistrationStaffUnavailable, InstallationConfig> =>
  Effect.gen(function* () {
    const config = yield* InstallationConfig;
    if (config.openRegistration) {
      return yield* Effect.fail(new OpenRegistrationStaffUnavailable({
        reason: "INITIAL_ADMIN_EMAIL is unset",
      }));
    }
  });

const requireStaff = (): Effect.Effect<string, AppError, Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    const principal = yield* CurrentUser;
    const authorizer = yield* Authorizer;
    yield* authorizer.authorize({ principal, policy: installStaffAuthorization, eventId: null });
    if (principal.kind !== "browser-session") {
      return yield* Effect.fail(new Forbidden({ reason: "Staff administration requires a browser session" }));
    }
    return principal.userId;
  });

const grantOutput = (
  row: typeof installGrants.$inferSelect,
  people: ReadonlyMap<string, { readonly email: string; readonly name: string | null }>,
): InstallGrantOutput => {
  const subject = people.get(row.userId);
  const grantor = people.get(row.grantedByUserId);
  const revoker = row.revokedByUserId ? people.get(row.revokedByUserId) : null;
  if (!subject || !grantor || (row.revokedByUserId && !revoker)) {
    throw new Error(`Install grant ${row.id} references unavailable audit actors`);
  }
  return {
    id: row.id,
    userId: row.userId,
    email: normalizeEmail(subject.email),
    name: subject.name,
    role: row.role,
    grantedByUserId: row.grantedByUserId,
    grantedByEmail: normalizeEmail(grantor.email),
    grantedAt: row.grantedAt,
    revokedByUserId: row.revokedByUserId,
    revokedByEmail: revoker ? normalizeEmail(revoker.email) : null,
    revokedAt: row.revokedAt,
    version: row.version,
  };
};

const loadOutputs = (
  rows: readonly (typeof installGrants.$inferSelect)[],
): Effect.Effect<readonly InstallGrantOutput[], External, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const userIds = [...new Set(rows.flatMap((row) => [
      row.userId,
      row.grantedByUserId,
      ...(row.revokedByUserId ? [row.revokedByUserId] : []),
    ]))];
    const people = userIds.length === 0
      ? []
      : yield* database(() => db.select({ id: users.id, email: users.email, name: users.name })
        .from(users).where(inArray(users.id, userIds)));
    const byId = new Map(people.map(({ id, ...person }) => [id, person]));
    return rows.map((row) => grantOutput(row, byId));
  });

const loadGrant = (grantId: string): Effect.Effect<InstallGrantOutput, AppError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [row] = yield* database(() => db.select().from(installGrants)
      .where(eq(installGrants.id, grantId)).limit(1));
    if (!row) return yield* Effect.fail(new NotFound({ entity: "install grant", id: grantId }));
    const [output] = yield* loadOutputs([row]);
    if (!output) return yield* Effect.fail(new External({ service: "database", detail: "Install grant output missing" }));
    return output;
  });

export const listInstallGrants = (): Effect.Effect<
  readonly InstallGrantOutput[],
  AppError,
  Authorizer | CurrentUser | Db | InstallationConfig
> => Effect.gen(function* () {
  yield* requireClosedInstall();
  yield* requireStaff();
  const { db } = yield* Db;
  const rows = yield* database(() => db.select().from(installGrants)
    .orderBy(desc(installGrants.grantedAt), desc(installGrants.id)));
  return yield* loadOutputs(rows);
});

export const grantInstallStaff = (
  input: GrantInstallStaffInput,
): Effect.Effect<GrantInstallStaffOutput, AppError, Authorizer | CurrentUser | Db | InstallationConfig> =>
  Effect.gen(function* () {
    yield* requireClosedInstall();
    const actorUserId = yield* requireStaff();
    const email = normalizeEmail(input.email);
    const keyHash = yield* hash(input.idempotencyKey);
    const requestHash = yield* hash(JSON.stringify({ email, role: "staff" }));
    const { db } = yield* Db;

    const [prior] = yield* database(() => db.select().from(installGrants).where(and(
      eq(installGrants.grantedByUserId, actorUserId),
      eq(installGrants.grantKeyHash, keyHash),
    )).limit(1));
    if (prior) {
      if (prior.grantRequestHash !== requestHash) {
        return yield* Effect.fail(new Conflict({ message: "Idempotency key was already used for a different staff grant" }));
      }
      const grant = yield* loadGrant(prior.id);
      return { grant, created: true, idempotent: true };
    }

    const [target] = yield* database(() => db.select({ id: users.id }).from(users)
      .where(sql`lower(trim(${users.email})) = ${email}`).limit(1));
    if (!target) return yield* Effect.fail(new NotFound({ entity: "authenticated user", id: email }));
    const [active] = yield* database(() => db.select().from(installGrants).where(and(
      eq(installGrants.userId, target.id),
      eq(installGrants.role, "staff"),
      isNull(installGrants.revokedAt),
    )).limit(1));
    if (active) return { grant: yield* loadGrant(active.id), created: false, idempotent: true };

    const at = new Date();
    const row = {
      id: `install_grant_${nanoid()}`,
      userId: target.id,
      role: "staff" as const,
      grantedByUserId: actorUserId,
      grantedAt: at,
      revokedByUserId: null,
      revokedAt: null,
      grantKeyHash: keyHash,
      grantRequestHash: requestHash,
      revokeKeyHash: null,
      revokeRequestHash: null,
      version: 1,
      createdAt: at,
      updatedAt: at,
    };
    const inserted = yield* database(() => db.insert(installGrants).values(row)).pipe(Effect.either);
    if (inserted._tag === "Left") {
      const [winner] = yield* database(() => db.select().from(installGrants).where(and(
        eq(installGrants.userId, target.id), eq(installGrants.role, "staff"), isNull(installGrants.revokedAt),
      )).limit(1));
      if (!winner) return yield* Effect.fail(inserted.left);
      return { grant: yield* loadGrant(winner.id), created: false, idempotent: true };
    }
    return { grant: yield* loadGrant(row.id), created: true, idempotent: false };
  });

export const revokeInstallStaff = (
  input: RevokeInstallStaffInput,
): Effect.Effect<RevokeInstallStaffOutput, AppError, Authorizer | CurrentUser | Db | InstallationConfig> =>
  Effect.gen(function* () {
    yield* requireClosedInstall();
    const actorUserId = yield* requireStaff();
    const keyHash = yield* hash(input.idempotencyKey);
    const requestHash = yield* hash(JSON.stringify({ grantId: input.grantId, expectedVersion: input.expectedVersion }));
    const { db } = yield* Db;
    const [row] = yield* database(() => db.select().from(installGrants)
      .where(eq(installGrants.id, input.grantId)).limit(1));
    if (!row) return yield* Effect.fail(new NotFound({ entity: "install grant", id: input.grantId }));
    if (row.revokeKeyHash === keyHash) {
      if (row.revokeRequestHash !== requestHash) {
        return yield* Effect.fail(new Conflict({ message: "Idempotency key was already used for a different staff revocation" }));
      }
      return { grant: yield* loadGrant(row.id), revoked: true, idempotent: true };
    }
    if (row.revokedAt) return { grant: yield* loadGrant(row.id), revoked: false, idempotent: true };
    if (row.version !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({ message: "Staff grant changed; reload before revoking" }));
    }

    const at = new Date();
    const [updated] = yield* database(() => db.update(installGrants).set({
      revokedByUserId: actorUserId,
      revokedAt: at,
      revokeKeyHash: keyHash,
      revokeRequestHash: requestHash,
      version: input.expectedVersion + 1,
      updatedAt: at,
    }).where(and(
      eq(installGrants.id, row.id),
      eq(installGrants.version, input.expectedVersion),
      isNull(installGrants.revokedAt),
      sql`(select count(*) from install_grants where role = 'staff' and revoked_at is null) > 1`,
    )).returning());
    if (!updated) {
      const [current] = yield* database(() => db.select().from(installGrants)
        .where(eq(installGrants.id, row.id)).limit(1));
      if (current?.revokedAt) return { grant: yield* loadGrant(row.id), revoked: false, idempotent: true };
      return yield* Effect.fail(new Conflict({ message: "An installation must retain at least one active staff account" }));
    }
    return { grant: yield* loadGrant(row.id), revoked: true, idempotent: false };
  });
