import type { AnyOperationDef } from "contracts/operation";
import { installStaffAuthorization } from "contracts/principal";
import { Schema } from "effect";
import {
  GrantInstallStaffInput,
  GrantInstallStaffOutput,
  InstallGrant,
  ListInstallGrantsInput,
  RevokeInstallStaffInput,
  RevokeInstallStaffOutput,
} from "./schema";
import { grantInstallStaff, listInstallGrants, revokeInstallStaff } from "./service";

export const operations = [
  {
    id: "install.listStaff", kind: "query", input: ListInstallGrantsInput, output: Schema.Array(InstallGrant),
    authorize: installStaffAuthorization, invoke: listInstallGrants,
    rest: { method: "get", path: "/install/staff", input: {}, summary: "List install staff grant history", successStatus: 200 },
    idempotency: "none", concurrency: "none", emits: [],
  } satisfies AnyOperationDef,
  {
    id: "install.grantStaff", kind: "command", input: GrantInstallStaffInput, output: GrantInstallStaffOutput,
    authorize: installStaffAuthorization, invoke: grantInstallStaff,
    rest: { method: "post", path: "/install/staff", input: { body: ["email", "idempotencyKey"] }, summary: "Grant install-wide staff authority", successStatus: 201 },
    idempotency: "required", concurrency: "none", emits: [],
  } satisfies AnyOperationDef,
  {
    id: "install.revokeStaff", kind: "command", input: RevokeInstallStaffInput, output: RevokeInstallStaffOutput,
    authorize: installStaffAuthorization, invoke: revokeInstallStaff,
    rest: { method: "delete", path: "/install/staff/:grantId", input: { path: ["grantId"], body: ["expectedVersion", "idempotencyKey"] }, summary: "Revoke install-wide staff authority", successStatus: 200 },
    idempotency: "required", concurrency: "required", emits: [],
  } satisfies AnyOperationDef,
] as const;
