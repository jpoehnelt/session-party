import type { AnyOperationDef } from "contracts/operation";
import { browserSessionAuthorization, eventAuthorization, publicAuthorization } from "contracts/principal";
import {
  CreatePublicSubmissionInput,
  CreatePublicSubmissionOutput,
  CreateTaskSubmissionInput,
  GetOwnSubmissionsInput,
  GetPublicSubmissionFormInput,
  ListSubmissionsInput,
  OwnSubmissions,
  PublicSubmissionForm,
  SubmissionPage,
  UpdateOwnSubmissionAbstractInput,
  UpdateOwnSubmissionAbstractOutput,
} from "./schema";
import {
  createPublicSubmission,
  createTaskSubmission,
  getOwnSubmissions,
  getPublicSubmissionForm,
  listSubmissions,
  updateOwnSubmissionAbstract,
} from "./service";

const organizerReadAuthorization = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin", "reviewer"] },
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
      body: ["answers", "turnstileToken"],
    },
    summary: "Create a public submission from an immutable published form",
    successStatus: 201,
  },
  idempotency: "required",
  concurrency: "required",
  emits: ["submit.created"],
} satisfies AnyOperationDef;

export const createTaskSubmissionOperation = {
  id: "submit.createTask",
  kind: "command",
  input: CreateTaskSubmissionInput,
  output: CreatePublicSubmissionOutput,
  authorize: browserSessionAuthorization,
  invoke: createTaskSubmission,
  rest: {
    method: "post",
    path: "/events/:eventId/portal/forms/:formId/submissions",
    input: {
      path: ["eventId", "formId"],
      headers: { idempotencyKey: "Idempotency-Key" },
      body: ["answers"],
    },
    summary: "Submit an immutable task form as the exact provisioned speaker",
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
  idempotency: "none",
  concurrency: "none",
  emits: [],
} satisfies AnyOperationDef;

export const getOwnSubmissionsOperation = {
  id: "submit.getOwn",
  kind: "query",
  input: GetOwnSubmissionsInput,
  output: OwnSubmissions,
  authorize: browserSessionAuthorization,
  invoke: getOwnSubmissions,
  rest: {
    method: "get",
    path: "/events/by-slug/:eventSlug/my-submissions",
    input: { path: ["eventSlug"] },
    summary: "List CFP submissions owned by the signed-in account",
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

export const updateOwnSubmissionAbstractOperation = {
  id: "submit.updateOwnAbstract",
  kind: "command",
  input: UpdateOwnSubmissionAbstractInput,
  output: UpdateOwnSubmissionAbstractOutput,
  authorize: browserSessionAuthorization,
  invoke: updateOwnSubmissionAbstract,
  rest: {
    method: "put",
    path: "/events/by-slug/:eventSlug/my-submissions/:submissionId/abstract",
    input: {
      path: ["eventSlug", "submissionId"],
      headers: { idempotencyKey: "idempotency-key" },
      body: ["abstract", "expectedVersion"],
    },
    summary: "Edit an owned proposal abstract while its CFP remains open",
    successStatus: 200,
  },
  idempotency: "required",
  concurrency: "required",
  emits: ["submit.abstract.updated"],
} satisfies AnyOperationDef;

/** Operation IDs are kept in bytewise ascending order for deterministic registry generation. */
export const operations = [
  createPublicSubmissionOperation,
  createTaskSubmissionOperation,
  getOwnSubmissionsOperation,
  getPublicSubmissionFormOperation,
  listSubmissionsOperation,
  updateOwnSubmissionAbstractOperation,
] as const satisfies readonly AnyOperationDef[];
