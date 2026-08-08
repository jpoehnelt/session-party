/**
 * FROZEN CONTRACT — integrator-only after spine-v1.
 * The complete server error channel. Every slice service fails with one of
 * these; boundary adapters map tags to HTTP status / MCP tool errors:
 *   NotFound→404  Forbidden→403  Unauthenticated→401  Validation→400
 *   Conflict→409  External→502
 */
import { Data } from "effect";

export class NotFound extends Data.TaggedError("NotFound")<{ entity: string; id: string }> {}
export class Unauthenticated extends Data.TaggedError("Unauthenticated")<{ reason?: string }> {}
export class Forbidden extends Data.TaggedError("Forbidden")<{ reason?: string }> {}
export class Validation extends Data.TaggedError("Validation")<{ message: string }> {}
export class Conflict extends Data.TaggedError("Conflict")<{ message: string }> {}
export class External extends Data.TaggedError("External")<{ service: string; detail?: string }> {}

export type AppError = NotFound | Unauthenticated | Forbidden | Validation | Conflict | External;
