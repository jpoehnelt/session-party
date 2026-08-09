import { Validation } from "contracts/errors";
import type { ToolDef } from "contracts/mcp";
import type { Principal } from "contracts/principal";
import { API } from "contracts/routes";
import { Effect, JSONSchema, Schema } from "effect";
import { Hono } from "hono";
import { McpAgent } from "agents/mcp";
import { routePartykitRequest, type Connection, type ConnectionContext } from "partyserver";
import auth, { apiKeyUserFromRequest, userFromRequest } from "./auth";
import { runMcp, runRestOperation, runTransportOperation } from "./adapt";
import { EventRoom } from "./party/EventRoom";
import { Scheduler } from "./party/Scheduler";
import {
  apiRouters,
  mcpTools,
  operationById,
  restRegistrations,
  tools,
} from "./registry.gen";
import { isExplicitLocalEnvironment, sessionSecret } from "./services";

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

const mcpTool = (tool: ToolDef) => {
  const inputSchema = JSONSchema.make(tool.args);
  return {
    name: tool.name,
    description: tool.description,
    inputSchema,
  };
};

export class SessionPartyMcp extends McpAgent<Env> {
  private readonly protocol = new LowLevelMcpServer();
  private currentUser: Principal | null = null;
  // McpAgent intentionally accepts an MCP SDK v1-compatible protocol object.
  override server = this.protocol as never;

  override async init(): Promise<void> {
    this.protocol.setRequestHandler("tools/list", async () => ({
      tools: [
        ...mcpTools.map(({ name, description, inputSchema, outputSchema }) => ({
          name,
          description,
          inputSchema,
          outputSchema,
        })),
        ...tools.map(mcpTool),
      ],
    }));
    this.protocol.setRequestHandler("tools/call", async (rawParams) => {
      if (!this.currentUser) throw new Error("Unauthenticated: a Bearer API key is required");
      const params = objectParams(rawParams);
      const name = params.name;
      const args = objectParams(params.arguments);
      const descriptor = typeof name === "string"
        ? mcpTools.find((candidate) => candidate.name === name)
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

      const tool = typeof name === "string"
        ? tools.find((candidate) => candidate.name === name)
        : undefined;
      if (!tool) throw new Error(`Unknown tool: ${String(name)}`);
      const effect = Schema.decodeUnknown(tool.args)(args).pipe(
        Effect.mapError((error) => new Validation({ message: String(error) })),
        Effect.flatMap((decoded) => tool.handler(decoded)),
      );
      const result = await runMcp(this.env, this.currentUser, effect);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    });
  }

  override async onConnect(connection: Connection, context: ConnectionContext): Promise<void> {
    const user = await apiKeyUserFromRequest(context.request, this.env);
    if (!user) {
      connection.close(4401, "Bearer API key required");
      return;
    }
    this.currentUser = user;
    await super.onConnect(connection, context);
  }
}

const app = new Hono<{ Bindings: Env }>();

app.route(`${API}/auth`, auth);
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

  const schedulerId = c.env.SCHEDULER.idFromName("local-smoke");
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

export { EventRoom, Scheduler };
export default {
  fetch(request, env, ctx) {
    return new URL(request.url).pathname === "/mcp"
      ? fetchMcp(request, env, ctx)
      : app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

