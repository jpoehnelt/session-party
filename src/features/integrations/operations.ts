import { authenticatedAuthorization } from "contracts/principal";
import {
  AcceleventsIdempotencyKey,
  AcceleventsImportRun,
  AcceleventsImportStatus,
  IntegrationConfig,
} from "contracts/types";
import { Schema } from "effect";
import {
  getAcceleventsImportStatus,
  listIntegrationConfigurations,
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
  },
  idempotency: "required",
  concurrency: "none",
  emits: [],
} as const;

export const operations = [
  getAcceleventsImportStatusOperation,
  listIntegrationConfigurationsOperation,
  runAcceleventsImportOperation,
] as const;
