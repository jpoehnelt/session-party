import { authenticatedAuthorization } from "contracts/principal";
import {
  AcceleventsIdempotencyKey,
  AcceleventsImportRun,
  AcceleventsImportStatus,
  IntegrationConfig,
} from "contracts/types";
import { Schema } from "effect";
import {
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

export const operations = [
  getAcceleventsImportStatusOperation,
  listIntegrationConfigurationsOperation,
  runAcceleventsImportOperation,
  configureAcceleventsOperation,
  getAcceleventsConfigurationOperation,
  getAirtableSyncStatusOperation,
  configureAirtableOperation,
  requestAirtableRefreshOperation,
] as const;
