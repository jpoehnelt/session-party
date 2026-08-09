import type { McpToolDescriptor } from "contracts/mcp";
import type { EventApiKeyPrincipal } from "contracts/principal";

/** MCP is an event-scoped API-key surface; discovery mirrors the key's least privilege. */
export const mcpToolsForPrincipal = (
  principal: EventApiKeyPrincipal,
  descriptors: readonly McpToolDescriptor[],
): readonly McpToolDescriptor[] =>
  descriptors.filter((descriptor) =>
    descriptor.requiredScopes.every((required) => principal.scopes.includes(required))
  );
