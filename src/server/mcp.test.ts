import type { ApiScope, EventApiKeyPrincipal } from "contracts/principal";
import { describe, expect, it } from "vitest";
import { mcpTools, operationById } from "./registry.gen";
import { mcpToolsForPrincipal } from "./mcp";

const principal = (scopes: readonly ApiScope[]): EventApiKeyPrincipal => ({
  kind: "api-key",
  userId: "api-key:mcp-test-key",
  apiKeyId: "mcp-test-key",
  eventId: "mcp-test-event",
  name: "MCP test key",
  scopes,
  expiresAt: Date.UTC(2100, 0, 1),
});

const namesFor = (scopes: readonly ApiScope[]): readonly string[] =>
  mcpToolsForPrincipal(principal(scopes), mcpTools).map(({ name }) => name);

describe("MCP discovery", () => {
  it("filters discovery to the exact API-key scopes", () => {
    const agendaReader = namesFor(["agenda:read"]);
    expect(agendaReader).toContain("agenda_list");
    expect(agendaReader).not.toContain("agenda_schedule_talk");
    expect(agendaReader).not.toContain("configure_accelevents");

    const agendaWriter = namesFor(["agenda:write"]);
    expect(agendaWriter).toContain("agenda_schedule_talk");
    expect(agendaWriter).toContain("agenda_publish");
    expect(agendaWriter).not.toContain("agenda_list");

    const integrationReader = namesFor(["integrations:read"]);
    expect(integrationReader).toContain("get_accelevents_import_status");
    expect(integrationReader).not.toContain("run_accelevents_import");
  });

  it("contains only API-key-compatible organizer and integration operations", () => {
    for (const descriptor of mcpTools) {
      const operation = operationById[descriptor.operationId];
      expect(operation).toBeDefined();
      if (!operation) throw new Error(`Missing operation ${descriptor.operationId}`);
      expect(operation.authorize.kind).not.toBe("browser-session");
      expect(operation.authorize.kind).not.toBe("public");
      if (operation.authorize.kind === "event") {
        expect(operation.authorize.apiKey.kind).toBe("api-key");
      }
    }
  });

  it("prefers workflow tools over setup CRUD and keeps speaker self-service out", () => {
    const names = mcpTools.map(({ name }) => name);
    expect(names).toEqual(expect.arrayContaining([
      "agenda_schedule_talk",
      "agenda_publish",
      "manage_speaker_onboarding",
    ]));
    expect(names).not.toEqual(expect.arrayContaining([
      "agenda_create_room",
      "agenda_update_room",
      "agenda_create_track",
      "agenda_update_track",
      "portal_update_profile",
      "portal_set_task_completion",
      "portal_upload_asset",
    ]));
  });
});
