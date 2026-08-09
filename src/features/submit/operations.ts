import type { AnyOperationDef } from "contracts/operation";
import { eventAuthorization, publicAuthorization } from "contracts/principal";
import {
  CreatePublicSubmissionInput,
  CreatePublicSubmissionOutput,
  GetPublicSubmissionFormInput,
  ListSubmissionsInput,
  PublicSubmissionForm,
  SubmissionPage,
} from "./schema";
import { createPublicSubmission, getPublicSubmissionForm, listSubmissions } from "./service";

const organizerReadAuthorization = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "api-key", scopes: ["submissions:read"] },
);

export const createPublicSubmissionOperation = {
  id: "submit.create",
  kind: "command",
  input: CreatePublicSubmissionInput,
  output: CreatePublicSubmissionOutput,
  authorize: publicAuthorization,
  invoke: createPublicSubmission,
  rest: {
    method: "post",
    path: "/public/events/:eventSlug/forms/:formId/submissions",
    input: {
      path: ["eventSlug", "formId"],
      headers: { idempotencyKey: "Idempotency-Key" },
      body: ["answers"],
    },
    summary: "Create a public submission from an immutable published form",
    successStatus: 201,
  },
  idempotency: "required",
  concurrency: "required",
  emits: ["submit.created"],
} satisfies AnyOperationDef;

export const getPublicSubmissionFormOperation = {
  id: "submit.getPublicForm",
  kind: "query",
  input: GetPublicSubmissionFormInput,
  output: PublicSubmissionForm,
  authorize: publicAuthorization,
  invoke: getPublicSubmissionForm,
  rest: {
    method: "get",
    path: "/public/events/:eventSlug/forms/:formId",
    input: { path: ["eventSlug", "formId"] },
    summary: "Get the current immutable public submission form",
  },
  mcp: {
    name: "submit_get_public_form",
    description: "Inspect the current published version and availability of a public event submission form.",
  },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} satisfies AnyOperationDef;

export const listSubmissionsOperation = {
  id: "submit.list",
  kind: "query",
  input: ListSubmissionsInput,
  output: SubmissionPage,
  authorize: organizerReadAuthorization,
  invoke: listSubmissions,
  rest: {
    method: "get",
    path: "/events/:eventId/submissions",
    input: {
      path: ["eventId"],
      query: ["status", "formId", "category", "page", "pageSize"],
    },
    summary: "List and filter organizer-visible submissions",
  },
  mcp: {
    name: "submit_list",
    description: "List event submissions with lifecycle, routing category, form, and primary speaker state.",
  },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} satisfies AnyOperationDef;

/** Operation IDs are kept in bytewise ascending order for deterministic registry generation. */
export const operations = [
  createPublicSubmissionOperation,
  getPublicSubmissionFormOperation,
  listSubmissionsOperation,
] as const satisfies readonly AnyOperationDef[];
