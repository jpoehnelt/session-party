import { pathToFileURL } from "node:url";

export const smokeOrigin = async (origin, request = fetch) => {
  const target = new URL(origin);
  if (target.protocol !== "https:" && target.hostname !== "localhost" && target.hostname !== "127.0.0.1") {
    throw new Error("Production smoke target must use HTTPS");
  }
  if (target.pathname !== "/" || target.search || target.hash) {
    throw new Error("Pass an origin only, without a path, query, or fragment");
  }

  const shell = await request(target);
  const contentType = shell.headers.get("content-type") ?? "";
  if (!shell.ok || !contentType.includes("text/html")) {
    throw new Error(`Application shell failed: ${shell.status} ${contentType}`);
  }

  const unauthenticated = await request(new URL("/api/v1/auth/me", target), {
    headers: { Accept: "application/json" },
  });
  const payload = await unauthenticated.json().catch(() => null);
  if (
    unauthenticated.status !== 401
    || typeof payload !== "object"
    || payload === null
    || payload.error !== "Unauthenticated"
  ) {
    throw new Error(`Authentication boundary failed: ${unauthenticated.status}`);
  }

  return {
    ok: true,
    origin: target.origin,
    checks: { applicationShell: shell.status, authenticationBoundary: unauthenticated.status },
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const origin = process.argv[2];
  if (!origin) throw new Error("Usage: pnpm smoke:production -- https://events.example.com");
  console.log(JSON.stringify(await smokeOrigin(origin), null, 2));
}
