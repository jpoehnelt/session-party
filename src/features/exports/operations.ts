import type { AnyOperationDef } from "contracts/operation";
import { eventAuthorization } from "contracts/principal";
import { GetInstitutionalArchiveInput, InstitutionalArchive } from "./schema";
import { getInstitutionalArchive } from "./service";

const exportAuthorization = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "deny" },
);

export const getArchiveOperation = {
  id: "exports.getArchive",
  kind: "query",
  input: GetInstitutionalArchiveInput,
  output: InstitutionalArchive,
  authorize: exportAuthorization,
  invoke: getInstitutionalArchive,
  rest: {
    method: "get",
    path: "/events/:eventId/exports/archive",
    input: { path: ["eventId"] },
    summary: "Export the event's durable institutional record",
    description: "Returns stable event, speaker, submission, session, decision, review, and onboarding identifiers in one versioned JSON archive.",
  },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} as const satisfies AnyOperationDef;

export const operations = [getArchiveOperation] as const satisfies readonly AnyOperationDef[];
