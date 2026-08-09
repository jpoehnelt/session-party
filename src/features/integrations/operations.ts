import { IntegrationConfig } from "contracts/types";
import { Schema } from "effect";
import {
  integrationsReadAuthorization,
  listIntegrationConfigurations,
} from "./service";

export const ListIntegrationConfigurationsInput = Schema.Struct({
  eventId: Schema.String.pipe(Schema.minLength(1)),
});

export const listIntegrationConfigurationsOperation = {
  id: "integrations.listConfigurations",
  kind: "query",
  input: ListIntegrationConfigurationsInput,
  output: Schema.Array(IntegrationConfig),
  authorize: integrationsReadAuthorization,
  invoke: ({ eventId }: typeof ListIntegrationConfigurationsInput.Type) =>
    listIntegrationConfigurations(eventId),
  rest: {
    method: "get",
    path: "/events/:eventId/integrations/configurations",
    input: { path: ["eventId"] },
    summary: "List integration configurations",
    description:
      "Lists validated, non-secret Airtable and Accelevents configuration for an event.",
    successStatus: 200,
  },
  mcp: {
    name: "list_integration_configurations",
    description:
      "List validated, non-secret Airtable and Accelevents configuration for an event.",
  },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} as const;

export const operations = [listIntegrationConfigurationsOperation] as const;
