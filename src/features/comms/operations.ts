import type { AnyOperationDef } from "contracts/operation";
import { Schema } from "effect";
import {
  AudienceSnapshot,
  CommunicationPreview,
  CommunicationTemplate,
  CreateTemplateInput,
  DeliveryHistory,
  EnqueueCommunicationInput,
  EnqueueCommunicationResult,
  ListAudienceInput,
  ListDeliveriesInput,
  ListTemplatesInput,
  PreviewCommunicationInput,
  RetryDeliveryInput,
  RetryDeliveryResult,
  UpdateTemplateInput,
} from "./schema";
import {
  communicationsReadAuthorization,
  communicationsWriteAuthorization,
  createTemplate,
  enqueueCommunication,
  listAudience,
  listDeliveries,
  listTemplates,
  previewCommunication,
  retryDelivery,
  updateTemplate,
} from "./service";

export const listTemplatesOperation = {
  id: "comms.listTemplates",
  kind: "query",
  input: ListTemplatesInput,
  output: Schema.Array(CommunicationTemplate),
  authorize: communicationsReadAuthorization,
  invoke: listTemplates,
  rest: {
    method: "get",
    path: "/events/:eventId/comms/templates",
    input: { path: ["eventId"] },
    summary: "List communication templates",
  },
  mcp: {
    name: "comms_list_templates",
    description: "List reusable communication templates for an event.",
  },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} as const satisfies AnyOperationDef;

export const createTemplateOperation = {
  id: "comms.createTemplate",
  kind: "command",
  input: CreateTemplateInput,
  output: CommunicationTemplate,
  authorize: communicationsWriteAuthorization,
  invoke: createTemplate,
  rest: {
    method: "post",
    path: "/events/:eventId/comms/templates",
    input: { path: ["eventId"], body: ["name", "subject", "textBody", "htmlBody", "attachIcs", "idempotencyKey"] },
    summary: "Create a communication template",
    successStatus: 201,
  },
  mcp: {
    name: "comms_create_template",
    description: "Create a validated event communication template.",
  },
  idempotency: "required",
  concurrency: "none",
  emits: ["comms.template.created"],
} as const satisfies AnyOperationDef;

export const updateTemplateOperation = {
  id: "comms.updateTemplate",
  kind: "command",
  input: UpdateTemplateInput,
  output: CommunicationTemplate,
  authorize: communicationsWriteAuthorization,
  invoke: updateTemplate,
  rest: {
    method: "put",
    path: "/events/:eventId/comms/templates/:templateId",
    input: {
      path: ["eventId", "templateId"],
      body: ["name", "subject", "textBody", "htmlBody", "attachIcs", "expectedVersion", "idempotencyKey"],
    },
    summary: "Replace a communication template draft",
  },
  mcp: {
    name: "comms_update_template",
    description: "Replace a communication template using optimistic concurrency.",
  },
  idempotency: "required",
  concurrency: "required",
  emits: ["comms.template.updated"],
} as const satisfies AnyOperationDef;

export const listAudienceOperation = {
  id: "comms.listAudience",
  kind: "query",
  input: ListAudienceInput,
  output: AudienceSnapshot,
  authorize: communicationsReadAuthorization,
  invoke: listAudience,
  rest: {
    method: "get",
    path: "/events/:eventId/comms/audience",
    input: { path: ["eventId"], query: ["page", "pageSize"] },
    summary: "List decided-applicant communication recipients",
  },
  mcp: {
    name: "comms_list_audience",
    description: "List accepted and rejected applicants and their communication eligibility.",
  },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} as const satisfies AnyOperationDef;

export const previewCommunicationOperation = {
  id: "comms.previewCommunication",
  kind: "query",
  input: PreviewCommunicationInput,
  output: CommunicationPreview,
  authorize: communicationsReadAuthorization,
  invoke: previewCommunication,
  rest: {
    method: "post",
    path: "/events/:eventId/comms/preview",
    input: { path: ["eventId"], body: ["subject", "textBody", "htmlBody", "attachIcs", "recipientKey"] },
    summary: "Render a local communication preview",
  },
  mcp: {
    name: "comms_preview_communication",
    description: "Render a template locally with decided-applicant or labeled sample data without sending it.",
  },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} as const satisfies AnyOperationDef;

export const enqueueCommunicationOperation = {
  id: "comms.enqueueCommunication",
  kind: "command",
  input: EnqueueCommunicationInput,
  output: EnqueueCommunicationResult,
  authorize: communicationsWriteAuthorization,
  invoke: enqueueCommunication,
  rest: {
    method: "post",
    path: "/events/:eventId/comms/deliveries",
    input: {
      path: ["eventId"],
      body: ["templateId", "expectedTemplateVersion", "recipientKeys", "replyToEmail", "scheduledFor", "idempotencyKey"],
    },
    summary: "Durably enqueue immutable communication deliveries",
    description: "Persists immutable delivery snapshots and outbox rows, then requests canonical Scheduler dispatch.",
    successStatus: 202,
  },
  mcp: {
    name: "comms_enqueue_communication",
    description: "Confirm an audience and persist immutable mail snapshots plus delivery outbox rows.",
  },
  idempotency: "required",
  concurrency: "none",
  emits: ["comms.deliveries.enqueued"],
} as const satisfies AnyOperationDef;

export const listDeliveriesOperation = {
  id: "comms.listDeliveries",
  kind: "query",
  input: ListDeliveriesInput,
  output: DeliveryHistory,
  authorize: communicationsReadAuthorization,
  invoke: listDeliveries,
  rest: {
    method: "get",
    path: "/events/:eventId/comms/deliveries",
    input: { path: ["eventId"], query: ["page", "pageSize"] },
    summary: "List communication delivery history",
  },
  mcp: {
    name: "comms_list_deliveries",
    description: "List durable delivery snapshots, attempts, retry state, and truthful provider mode.",
  },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} as const satisfies AnyOperationDef;

export const retryDeliveryOperation = {
  id: "comms.retryDelivery",
  kind: "command",
  input: RetryDeliveryInput,
  output: RetryDeliveryResult,
  authorize: communicationsWriteAuthorization,
  invoke: retryDelivery,
  rest: {
    method: "post",
    path: "/events/:eventId/comms/deliveries/:deliveryId/retry",
    input: { path: ["eventId", "deliveryId"], body: ["idempotencyKey"] },
    summary: "Queue a dead-letter delivery retry",
    successStatus: 202,
  },
  mcp: {
    name: "comms_retry_delivery",
    description: "Clone an immutable dead-letter snapshot into a new durable retry delivery.",
  },
  idempotency: "required",
  concurrency: "none",
  emits: ["comms.delivery.retryQueued"],
} as const satisfies AnyOperationDef;

export const operations = [
  createTemplateOperation,
  enqueueCommunicationOperation,
  listAudienceOperation,
  listDeliveriesOperation,
  listTemplatesOperation,
  previewCommunicationOperation,
  retryDeliveryOperation,
  updateTemplateOperation,
] as const;
