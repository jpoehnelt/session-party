/**
 * FROZEN CONTRACT — integrator-only after spine-v1.
 * MCP tool definition shape. Each slice exports `tools: ToolDef[]` from
 * `features/<slice>/tools.ts`; codegen collects them into the /mcp server.
 *
 * Handlers are Effects: fail with AppError (mapped to MCP tool errors by the
 * adapter), and may require any service provided by the spine's AppLayer
 * (Db, Mail, Files, Rooms, Ai — see src/server/services.ts). The adapter
 * decodes raw args with `args` before invoking `handler`.
 *
 * Naming: snake_case, verb_noun, unprefixed (e.g. "create_event",
 * "schedule_talk", "score_submission"). Names are globally unique.
 */
import type { Effect, Schema } from "effect";
import type { AppError } from "./errors";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance erased at the registry boundary
export interface ToolDef<A = any, I = any, R = any> {
  name: string;
  description: string;
  args: Schema.Schema<A, I, never>;
  handler: (args: A) => Effect.Effect<unknown, AppError, R>;
}
