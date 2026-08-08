import { Data } from "effect";

export class NotFound extends Data.TaggedError("NotFound")<{ entity: string; id: string }> {}
export class Unauthenticated extends Data.TaggedError("Unauthenticated")<{ reason?: string }> {}
export class Forbidden extends Data.TaggedError("Forbidden")<{ reason?: string }> {}
export class Validation extends Data.TaggedError("Validation")<{ message: string }> {}
export class Conflict extends Data.TaggedError("Conflict")<{ message: string }> {}
export class External extends Data.TaggedError("External")<{ service: string; detail?: string }> {}

export type AppError = NotFound | Unauthenticated | Forbidden | Validation | Conflict | External;
export type AppErrorStatus = 400 | 401 | 403 | 404 | 409 | 502;

export interface PublicAppError {
  readonly error: AppError["_tag"];
  readonly message: string;
  readonly requestId: string;
}

export const appErrorStatus = (error: AppError): AppErrorStatus => {
  switch (error._tag) {
    case "Validation":
      return 400;
    case "Unauthenticated":
      return 401;
    case "Forbidden":
      return 403;
    case "NotFound":
      return 404;
    case "Conflict":
      return 409;
    case "External":
      return 502;
  }
};

/**
 * The tagged errors retain diagnostic fields for redacted logs. Only explicitly
 * public validation/conflict messages cross a transport boundary.
 */
export const toPublicAppError = (error: AppError, requestId: string): PublicAppError => {
  switch (error._tag) {
    case "Validation":
    case "Conflict":
      return { error: error._tag, message: error.message, requestId };
    case "Unauthenticated":
      return { error: error._tag, message: "Authentication required", requestId };
    case "Forbidden":
      return { error: error._tag, message: "Access denied", requestId };
    case "NotFound":
      return { error: error._tag, message: "Resource not found", requestId };
    case "External":
      return { error: error._tag, message: "External service request failed", requestId };
  }
};
