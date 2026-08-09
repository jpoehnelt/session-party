import type {
  AcceleventsImportStatus,
  IntegrationConfig,
} from "contracts/types";

export const configurationTruth = (configurations: readonly IntegrationConfig[]) => ({
  airtable: configurations.some((configuration) => configuration.kind === "airtable"),
  accelevents: configurations.some((configuration) => configuration.kind === "accelevents"),
});

export const acceleventsCapabilityLabel = (
  status: AcceleventsImportStatus,
): "Live" | "Fixture" | "Unavailable" => {
  if (status.capability.state !== "ready") return "Unavailable";
  return status.capability.mode === "live" ? "Live" : "Fixture";
};
