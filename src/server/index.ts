import type { Principal } from "contracts/principal";
import { API } from "contracts/routes";
import { Hono } from "hono";
import { Effect } from "effect";
import { McpAgent } from "agents/mcp";
import { routePartykitRequest, type Connection, type ConnectionContext } from "partyserver";
import publicationFeeds from "@/features/publication/feed-api";
import auth, { apiKeyUserFromRequest, userFromRequest } from "./auth";
import { runRestOperation, runTransportOperation } from "./adapt";
import { EventRoom } from "./party/EventRoom";
import { MAIL_SCHEDULER_NAME, Scheduler } from "./party/Scheduler";
import { mcpToolsForPrincipal } from "./mcp";
import { AirtableRateLimiter } from "./sync/AirtableRateLimiter";
import { AirtableSyncLane } from "./sync/AirtableSyncLane";
import { enqueueAutomatedDueTaskReminders } from "@/features/portal/service";
import {
  apiRouters,
  mcpTools,
  operationById,
  restRegistrations,
} from "./registry.gen";
import { AppLayer, isExplicitLocalEnvironment, sessionSecret } from "./services";
import { publicRuntimeConfig } from "./runtime-config";

type JsonRpcId = string | number;
type JsonRpcRequest = {
  readonly jsonrpc: "2.0";
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
};
type JsonRpcResponse =
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly result: unknown }
  | {
      readonly jsonrpc: "2.0";
      readonly id: JsonRpcId | null;
      readonly error: { readonly code: number; readonly message: string; readonly data?: unknown };
    };

interface McpTransport {
  start(): Promise<void>;
  send(message: JsonRpcResponse, options?: { relatedRequestId?: JsonRpcId }): Promise<void>;
  close(): Promise<void>;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JsonRpcRequest | readonly JsonRpcRequest[]) => void;
  setProtocolVersion?: (version: string) => void;
}
const isJsonRpcBatch = (
  message: JsonRpcRequest | readonly JsonRpcRequest[],
): message is readonly JsonRpcRequest[] => Array.isArray(message);

type RequestHandler = (params: unknown) => Promise<unknown>;
const MCP_BOUND_API_KEY_ID = "mcp-bound-api-key-id";

/**
 * The agents package carries the MCP SDK internally but pnpm does not expose that
 * transitive package to application imports. This small low-level server supplies
 * the protocol surface McpAgent consumes without weakening package boundaries.
 */
class LowLevelMcpServer {
  private readonly handlers = new Map<string, RequestHandler>();
  private transport: McpTransport | null = null;

  setRequestHandler(method: "tools/list" | "tools/call", handler: RequestHandler): void {
    this.handlers.set(method, handler);
  }

  async connect(transport: McpTransport): Promise<void> {
    this.transport = transport;
    transport.onmessage = (message) => {
      void this.receive(message).catch((error) => transport.onerror?.(error));
    };
    await transport.start();
  }

  private async receive(message: JsonRpcRequest | readonly JsonRpcRequest[]): Promise<void> {
    if (isJsonRpcBatch(message)) {
      for (const item of message) await this.receiveOne(item);
      return;
    }
    await this.receiveOne(message);
  }

  private async receiveOne(request: JsonRpcRequest): Promise<void> {
    if (!this.transport || request.jsonrpc !== "2.0" || typeof request.method !== "string") return;
    if (request.method === "notifications/initialized") return;
    if (request.id === undefined) return;

    if (request.method === "initialize") {
      const requestedVersion =
        typeof request.params === "object" &&
        request.params !== null &&
        "protocolVersion" in request.params &&
        typeof request.params.protocolVersion === "string"
          ? request.params.protocolVersion
          : "2025-06-18";
      this.transport.setProtocolVersion?.(requestedVersion);
      await this.transport.send(
        {
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: requestedVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "session-party", version: "0.1.0" },
          },
        },
        { relatedRequestId: request.id },
      );
      return;
    }

    if (request.method === "ping") {
      await this.transport.send(
        { jsonrpc: "2.0", id: request.id, result: {} },
        { relatedRequestId: request.id },
      );
      return;
    }

    const handler = this.handlers.get(request.method);
    if (!handler) {
      await this.transport.send(
        {
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: `Method not found: ${request.method}` },
        },
        { relatedRequestId: request.id },
      );
      return;
    }

    try {
      const result = await handler(request.params);
      await this.transport.send(
        { jsonrpc: "2.0", id: request.id, result },
        { relatedRequestId: request.id },
      );
    } catch (error) {
      await this.transport.send(
        {
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Tool call failed",
          },
        },
        { relatedRequestId: request.id },
      );
    }
  }
}

const objectParams = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...value }
    : {};

export class SessionPartyMcp extends McpAgent<Env> {
  private readonly protocol = new LowLevelMcpServer();
  private currentUser: Principal | null = null;
  // McpAgent intentionally accepts an MCP SDK v1-compatible protocol object.
  override server = this.protocol as never;

  override async init(): Promise<void> {
    this.protocol.setRequestHandler("tools/list", async () => {
      const visibleTools = this.currentUser?.kind === "api-key"
        ? mcpToolsForPrincipal(this.currentUser, mcpTools)
        : [];
      return {
        tools: [
          ...visibleTools.map(({ name, description, inputSchema, outputSchema }) => ({
            name,
            description,
            inputSchema,
            outputSchema,
          })),
        ],
      };
    });
    this.protocol.setRequestHandler("tools/call", async (rawParams) => {
      if (!this.currentUser) throw new Error("Unauthenticated: a Bearer API key is required");
      const params = objectParams(rawParams);
      const name = params.name;
      const args = objectParams(params.arguments);
      const visibleTools = this.currentUser.kind === "api-key"
        ? mcpToolsForPrincipal(this.currentUser, mcpTools)
        : [];
      const descriptor = typeof name === "string"
        ? visibleTools.find((candidate) => candidate.name === name)
        : undefined;
      if (descriptor) {
        const operation = operationById[descriptor.operationId];
        if (!operation) throw new Error(`Unregistered operation: ${descriptor.operationId}`);
        const result = await runTransportOperation(
          this.env,
          this.currentUser,
          operation,
          args,
        );
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      throw new Error(`Unknown tool: ${String(name)}`);
    });
  }

  override async onConnect(connection: Connection, context: ConnectionContext): Promise<void> {
    const user = await apiKeyUserFromRequest(context.request, this.env);
    if (!user) {
      connection.close(4401, "Bearer API key required");
      return;
    }
    const boundApiKeyId = await this.ctx.storage.get<string>(MCP_BOUND_API_KEY_ID);
    if (boundApiKeyId && boundApiKeyId !== user.apiKeyId) {
      connection.close(4403, "MCP session belongs to a different API key");
      return;
    }
    if (!boundApiKeyId) await this.ctx.storage.put(MCP_BOUND_API_KEY_ID, user.apiKeyId);
    this.currentUser = user;
    await super.onConnect(connection, context);
  }
}

const app = new Hono<{ Bindings: Env }>();

app.route("/", publicationFeeds);
app.route(`${API}/auth`, auth);
app.get(`${API}/runtime-config`, (c) => c.json(publicRuntimeConfig(c.env)));
for (const registration of restRegistrations) {
  const operation = operationById[registration.operationId];
  if (!operation) throw new Error(`Unregistered operation: ${registration.operationId}`);
  app.on(registration.method, `${API}${registration.path}`, async (c) =>
    runRestOperation(
      c,
      await userFromRequest(c.req.raw, c.env) as Principal | null,
      operation,
      registration.input,
    ),
  );
}
for (const router of apiRouters) app.route(API, router);
app.post("/__local/smoke", async (c) => {
  if (!isExplicitLocalEnvironment(c.env)) return c.notFound();
  if (c.req.header("x-local-smoke-secret") !== sessionSecret(c.env)) {
    return c.json({ error: "Unauthenticated", message: "Local smoke secret required" }, 401);
  }

  const d1 = await c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
  const objectKey = "local-smoke/probe.txt";
  await c.env.FILES.put(objectKey, "local-smoke");
  const object = await c.env.FILES.get(objectKey);
  await c.env.FILES.delete(objectKey);

  const schedulerId = c.env.SCHEDULER.idFromName("mail");
  const scheduler = await c.env.SCHEDULER.get(schedulerId).fetch("https://scheduler/poke", {
    method: "POST",
    headers: { "x-session-party-internal": sessionSecret(c.env) },
  });
  return c.json({
    mode: "local-fake",
    d1: d1?.ok === 1,
    r2: object !== null,
    durableObject: scheduler.ok,
  });
});

app.all("/parties/*", async (c) => {
  const response = await routePartykitRequest(c.req.raw, c.env);
  return response ?? c.notFound();
});

const mcp = SessionPartyMcp.serve("/mcp");
const fetchMcp = async (request: Request, env: Env, ctx: ExecutionContext<unknown>): Promise<Response> => {
  if (!(await apiKeyUserFromRequest(request, env))) {
    return Response.json({ error: "Unauthenticated", message: "Bearer API key required" }, { status: 401 });
  }
  return mcp.fetch(request, env, ctx);
};

const publicSurfaceLabels: Readonly<Record<string, string>> = {
  sessions: "Sessions",
  speakers: "Speakers",
  agenda: "Agenda",
  schedule: "Schedule itinerary",
  gallery: "Speaker gallery",
};

export function publicProgramMetadata(pathname: string, eventName: string, canonicalUrl: string) {
  const surface = pathname.split("/").filter(Boolean).at(2) ?? "sessions";
  const label = publicSurfaceLabels[surface] ?? "Sessions";
  return {
    title: `${label} — ${eventName} — Session Party`,
    description: `${eventName} ${label.toLowerCase()}: the current published event program.`,
    canonicalUrl,
  };
}

async function fetchPublicProgram(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const [, , slug] = url.pathname.split("/");
  const assets = Reflect.get(env, "ASSETS") as Fetcher | undefined;
  const fetchAsset = (assetRequest: Request) => assets
    ? assets.fetch(assetRequest)
    : app.fetch(assetRequest, env);
  if (!slug) return fetchAsset(request);
  const agendaResponse = await app.fetch(
    new Request(`${url.origin}${API}/public/events/${encodeURIComponent(slug)}/agenda/published`),
    env,
  );
  if (!agendaResponse.ok) return fetchAsset(request);
  const agenda = await agendaResponse.json<{ eventName?: unknown }>();
  if (typeof agenda.eventName !== "string") return fetchAsset(request);
  const canonicalUrl = `${url.origin}${url.pathname}`;
  const metadata = publicProgramMetadata(url.pathname, agenda.eventName, canonicalUrl);
  // Workers Static Assets canonicalizes `/index.html` to `/`. Request the
  // canonical shell directly so the metadata response remains a 200 instead
  // of forwarding that redirect to public-program visitors and crawlers.
  const shell = await fetchAsset(new Request(`${url.origin}/`, request));
  return new HTMLRewriter()
    .on("title", { element(element) { element.setInnerContent(metadata.title); } })
    .on('meta[name="description"]', { element(element) { element.setAttribute("content", metadata.description); } })
    .on('meta[property="og:title"]', { element(element) { element.setAttribute("content", metadata.title); } })
    .on('meta[property="og:description"]', { element(element) { element.setAttribute("content", metadata.description); } })
    .on('meta[property="og:url"]', { element(element) { element.setAttribute("content", metadata.canonicalUrl); } })
    .on('meta[name="twitter:title"]', { element(element) { element.setAttribute("content", metadata.title); } })
    .on('meta[name="twitter:description"]', { element(element) { element.setAttribute("content", metadata.description); } })
    .on('link[rel="canonical"]', { element(element) { element.setAttribute("href", metadata.canonicalUrl); } })
    .transform(shell);
}

async function fetchEmbedShell(request: Request, env: Env): Promise<Response> {
  const assets = Reflect.get(env, "ASSETS") as Fetcher | undefined;
  const response = assets ? await assets.fetch(request) : await app.fetch(request, env);
  const headers = new Headers(response.headers);
  const contentSecurityPolicy = (headers.get("Content-Security-Policy") ?? "")
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => directive && !directive.toLowerCase().startsWith("frame-ancestors"));
  headers.set("Content-Security-Policy", [...contentSecurityPolicy, "frame-ancestors *"].join("; "));
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.delete("X-Frame-Options");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export const recoverMailScheduler = async (env: Env): Promise<void> => {
  const schedulerId = env.SCHEDULER.idFromName(MAIL_SCHEDULER_NAME);
  const response = await env.SCHEDULER.get(schedulerId).fetch("https://scheduler/poke", {
    method: "POST",
    headers: { "x-session-party-internal": sessionSecret(env) },
  });
  if (!response.ok) {
    throw new Error(`Mail scheduler recovery failed with status ${response.status}`);
  }
};

export const runAutomatedDueReminderCron = (env: Env, runAt: Date): Promise<{ readonly queuedCount: number; readonly runDate: string }> =>
  Effect.runPromise(enqueueAutomatedDueTaskReminders(runAt).pipe(Effect.provide(AppLayer(env))));

export { AirtableRateLimiter, AirtableSyncLane, EventRoom, Scheduler };
export default {
  fetch(request, env, ctx) {
    const pathname = new URL(request.url).pathname;
    return pathname === "/mcp"
      ? fetchMcp(request, env, ctx)
      : pathname.startsWith("/event/")
        ? fetchPublicProgram(request, env)
      : pathname.startsWith("/embed/")
        ? fetchEmbedShell(request, env)
      : app.fetch(request, env, ctx);
  },
  scheduled(controller, env, ctx) {
    ctx.waitUntil(recoverMailScheduler(env));
    const runAt = new Date(controller.scheduledTime);
    // The delivery key is date-scoped, so every-minute discovery is cheap to retry
    // and still queues at most one automated reminder per speaker per UTC day.
    ctx.waitUntil(runAutomatedDueReminderCron(env, runAt));
  },
} satisfies ExportedHandler<Env>;
