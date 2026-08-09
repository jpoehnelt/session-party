import type { AnyOperationDef } from "contracts/operation";
import { eventAuthorization } from "contracts/principal";
import {
  CreateFormInput,
  DeleteFormInput,
  DeleteFormOutput,
  FormDetail,
  FormList,
  GetFormInput,
  ListFormsInput,
  PublishFormInput,
  SetFormStatusInput,
  UpdateFormInput,
} from "./schema";
import { createForm, deleteForm, getForm, listForms, publishForm, setFormStatus, updateForm } from "./service";

const readAuthorization = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "api-key", scopes: ["forms:read"] },
);

const writeAuthorization = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "api-key", scopes: ["forms:write"] },
);

export const createFormOperation = {
  id: "forms.create",
  kind: "command",
  input: CreateFormInput,
  output: FormDetail,
  authorize: writeAuthorization,
  invoke: createForm,
  rest: {
    method: "post",
    path: "/events/:eventId/forms",
    input: {
      path: ["eventId"],
      headers: { idempotencyKey: "Idempotency-Key" },
      body: ["purpose", "name", "description", "opensAt", "closesAt", "fields"],
    },
    summary: "Create a draft event form",
    successStatus: 201,
  },
  mcp: {
    name: "forms_create_draft",
    description: "Create a draft primary CFP or additional organizer form. This does not publish or open it.",
  },
  idempotency: "required",
  concurrency: "required",
  emits: ["forms.primaryClaim", "forms.versionClaim", "forms.created"],
} satisfies AnyOperationDef;

export const deleteFormOperation = {
  id: "forms.deleteDraft",
  kind: "command",
  input: DeleteFormInput,
  output: DeleteFormOutput,
  authorize: writeAuthorization,
  invoke: deleteForm,
  rest: {
    method: "delete",
    path: "/events/:eventId/forms/:formId",
    input: {
      path: ["eventId", "formId"],
      headers: { expectedVersion: "If-Match", idempotencyKey: "Idempotency-Key" },
    },
    summary: "Delete an unpublished additional-form draft",
    description: "Primary CFPs and any form that has been published or linked to onboarding are retained.",
  },
  mcp: {
    name: "forms_delete_draft",
    description: "Delete an unpublished additional-form draft with optimistic concurrency.",
  },
  idempotency: "required",
  concurrency: "required",
  emits: ["forms.versionClaim", "forms.deleted"],
} satisfies AnyOperationDef;

export const getFormOperation = {
  id: "forms.get",
  kind: "query",
  input: GetFormInput,
  output: FormDetail,
  authorize: readAuthorization,
  invoke: getForm,
  rest: {
    method: "get",
    path: "/events/:eventId/forms/:formId",
    input: { path: ["eventId", "formId"] },
    summary: "Get a draft form and its latest immutable published version",
  },
  mcp: {
    name: "forms_get",
    description: "Inspect a form draft and the latest published snapshot for safe organizer automation.",
  },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} satisfies AnyOperationDef;

export const listFormsOperation = {
  id: "forms.list",
  kind: "query",
  input: ListFormsInput,
  output: FormList,
  authorize: readAuthorization,
  invoke: listForms,
  rest: {
    method: "get",
    path: "/events/:eventId/forms",
    input: { path: ["eventId"] },
    summary: "List event forms",
  },
  mcp: {
    name: "forms_list",
    description: "List form lifecycle state and published version numbers for an event.",
  },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} satisfies AnyOperationDef;

export const publishFormOperation = {
  id: "forms.publish",
  kind: "command",
  input: PublishFormInput,
  output: FormDetail,
  authorize: writeAuthorization,
  invoke: publishForm,
  rest: {
    method: "post",
    path: "/events/:eventId/forms/:formId/publish",
    input: {
      path: ["eventId", "formId"],
      headers: { expectedVersion: "If-Match", idempotencyKey: "Idempotency-Key" },
    },
    summary: "Publish an immutable form snapshot",
  },
  idempotency: "required",
  concurrency: "required",
  emits: ["forms.versionClaim", "forms.published"],
} satisfies AnyOperationDef;

export const setFormStatusOperation = {
  id: "forms.setStatus",
  kind: "command",
  input: SetFormStatusInput,
  output: FormDetail,
  authorize: writeAuthorization,
  invoke: setFormStatus,
  rest: {
    method: "post",
    path: "/events/:eventId/forms/:formId/status",
    input: {
      path: ["eventId", "formId"],
      headers: { expectedVersion: "If-Match", idempotencyKey: "Idempotency-Key" },
      body: ["status"],
    },
    summary: "Open or close a published form",
  },
  idempotency: "required",
  concurrency: "required",
  emits: ["forms.versionClaim", "forms.opened", "forms.closed"],
} satisfies AnyOperationDef;

export const updateFormOperation = {
  id: "forms.update",
  kind: "command",
  input: UpdateFormInput,
  output: FormDetail,
  authorize: writeAuthorization,
  invoke: updateForm,
  rest: {
    method: "put",
    path: "/events/:eventId/forms/:formId",
    input: {
      path: ["eventId", "formId"],
      headers: { expectedVersion: "If-Match", idempotencyKey: "Idempotency-Key" },
      body: ["name", "description", "opensAt", "closesAt", "fields"],
    },
    summary: "Replace an editable form draft",
  },
  mcp: {
    name: "forms_update_draft",
    description: "Replace the editable draft without changing any previously published snapshot.",
  },
  idempotency: "required",
  concurrency: "required",
  emits: ["forms.versionClaim", "forms.updated"],
} satisfies AnyOperationDef;

/** Operation IDs are kept in bytewise ascending order for deterministic registry generation. */
export const operations = [
  createFormOperation,
  deleteFormOperation,
  getFormOperation,
  listFormsOperation,
  publishFormOperation,
  setFormStatusOperation,
  updateFormOperation,
] as const satisfies readonly AnyOperationDef[];
