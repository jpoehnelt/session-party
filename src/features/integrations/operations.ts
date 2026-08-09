import { authenticatedAuthorization } from "contracts/principal";
import { IntegrationConfig } from "contracts/types";
import { Schema } from "effect";
import { listIntegrationConfigurations } from "./service";

export const ListIntegrationConfigurationsInput = Schema.Struct({
  idOrSlug: Schema.String.pipe(Schema.minLength(1)),
});

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

export const operations = [listIntegrationConfigurationsOperation] as const;
