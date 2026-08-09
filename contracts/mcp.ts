import type { JsonObject, OperationId } from "./domain";
import type { AppError } from "./errors";
import type { ApiScope } from "./principal";
import type { Effect, Schema } from "effect";

export interface McpToolDescriptor {
  readonly operationId: OperationId;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema: JsonObject;
  /** Server-owned discovery filter; this field is not included in the MCP wire descriptor. */
  readonly requiredScopes: readonly ApiScope[];
}

export interface McpTextContent {
  readonly type: "text";
  readonly text: string;
}

export interface McpToolResult {
  readonly content: readonly McpTextContent[];
  readonly isError?: boolean;
}

/**
 * Compatibility contract for the pre-registry events slice. Remove it with
 * features/events/tools.ts when the canonical events OperationDefs land.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- legacy registry boundary
export interface ToolDef<A = any, I = any, R = any> {
  readonly name: string;
  readonly description: string;
  readonly args: Schema.Schema<A, I, never>;
  readonly handler: (args: A) => Effect.Effect<unknown, AppError, R>;
}
