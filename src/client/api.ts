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
  signal?: AbortSignal;
}

interface PendingGetRequest {
  readonly controller: AbortController;
  readonly promise: Promise<unknown>;
}

let authGeneration = 0;
const pendingGetRequests = new Map<string, PendingGetRequest>();
let authenticatedPrincipal: string | null | undefined;

export function invalidateAuthGeneration(): void {
  authGeneration += 1;
  const requests = [...pendingGetRequests.values()];
  pendingGetRequests.clear();
  for (const request of requests) request.controller.abort();
}

export function synchronizeAuthenticatedPrincipal(principal: string | null): void {
  if (authenticatedPrincipal === undefined) {
    authenticatedPrincipal = principal;
    return;
  }
  if (authenticatedPrincipal === principal) return;
  authenticatedPrincipal = principal;
  invalidateAuthGeneration();
}

export async function apiFetch<T>(
  path: string,
  { method = "GET", body, schema, signal }: ApiFetchOptions<T> = {},
): Promise<T> {
  const requestGeneration = authGeneration;
  const normalizedMethod = method.toUpperCase();
  const requestKey =
    normalizedMethod === "GET" && signal === undefined
      ? `${requestGeneration}\n${path}\n${body === undefined ? "" : JSON.stringify(body)}`
      : undefined;
  let request: Promise<unknown>;

  if (!requestKey) {
    request = fetchPayload(path, method, body, signal, requestGeneration);
  } else {
    let pending = pendingGetRequests.get(requestKey);
    if (!pending) {
      const controller = new AbortController();
      pending = {
        controller,
        promise: fetchPayload(path, method, body, controller.signal, requestGeneration),
      };
      pendingGetRequests.set(requestKey, pending);
      const current = pending;
      void current.promise.then(
        () => {
          if (pendingGetRequests.get(requestKey) === current) pendingGetRequests.delete(requestKey);
        },
        () => {
          if (pendingGetRequests.get(requestKey) === current) pendingGetRequests.delete(requestKey);
        },
      );
    }
    request = pending.promise;
  }

  const payload = await request;
  if (normalizedMethod === "GET" && requestGeneration !== authGeneration) {
    throw new DOMException("The authenticated principal changed during the request.", "AbortError");
  }
  return schema ? Schema.decodeUnknownSync(schema)(payload) : (payload as T);
}

async function fetchPayload(
  path: string,
  method: string,
  body: unknown,
  signal: AbortSignal | undefined,
  requestGeneration: number,
): Promise<unknown> {
  const response = await fetch(path, {
    method,
    signal,
    credentials: "include",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const message = await responseMessage(response);
    if (response.status === 401 && requestGeneration === authGeneration) {
      synchronizeAuthenticatedPrincipal(null);
    }
    throw new ApiError(response.status, message);
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
