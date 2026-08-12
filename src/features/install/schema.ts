import { EntityId } from "contracts/domain";
import { InstallRole } from "contracts/principal";
import { Schema } from "effect";

const Email = Schema.String.pipe(Schema.minLength(3), Schema.maxLength(320));
const IdempotencyKey = Schema.String.pipe(Schema.minLength(8), Schema.maxLength(200));

export const InstallGrant = Schema.Struct({
  id: EntityId,
  userId: EntityId,
  email: Email,
  name: Schema.NullOr(Schema.String),
  role: InstallRole,
  grantedByUserId: EntityId,
  grantedByEmail: Email,
  grantedAt: Schema.DateFromString,
  revokedByUserId: Schema.NullOr(EntityId),
  revokedByEmail: Schema.NullOr(Email),
  revokedAt: Schema.NullOr(Schema.DateFromString),
  version: Schema.Int.pipe(Schema.positive()),
});
export type InstallGrant = typeof InstallGrant.Type;

export const ListInstallGrantsInput = Schema.Struct({});
export type ListInstallGrantsInput = typeof ListInstallGrantsInput.Type;

export const GrantInstallStaffInput = Schema.Struct({
  email: Email,
  idempotencyKey: IdempotencyKey,
});
export type GrantInstallStaffInput = typeof GrantInstallStaffInput.Type;

export const GrantInstallStaffOutput = Schema.Struct({
  grant: InstallGrant,
  created: Schema.Boolean,
  idempotent: Schema.Boolean,
});
export type GrantInstallStaffOutput = typeof GrantInstallStaffOutput.Type;

export const RevokeInstallStaffInput = Schema.Struct({
  grantId: EntityId,
  expectedVersion: Schema.Int.pipe(Schema.positive()),
  idempotencyKey: IdempotencyKey,
});
export type RevokeInstallStaffInput = typeof RevokeInstallStaffInput.Type;

export const RevokeInstallStaffOutput = Schema.Struct({
  grant: InstallGrant,
  revoked: Schema.Boolean,
  idempotent: Schema.Boolean,
});
export type RevokeInstallStaffOutput = typeof RevokeInstallStaffOutput.Type;
