import type { AppError } from "./errors";
import type { EventType, JsonObject, OperationId } from "./domain";
import type { AuthorizationPolicy } from "./principal";
import type { HttpMethod, RestInputLocations } from "./routes";
import type { Effect, Schema } from "effect";

export interface RestOperationMetadata {
  readonly method: HttpMethod;
  readonly path: `/${string}`;
  readonly input: RestInputLocations;
  readonly summary?: string;
  readonly description?: string;
  readonly successStatus?: 200 | 201 | 202 | 204;
}

export interface McpOperationMetadata {
  readonly name: string;
  readonly description: string;
}

export interface PartyOperationMetadata {
  readonly intentType: `${string}/${string}`;
}

/** One domain operation projected into every declared transport. */
export interface OperationDef<
  Input,
  EncodedInput,
  Output,
  EncodedOutput,
  Requirements,
> {
  readonly id: OperationId;
  readonly kind: "query" | "command";
  readonly input: Schema.Schema<Input, EncodedInput, never>;
  readonly output: Schema.Schema<Output, EncodedOutput, never>;
  readonly authorize: AuthorizationPolicy;
  readonly invoke: (input: Input) => Effect.Effect<Output, AppError, Requirements>;
  readonly rest?: RestOperationMetadata;
  readonly mcp?: McpOperationMetadata;
  readonly party?: PartyOperationMetadata;
  readonly idempotency: "required" | "optional" | "none";
  readonly concurrency: "required" | "none";
  readonly emits: readonly EventType[];
}

// Variance is intentionally erased only at the generated registry boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyOperationDef = OperationDef<any, any, any, any, any>;

export interface PartyIntentDescriptor {
  readonly operationId: OperationId;
  readonly intentType: `${string}/${string}`;
  readonly inputSchema: JsonObject;
  readonly outputSchema: JsonObject;
}

export interface OwnershipClaim {
  readonly operationId: OperationId;
  readonly owner: string;
  readonly source: string;
}

export interface RegistryOwnershipManifest {
  readonly operations: readonly OwnershipClaim[];
  readonly rest: readonly {
    readonly operationId: OperationId;
    readonly method: HttpMethod;
    readonly path: string;
  }[];
  readonly mcp: readonly { readonly operationId: OperationId; readonly name: string }[];
  readonly party: readonly { readonly operationId: OperationId; readonly intentType: string }[];
}
