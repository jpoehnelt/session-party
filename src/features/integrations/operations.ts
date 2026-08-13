import { authenticatedAuthorization } from "contracts/principal";
import {
  AcceleventsIdempotencyKey,
  AcceleventsImportRun,
  AcceleventsImportStatus,
  IntegrationConfig,
} from "contracts/types";
import { Schema } from "effect";
import {
  CreateWebhookInput,
  CreateWebhookResult,
  DeleteWebhookInput,
  DeleteWebhookResult,
  ListWebhookDeliveriesInput,
  ListWebhookDeliveriesResult,
  ListWebhooksInput,
  ListWebhooksResult,
  RedeliverWebhookInput,
  RedeliverWebhookResult,
  UpdateWebhookInput,
  UpdateWebhookResult,
  ConfigureAcceleventsInput,
  ConfigureAcceleventsResult,
  AcceleventsConfiguration,
  AirtableSyncStatus,
  ConfigureAirtableInput,
  ConfigureAirtableResult,
  RequestAirtableRefreshInput,
  RequestAirtableRefreshResult,
} from "./schema";
import {
  createWebhook,
  deleteWebhook,
  listWebhookDeliveries,
  listWebhooks,
  redeliverWebhook,
  updateWebhook,
} from "./webhooks";
import {
  configureAirtable,
  configureAccelevents,
  getAirtableSyncStatus,
  getAcceleventsConfiguration,
  getAcceleventsImportStatus,
  listIntegrationConfigurations,
  requestAirtableRefresh,
  runAcceleventsImport,
} from "./service";

export const ListIntegrationConfigurationsInput = Schema.Struct({
  idOrSlug: Schema.String.pipe(Schema.minLength(1)),
});

export const RunAcceleventsImportInput = Schema.Struct({
  idOrSlug: Schema.String.pipe(Schema.minLength(1)),
  idempotencyKey: AcceleventsIdempotencyKey,
});

export const getAcceleventsImportStatusOperation = {
  id: "integrations.getAcceleventsImportStatus",
  kind: "query",
  input: ListIntegrationConfigurationsInput,
  output: AcceleventsImportStatus,
  authorize: authenticatedAuthorization,
  invoke: ({ idOrSlug }: typeof ListIntegrationConfigurationsInput.Type) =>
    getAcceleventsImportStatus(idOrSlug),
  rest: {
    method: "get",
    path: "/events/:idOrSlug/integrations/accelevents/status",
    input: { path: ["idOrSlug"] },
    summary: "Get Accelevents import status",
    description: "Returns server-observed Accelevents capability and the latest completed import.",
    successStatus: 200,
  },
  mcp: {
    name: "get_accelevents_import_status",
    description: "Get Accelevents import capability and latest completed import for an event.",
    scopes: ["integrations:read"],
  },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} as const;

export const listIntegrationConfigurationsOperation = {
  id: "integrations.listConfigurations",
  kind: "query",
  input: ListIntegrationConfigurationsInput,
  output: Schema.Array(IntegrationConfig),
  authorize: authenticatedAuthorization,
  invoke: ({ idOrSlug }: typeof ListIntegrationConfigurationsInput.Type) =>
    listIntegrationConfigurations(idOrSlug),
  rest: {
    method: "get",
    path: "/events/:idOrSlug/integrations/configurations",
    input: { path: ["idOrSlug"] },
    summary: "List integration configurations",
    description:
      "Lists validated, non-secret Airtable and Accelevents configuration for an event.",
    successStatus: 200,
  },
  mcp: {
    name: "list_integration_configurations",
    description:
      "List validated, non-secret Airtable and Accelevents configuration for an event by ID or slug.",
    scopes: ["integrations:read"],
  },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} as const;

export const runAcceleventsImportOperation = {
  id: "integrations.runAcceleventsImport",
  kind: "command",
  input: RunAcceleventsImportInput,
  output: AcceleventsImportRun,
  authorize: authenticatedAuthorization,
  invoke: ({ idOrSlug, idempotencyKey }: typeof RunAcceleventsImportInput.Type) =>
    runAcceleventsImport(idOrSlug, idempotencyKey),
  rest: {
    method: "post",
    path: "/events/:idOrSlug/integrations/accelevents/imports",
    input: { path: ["idOrSlug"], body: ["idempotencyKey"] },
    summary: "Run Accelevents import",
    description: "Runs an idempotent Accelevents speaker and talk import for an event.",
    successStatus: 200,
  },
  mcp: {
    name: "run_accelevents_import",
    description: "Run an idempotent Accelevents speaker and talk import for an event.",
    scopes: ["integrations:write"],
  },
  idempotency: "required",
  concurrency: "none",
  emits: [],
} as const;

export const configureAcceleventsOperation = {
  id: "integrations.configureAccelevents",
  kind: "command",
  input: ConfigureAcceleventsInput,
  output: ConfigureAcceleventsResult,
  authorize: authenticatedAuthorization,
  invoke: configureAccelevents,
  rest: {
    method: "put",
    path: "/events/:idOrSlug/integrations/accelevents/configuration",
    input: {
      path: ["idOrSlug"],
      body: ["source", "accelEventId", "eventUrl", "expectedVersion", "idempotencyKey"],
    },
    summary: "Configure Accelevents import",
    description: "Creates or replaces a versioned Accelevents mapping without accepting provider secrets.",
    successStatus: 200,
  },
  mcp: {
    name: "configure_accelevents",
    description: "Configure the deterministic fixture or a live Accelevents event with optimistic concurrency.",
    scopes: ["integrations:write"],
  },
  idempotency: "required",
  concurrency: "required",
  emits: ["integrations.accelevents_configured"],
} as const;

export const getAcceleventsConfigurationOperation = {
  id: "integrations.getAcceleventsConfiguration",
  kind: "query",
  input: ListIntegrationConfigurationsInput,
  output: Schema.NullOr(AcceleventsConfiguration),
  authorize: authenticatedAuthorization,
  invoke: ({ idOrSlug }: typeof ListIntegrationConfigurationsInput.Type) =>
    getAcceleventsConfiguration(idOrSlug),
  rest: {
    method: "get",
    path: "/events/:idOrSlug/integrations/accelevents/configuration",
    input: { path: ["idOrSlug"] },
    summary: "Get Accelevents configuration",
    description: "Returns versioned, non-secret Accelevents configuration for organizer edits.",
    successStatus: 200,
  },
  mcp: {
    name: "get_accelevents_configuration",
    description: "Read a versioned, non-secret Accelevents configuration for organizer edits.",
    scopes: ["integrations:read"],
  },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} as const;

export const getAirtableSyncStatusOperation = {
  id: "integrations.getAirtableSyncStatus",
  kind: "query",
  input: ListIntegrationConfigurationsInput,
  output: AirtableSyncStatus,
  authorize: authenticatedAuthorization,
  invoke: ({ idOrSlug }: typeof ListIntegrationConfigurationsInput.Type) =>
    getAirtableSyncStatus(idOrSlug),
  rest: {
    method: "get",
    path: "/events/:idOrSlug/integrations/airtable/status",
    input: { path: ["idOrSlug"] },
    summary: "Get Airtable synchronization status",
    description: "Returns server-observed adapter capability, durable queue counts, refresh state, and non-secret configuration.",
    successStatus: 200,
  },
  mcp: {
    name: "get_airtable_sync_status",
    description: "Get Airtable adapter, queue, refresh, and mapping status for an event.",
    scopes: ["integrations:read"],
  },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} as const;

export const configureAirtableOperation = {
  id: "integrations.configureAirtable",
  kind: "command",
  input: ConfigureAirtableInput,
  output: ConfigureAirtableResult,
  authorize: authenticatedAuthorization,
  invoke: configureAirtable,
  rest: {
    method: "put",
    path: "/events/:idOrSlug/integrations/airtable/configuration",
    input: { path: ["idOrSlug"], body: ["config", "expectedVersion", "idempotencyKey"] },
    summary: "Configure Airtable synchronization",
    description: "Creates or replaces the validated three-table Airtable field map without accepting provider credentials.",
    successStatus: 200,
  },
  mcp: {
    name: "configure_airtable",
    description: "Configure a versioned Airtable base and physical field mapping for an event.",
    scopes: ["integrations:write"],
  },
  idempotency: "required",
  concurrency: "required",
  emits: ["integrations.airtable_configured"],
} as const;

export const requestAirtableRefreshOperation = {
  id: "integrations.requestAirtableRefresh",
  kind: "command",
  input: RequestAirtableRefreshInput,
  output: RequestAirtableRefreshResult,
  authorize: authenticatedAuthorization,
  invoke: requestAirtableRefresh,
  rest: {
    method: "post",
    path: "/events/:idOrSlug/integrations/airtable/refreshes",
    input: { path: ["idOrSlug"], body: ["entityTypes"] },
    summary: "Request an Airtable refresh",
    description: "Coalesces a near-live inbound refresh request and wakes the per-base sync lane.",
    successStatus: 202,
  },
  mcp: {
    name: "request_airtable_refresh",
    description: "Request a coalesced Airtable refresh for speakers, submissions, and talks.",
    scopes: ["integrations:write"],
  },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} as const;


export const createWebhookOperation = {
  id: "integrations.createWebhook",
  kind: "command",
  input: CreateWebhookInput,
  output: CreateWebhookResult,
  authorize: authenticatedAuthorization,
  invoke: createWebhook,
  rest: {
    method: "post",
    path: "/events/:idOrSlug/webhooks",
    input: { path: ["idOrSlug"], body: ["url", "description", "kinds", "idempotencyKey"] },
    summary: "Create an outbound webhook",
    description: "Registers a signed HTTPS endpoint that receives notifications for matching domain changes; the signing secret is returned once.",
    successStatus: 201,
  },
  mcp: {
    name: "create_webhook",
    description: "Register an outbound webhook endpoint for matching domain-change notifications.",
    scopes: ["integrations:write"],
  },
  idempotency: "required",
  concurrency: "none",
  emits: ["integrations.webhook.created"],
} as const;

export const listWebhooksOperation = {
  id: "integrations.listWebhooks",
  kind: "query",
  input: ListWebhooksInput,
  output: ListWebhooksResult,
  authorize: authenticatedAuthorization,
  invoke: ({ idOrSlug }: typeof ListWebhooksInput.Type) => listWebhooks(idOrSlug),
  rest: {
    method: "get",
    path: "/events/:idOrSlug/webhooks",
    input: { path: ["idOrSlug"] },
    summary: "List outbound webhooks",
    description: "Lists the event's webhook endpoints with delivery statistics; signing secrets are never returned.",
    successStatus: 200,
  },
  mcp: {
    name: "list_webhooks",
    description: "List outbound webhook endpoints and their delivery statistics for an event.",
    scopes: ["integrations:read"],
  },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} as const;

export const updateWebhookOperation = {
  id: "integrations.updateWebhook",
  kind: "command",
  input: UpdateWebhookInput,
  output: UpdateWebhookResult,
  authorize: authenticatedAuthorization,
  invoke: updateWebhook,
  rest: {
    method: "patch",
    path: "/events/:idOrSlug/webhooks/:webhookId",
    input: {
      path: ["idOrSlug", "webhookId"],
      body: ["expectedVersion", "url", "description", "kinds", "status", "rotateSecret", "idempotencyKey"],
    },
    summary: "Update or pause an outbound webhook",
    description: "Updates URL, kinds, status, or description under optimistic concurrency; rotateSecret returns a fresh signing secret once.",
    successStatus: 200,
  },
  mcp: {
    name: "update_webhook",
    description: "Update, pause, resume, or rotate the secret of an outbound webhook endpoint.",
    scopes: ["integrations:write"],
  },
  idempotency: "required",
  concurrency: "required",
  emits: ["integrations.webhook.updated"],
} as const;

export const deleteWebhookOperation = {
  id: "integrations.deleteWebhook",
  kind: "command",
  input: DeleteWebhookInput,
  output: DeleteWebhookResult,
  authorize: authenticatedAuthorization,
  invoke: deleteWebhook,
  rest: {
    method: "delete",
    path: "/events/:idOrSlug/webhooks/:webhookId",
    input: { path: ["idOrSlug", "webhookId"], body: ["expectedVersion", "idempotencyKey"] },
    summary: "Delete an outbound webhook",
    description: "Deletes the endpoint and its delivery history under optimistic concurrency.",
    successStatus: 200,
  },
  mcp: {
    name: "delete_webhook",
    description: "Delete an outbound webhook endpoint and its delivery history.",
    scopes: ["integrations:write"],
  },
  idempotency: "required",
  concurrency: "required",
  emits: ["integrations.webhook.deleted"],
} as const;

export const listWebhookDeliveriesOperation = {
  id: "integrations.listWebhookDeliveries",
  kind: "query",
  input: ListWebhookDeliveriesInput,
  output: ListWebhookDeliveriesResult,
  authorize: authenticatedAuthorization,
  invoke: listWebhookDeliveries,
  rest: {
    method: "get",
    path: "/events/:idOrSlug/webhooks/:webhookId/deliveries",
    input: { path: ["idOrSlug", "webhookId"], query: ["page", "pageSize"] },
    summary: "List webhook deliveries",
    description: "Pages through delivery evidence for one endpoint, newest first.",
    successStatus: 200,
  },
  mcp: {
    name: "list_webhook_deliveries",
    description: "List delivery attempts and their outcomes for a webhook endpoint.",
    scopes: ["integrations:read"],
  },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} as const;

export const redeliverWebhookOperation = {
  id: "integrations.redeliverWebhook",
  kind: "command",
  input: RedeliverWebhookInput,
  output: RedeliverWebhookResult,
  authorize: authenticatedAuthorization,
  invoke: redeliverWebhook,
  rest: {
    method: "post",
    path: "/events/:idOrSlug/webhooks/deliveries/:deliveryId/redeliver",
    input: { path: ["idOrSlug", "deliveryId"], body: ["idempotencyKey"] },
    summary: "Redeliver a webhook delivery",
    description: "Requeues a scheduled-retry or dead-letter delivery for immediate dispatch with its original signed body.",
    successStatus: 200,
  },
  mcp: {
    name: "redeliver_webhook",
    description: "Requeue a failed webhook delivery for immediate dispatch.",
    scopes: ["integrations:write"],
  },
  idempotency: "required",
  concurrency: "none",
  emits: [],
} as const;

export const operations = [
  getAcceleventsImportStatusOperation,
  listIntegrationConfigurationsOperation,
  runAcceleventsImportOperation,
  configureAcceleventsOperation,
  getAcceleventsConfigurationOperation,
  getAirtableSyncStatusOperation,
  configureAirtableOperation,
  requestAirtableRefreshOperation,
  createWebhookOperation,
  listWebhooksOperation,
  updateWebhookOperation,
  deleteWebhookOperation,
  listWebhookDeliveriesOperation,
  redeliverWebhookOperation,
] as const;
