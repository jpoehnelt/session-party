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

const pendingGetRequests = new Map<string, Promise<unknown>>();

export async function apiFetch<T>(
  path: string,
  { method = "GET", body, schema }: ApiFetchOptions<T> = {},
): Promise<T> {
  const normalizedMethod = method.toUpperCase();
  const requestKey =
    normalizedMethod === "GET" ? `${path}\n${body === undefined ? "" : JSON.stringify(body)}` : undefined;
  let request = requestKey ? pendingGetRequests.get(requestKey) : undefined;

  if (!request) {
    request = fetchPayload(path, method, body);
    if (requestKey) {
      pendingGetRequests.set(requestKey, request);
      void request.then(
        () => pendingGetRequests.delete(requestKey),
        () => pendingGetRequests.delete(requestKey),
      );
    }
  }

  const payload = await request;
  return schema ? Schema.decodeUnknownSync(schema)(payload) : (payload as T);
}

async function fetchPayload(path: string, method: string, body: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method,
    credentials: "include",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    throw new ApiError(response.status, await responseMessage(response));
  }

  return response.status === 204 ? undefined : response.json();
}

function responseMessage(response: Response): Promise<string> {
  return response.json().catch(() => undefined).then((payload: unknown) => {
    if (typeof payload !== "object" || payload === null) {
      return response.statusText || `Request failed with status ${response.status}`;
    }

    if ("message" in payload && typeof payload.message === "string") {
      return payload.message;
    }

    if (!("error" in payload)) {
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
  });
}
