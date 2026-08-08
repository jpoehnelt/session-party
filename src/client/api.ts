import { Schema } from "effect";

export class ApiError extends Error {
  readonly name = "ApiError";

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ApiFetchOptions<T> {
  method?: string;
  body?: unknown;
  schema?: Schema.Schema<T, any, never>;
}

export async function apiFetch<T>(
  path: string,
  { method = "GET", body, schema }: ApiFetchOptions<T> = {},
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "include",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    throw new ApiError(response.status, await responseMessage(response));
  }

  const payload: unknown = response.status === 204 ? undefined : await response.json();
  return schema ? Schema.decodeUnknownSync(schema)(payload) : (payload as T);
}

async function responseMessage(response: Response): Promise<string> {
  const payload: unknown = await response.json().catch(() => undefined);
  if (typeof payload !== "object" || payload === null || !("error" in payload)) {
    return response.statusText || `Request failed with status ${response.status}`;
  }

  const error = payload.error;
  if (typeof error === "string") return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }

  return response.statusText || `Request failed with status ${response.status}`;
}
