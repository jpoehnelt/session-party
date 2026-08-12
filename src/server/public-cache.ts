const PUBLIC_JSON_CACHE_CONTROL = "public, max-age=60, s-maxage=60";

export const PUBLIC_HEADSHOT_CACHE_CONTROL =
  "public, max-age=60, s-maxage=60";

export const isAnonymousPublicRequest = (request: Request): boolean =>
  !request.headers.has("Authorization") && !request.headers.has("Cookie");

const canonicalCacheRequest = (request: Request, conditional: boolean): Request => {
  const url = new URL(request.url);
  url.search = "";
  const headers = new Headers();
  if (conditional) {
    for (const name of ["If-Modified-Since", "If-None-Match", "Range"] as const) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
  }
  return new Request(url, { method: "GET", headers });
};

const logCacheFailure = (action: "match" | "put", request: Request, error: unknown): void => {
  console.warn(JSON.stringify({
    message: "public edge cache unavailable",
    action,
    path: new URL(request.url).pathname,
    error: error instanceof Error ? error.message : String(error),
  }));
};

export const matchPublicCache = async (request: Request): Promise<Response | undefined> => {
  if (!isAnonymousPublicRequest(request)) return undefined;
  try {
    return await caches.default.match(canonicalCacheRequest(request, true));
  } catch (error) {
    logCacheFailure("match", request, error);
    return undefined;
  }
};

export const storePublicCache = async (
  request: Request,
  response: Response,
  executionCtx: { readonly waitUntil: (promise: Promise<unknown>) => void },
): Promise<void> => {
  if (!isAnonymousPublicRequest(request)) return;
  const write = caches.default
    .put(canonicalCacheRequest(request, false), response.clone())
    .catch((error) => logCacheFailure("put", request, error));
  try {
    executionCtx.waitUntil(write);
  } catch {
    await write;
  }
};

const sha256Hex = async (value: string): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  let encoded = "";
  for (const byte of digest) encoded += byte.toString(16).padStart(2, "0");
  return encoded;
};

const matchesEtag = (request: Request, etag: string): boolean =>
  request.headers.get("If-None-Match")
    ?.split(",")
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === "*" || candidate === etag) === true;

export const publicJsonResponse = async (
  request: Request,
  value: unknown,
  executionCtx: { readonly waitUntil: (promise: Promise<unknown>) => void },
): Promise<Response> => {
  const body = JSON.stringify(value);
  const etag = `"sha256-${await sha256Hex(body)}"`;
  const headers = new Headers({
    "Cache-Control": PUBLIC_JSON_CACHE_CONTROL,
    "Content-Type": "application/json; charset=UTF-8",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  });
  if (matchesEtag(request, etag)) return new Response(null, { status: 304, headers });
  const response = new Response(body, { status: 200, headers });
  await storePublicCache(request, response, executionCtx);
  return response;
};
