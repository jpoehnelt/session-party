import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import type { JsonObject, JsonValue } from "../contracts/domain";
import type { AnyOperationDef, RegistryOwnershipManifest } from "../contracts/operation";
import { HTTP_METHODS, type OpenApiDocument, type RestInputLocations } from "../contracts/routes";
import { JSONSchema } from "effect";

const root = process.cwd();
const featuresRoot = path.join(root, "src/features");
const registryOutputPath = path.join(root, "src/server/registry.gen.ts");
const clientRoutesOutputPath = path.join(root, "src/client/routes.gen.ts");
const camelCase = /^[a-z][A-Za-z0-9]*$/;
const operationId = /^[a-z][a-z0-9-]*\.[a-z][a-zA-Z0-9-]*$/;
const mcpName = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const partyIntent = /^[a-z][a-z0-9-]*\/[a-z][a-zA-Z0-9-]*$/;
const isJsonObject = (value: JsonValue): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const bytewise = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const exists = async (file: string): Promise<boolean> =>
  readFile(file).then(
    () => true,
    () => false,
  );
const identifier = (slice: string): string =>
  slice.replace(/[^a-zA-Z0-9_$]/g, "_").replace(/^[0-9]/, "_$&");

const stableValue = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => bytewise(left, right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
};
const stableJson = (value: JsonValue, space = 0): string => JSON.stringify(stableValue(value), null, space);
const fail = (message: string): never => {
  throw new Error(`registry generation failed: ${message}`);
};
const claim = (claims: Map<string, string>, key: string, owner: string, kind: string): void => {
  const previous = claims.get(key);
  if (previous) fail(`duplicate ${kind} '${key}' claimed by ${previous} and ${owner}`);
  claims.set(key, owner);
};

const assertCamelCaseSchema = (schema: JsonValue, owner: string): void => {
  if (Array.isArray(schema)) {
    for (const value of schema) assertCamelCaseSchema(value, owner);
    return;
  }
  if (!isJsonObject(schema)) return;
  const properties = schema.properties;
  if (properties && isJsonObject(properties)) {
    for (const name of Object.keys(properties)) {
      if (!camelCase.test(name)) fail(`${owner} has non-camelCase wire field '${name}'`);
    }
  }
  for (const value of Object.values(schema)) assertCamelCaseSchema(value, owner);
};

const inputFields = (schema: JsonObject): ReadonlySet<string> => {
  const properties = schema.properties;
  return properties && typeof properties === "object" && !Array.isArray(properties)
    ? new Set(Object.keys(properties))
    : new Set();
};

const validateLocations = (
  owner: string,
  routePath: string,
  locations: RestInputLocations,
  schema: JsonObject,
): void => {
  const groups = [
    ...(locations.path ?? []),
    ...(locations.query ?? []),
    ...Object.keys(locations.headers ?? {}),
    ...(locations.body === "all" ? [] : (locations.body ?? [])),
  ];
  const seen = new Set<string>();
  for (const field of groups) {
    if (!camelCase.test(field)) fail(`${owner} REST input field '${field}' is not camelCase`);
    if (seen.has(field)) fail(`${owner} maps REST input field '${field}' more than once`);
    seen.add(field);
  }
  if (locations.body === "all" && groups.length > 0) {
    fail(`${owner} uses body:'all' with another REST input location`);
  }
  const fields = inputFields(schema);
  if (fields.size > 0 && locations.body !== "all") {
    for (const field of fields) if (!seen.has(field)) fail(`${owner} does not map input field '${field}'`);
    for (const field of seen) if (!fields.has(field)) fail(`${owner} maps unknown input field '${field}'`);
  }
  const pathFields = new Set(Array.from(routePath.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g), (match) => match[1]!));
  const declaredPath = new Set(locations.path ?? []);
  if (pathFields.size !== declaredPath.size || [...pathFields].some((field) => !declaredPath.has(field))) {
    fail(`${owner} REST path parameters do not match input.path`);
  }
};

const projectObjectSchema = (schema: JsonObject, fields: readonly string[]): JsonObject => {
  const properties = schema.properties;
  const required = schema.required;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return schema;
  const selected = Object.fromEntries(
    fields.map((field) => [field, Reflect.get(properties, field) as JsonValue]),
  );
  const selectedRequired = Array.isArray(required)
    ? required.filter((field): field is string => typeof field === "string" && fields.includes(field))
    : [];
  return {
    type: "object",
    properties: selected,
    required: selectedRequired,
    additionalProperties: false,
  };
};

const propertySchema = (schema: JsonObject, field: string): JsonValue => {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return fail(`cannot project OpenAPI field '${field}' from a non-object input schema`);
  }
  const value = Reflect.get(properties, field) as JsonValue | undefined;
  return value ?? fail(`cannot project missing OpenAPI field '${field}'`);
};

const slices = (await readdir(featuresRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort(bytewise);
const files = await Promise.all(
  slices.map(async (slice) => ({
    slice,
    id: identifier(slice),
    operations: await exists(path.join(featuresRoot, slice, "operations.ts")),
  })),
);

type ClientRoute = {
  readonly source: string;
  readonly importPath: string;
  readonly path: string;
  readonly layout?: "app" | "bare";
  readonly contentWidth?: "compact" | "standard" | "wide" | "canvas";
};
const supportRouteFile = /\.(?:test|browser|stories)\.tsx$/;
const routeExport = (source: string, name: string): string | undefined => {
  const match = source.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(["'])(.*?)\\1`));
  return match?.[2];
};
const clientRoutes: ClientRoute[] = [];
for (const slice of slices) {
  const routesRoot = path.join(featuresRoot, slice, "routes");
  const entries = await readdir(routesRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".tsx") || supportRouteFile.test(entry.name)) continue;
    const absolutePath = path.join(routesRoot, entry.name);
    const source = await readFile(absolutePath, "utf8");
    const routePath = routeExport(source, "path")
      ?? fail(`src/features/${slice}/routes/${entry.name} must export a literal path`);
    const layout = routeExport(source, "layout");
    const contentWidth = routeExport(source, "contentWidth");
    if (layout !== undefined && layout !== "app" && layout !== "bare") {
      fail(`src/features/${slice}/routes/${entry.name} has invalid layout '${layout}'`);
    }
    if (contentWidth !== undefined && !["compact", "standard", "wide", "canvas"].includes(contentWidth)) {
      fail(`src/features/${slice}/routes/${entry.name} has invalid contentWidth '${contentWidth}'`);
    }
    clientRoutes.push({
      source: `src/features/${slice}/routes/${entry.name}`,
      importPath: `../features/${slice}/routes/${entry.name.slice(0, -4)}`,
      path: routePath,
      ...(layout === undefined ? {} : { layout: layout as ClientRoute["layout"] }),
      ...(contentWidth === undefined ? {} : { contentWidth: contentWidth as ClientRoute["contentWidth"] }),
    });
  }
}
clientRoutes.sort((left, right) => bytewise(left.source, right.source));
const clientRouteClaims = new Map<string, string>();
for (const route of clientRoutes) claim(clientRouteClaims, route.path, route.source, "client route");

type OwnedOperation = {
  readonly owner: string;
  readonly source: string;
  readonly exportIndex: number;
  readonly operation: AnyOperationDef;
  readonly inputSchema: JsonObject;
  readonly outputSchema: JsonObject;
  readonly openApiInputSchema: JsonObject;
  readonly openApiOutputSchema: JsonObject;
};
const ownedOperations: OwnedOperation[] = [];
for (const file of files.filter((candidate) => candidate.operations)) {
  const source = `src/features/${file.slice}/operations.ts`;
  const module = (await import(pathToFileURL(path.join(root, source)).href)) as { operations?: unknown };
  const operations = module.operations;
  if (!Array.isArray(operations)) fail(`${source} must export an operations array`);
  const operationList = operations as unknown[];
  for (const [exportIndex, candidate] of operationList.entries()) {
    if (!candidate || typeof candidate !== "object") fail(`${source} operations[${exportIndex}] is invalid`);
    const operation = candidate as AnyOperationDef;
    if (typeof operation.id !== "string" || !operationId.test(operation.id)) {
      fail(`${source} operations[${exportIndex}] has invalid operation id '${String(operation.id)}'`);
    }
    if (!operation.id.startsWith(`${file.slice}.`)) {
      fail(`${operation.id} is owned by '${file.slice}' but uses another namespace`);
    }
    if (operation.kind !== "query" && operation.kind !== "command") fail(`${operation.id} has invalid kind`);
    if (typeof operation.invoke !== "function") fail(`${operation.id} has no invoke function`);
    if (!operation.input || !operation.output || !operation.authorize) fail(`${operation.id} is incomplete`);
    if (!["required", "optional", "none"].includes(operation.idempotency)) {
      fail(`${operation.id} has invalid idempotency metadata`);
    }
    if (operation.concurrency !== "required" && operation.concurrency !== "none") {
      fail(`${operation.id} has invalid concurrency metadata`);
    }
    if (!Array.isArray(operation.emits)) fail(`${operation.id} has invalid emitted events`);
    const inputSchema = JSONSchema.make(operation.input, { target: "jsonSchema2020-12" }) as unknown as JsonObject;
    const outputSchema = JSONSchema.make(operation.output, { target: "jsonSchema2020-12" }) as unknown as JsonObject;
    const openApiInputSchema = JSONSchema.make(operation.input, { target: "openApi3.1" }) as unknown as JsonObject;
    const openApiOutputSchema = JSONSchema.make(operation.output, { target: "openApi3.1" }) as unknown as JsonObject;
    assertCamelCaseSchema(inputSchema, operation.id);
    assertCamelCaseSchema(outputSchema, operation.id);
    ownedOperations.push({
      owner: file.slice,
      source,
      exportIndex,
      operation,
      inputSchema,
      outputSchema,
      openApiInputSchema,
      openApiOutputSchema,
    });
  }
}
ownedOperations.sort((left, right) => bytewise(left.operation.id, right.operation.id));

const ids = new Map<string, string>();
const rests = new Map<string, string>();
const mcps = new Map<string, string>();
const parties = new Map<string, string>();
for (const owned of ownedOperations) {
  const operation = owned.operation;
  claim(ids, operation.id, owned.source, "operation id");
  if (operation.rest) {
    if (!HTTP_METHODS.includes(operation.rest.method)) fail(`${operation.id} has invalid REST method`);
    if (!operation.rest.path.startsWith("/")) fail(`${operation.id} REST path must start with '/'`);
    validateLocations(operation.id, operation.rest.path, operation.rest.input, owned.openApiInputSchema);
    claim(rests, `${operation.rest.method.toUpperCase()} ${operation.rest.path}`, operation.id, "REST route");
  }
  if (operation.mcp) {
    if (!mcpName.test(operation.mcp.name)) fail(`${operation.id} has invalid MCP name '${operation.mcp.name}'`);
    if (operation.authorize.kind === "browser-session" || operation.authorize.kind === "public") {
      fail(`${operation.id} MCP tool must use API-key-compatible authorization`);
    }
    if (operation.authorize.kind === "event" && operation.authorize.apiKey.kind === "deny") {
      fail(`${operation.id} MCP tool cannot deny API-key principals`);
    }
    claim(mcps, operation.mcp.name, operation.id, "MCP name");
  }
  if (operation.party) {
    if (!partyIntent.test(operation.party.intentType)) {
      fail(`${operation.id} has invalid Party intent type '${operation.party.intentType}'`);
    }
    if (!operation.party.intentType.startsWith(`${owned.owner}/`)) {
      fail(`${operation.id} Party intent is owned by another namespace`);
    }
    claim(parties, operation.party.intentType, operation.id, "Party intent type");
  }
}

const restRegistrations = ownedOperations.flatMap(({ operation }) =>
  operation.rest
    ? [{
        operationId: operation.id,
        method: operation.rest.method,
        path: operation.rest.path,
        input: operation.rest.input,
        successStatus: operation.rest.successStatus ?? 200,
      }]
    : [],
);
const mcpTools = ownedOperations.flatMap(({ operation, inputSchema, outputSchema }) =>
  operation.mcp
    ? [{
        operationId: operation.id,
        name: operation.mcp.name,
        description: operation.mcp.description,
        inputSchema,
        outputSchema,
        requiredScopes: operation.authorize.kind === "event"
          && operation.authorize.apiKey.kind === "api-key"
          ? operation.authorize.apiKey.scopes
          : operation.mcp.scopes ?? [],
      }]
    : [],
);
const partyIntents = ownedOperations.flatMap(({ operation, inputSchema, outputSchema }) =>
  operation.party
    ? [{ operationId: operation.id, intentType: operation.party.intentType, inputSchema, outputSchema }]
    : [],
);
const ownershipManifest: RegistryOwnershipManifest = {
  operations: ownedOperations.map(({ operation, owner, source }) => ({ operationId: operation.id, owner, source })),
  rest: restRegistrations.map(({ operationId: id, method, path: routePath }) => ({ operationId: id, method, path: routePath })),
  mcp: mcpTools.map(({ operationId: id, name }) => ({ operationId: id, name })),
  party: partyIntents.map(({ operationId: id, intentType }) => ({ operationId: id, intentType })),
};

const paths: Record<string, JsonValue> = {};
for (const owned of ownedOperations.filter(({ operation }) => operation.rest)) {
  const operation = owned.operation;
  const rest = operation.rest!;
  const parameters: JsonValue[] = [];
  for (const field of rest.input.path ?? []) {
    parameters.push({
      name: field,
      in: "path",
      required: true,
      schema: propertySchema(owned.openApiInputSchema, field),
    });
  }
  for (const field of rest.input.query ?? []) {
    const required = Array.isArray(owned.openApiInputSchema.required) && owned.openApiInputSchema.required.includes(field);
    parameters.push({
      name: field,
      in: "query",
      required,
      schema: propertySchema(owned.openApiInputSchema, field),
    });
  }
  for (const [field, header] of Object.entries(rest.input.headers ?? {}).sort(([left], [right]) => bytewise(left, right))) {
    const required = Array.isArray(owned.openApiInputSchema.required) && owned.openApiInputSchema.required.includes(field);
    parameters.push({
      name: header,
      in: "header",
      required,
      schema: propertySchema(owned.openApiInputSchema, field),
    });
  }
  const bodySchema = rest.input.body === "all"
    ? owned.openApiInputSchema
    : rest.input.body
      ? projectObjectSchema(owned.openApiInputSchema, rest.input.body)
      : undefined;
  const responseStatus = String(rest.successStatus ?? 200);
  const entry: JsonObject = {
    operationId: operation.id,
    summary: rest.summary ?? operation.id,
    ...(rest.description ? { description: rest.description } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(bodySchema
      ? { requestBody: { required: true, content: { "application/json": { schema: bodySchema } } } }
      : {}),
    responses: {
      [responseStatus]: {
        description: "Successful operation",
        ...(responseStatus === "204"
          ? {}
          : { content: { "application/json": { schema: owned.openApiOutputSchema } } }),
      },
    },
    "x-operation-kind": operation.kind,
    "x-authorization": operation.authorize as unknown as JsonValue,
    "x-idempotency": operation.idempotency,
    "x-concurrency": operation.concurrency,
    "x-emits": operation.emits,
  };
  const openApiPath = rest.path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, "{$1}");
  const pathItem = (paths[openApiPath] as JsonObject | undefined) ?? {};
  paths[openApiPath] = { ...pathItem, [rest.method]: entry };
}
const openApi: OpenApiDocument = {
  openapi: "3.1.0",
  info: { title: "session-party API", version: "0.1.0" },
  paths,
};

const imports: string[] = [];
for (const file of files) {
  if (file.operations) imports.push(`import { operations as ${file.id}Operations } from "../features/${file.slice}/operations";`);
}
const operationEntries = ownedOperations.map(({ owner, exportIndex }) => `${identifier(owner)}Operations[${exportIndex}]`);
const generated = `${imports.length ? `${imports.join("\n")}\n` : ""}import type { McpToolDescriptor } from "contracts/mcp";
import type { AnyOperationDef, PartyIntentDescriptor, RegistryOwnershipManifest } from "contracts/operation";
import type { OpenApiDocument, RestRegistrationDescriptor } from "contracts/routes";
import type { PartyHandler } from "./party/types";

// Generated by scripts/gen.ts. Do not edit by hand.
export const operations: readonly AnyOperationDef[] = [${operationEntries.join(", ")}];

export const operationById = Object.fromEntries(
  operations.map((operation) => [operation.id, operation]),
) as Readonly<Record<string, AnyOperationDef>>;

export const restRegistrations: readonly RestRegistrationDescriptor[] = ${stableJson(restRegistrations as unknown as JsonValue, 2)};

export const mcpTools: readonly McpToolDescriptor[] = ${stableJson(mcpTools as unknown as JsonValue, 2)};

export const partyIntents: readonly PartyIntentDescriptor[] = ${stableJson(partyIntents as unknown as JsonValue, 2)};

export const openApi = ${stableJson(openApi, 2)} as const satisfies OpenApiDocument;

export const ownershipManifest = ${stableJson(ownershipManifest as unknown as JsonValue, 2)} as const satisfies RegistryOwnershipManifest;

// Removed once the last generic EventRoom compatibility branch is deleted.
export const partyHandlers: Readonly<Record<string, PartyHandler>> = {};
`;

const generatedClientRoutes = `import type { ClientRouteDefinition } from "./route-discovery";

// Generated by scripts/gen.ts. Do not edit by hand.
export const generatedClientRoutes = [
${clientRoutes.map((route) => `  {
    path: ${JSON.stringify(route.path)},${route.layout ? `\n    layout: ${JSON.stringify(route.layout)},` : ""}${route.contentWidth ? `\n    contentWidth: ${JSON.stringify(route.contentWidth)},` : ""}
    load: () => import(${JSON.stringify(route.importPath)}),
  },`).join("\n")}
] as const satisfies readonly ClientRouteDefinition[];
`;

if (process.argv.includes("--check")) {
  const [currentRegistry, currentClientRoutes] = await Promise.all([
    readFile(registryOutputPath, "utf8").catch(() => ""),
    readFile(clientRoutesOutputPath, "utf8").catch(() => ""),
  ]);
  if (currentRegistry !== generated || currentClientRoutes !== generatedClientRoutes) {
    console.error("generated registry or client routes are stale; run pnpm gen");
    process.exitCode = 1;
  }
} else {
  await Promise.all([
    writeFile(registryOutputPath, generated),
    writeFile(clientRoutesOutputPath, generatedClientRoutes),
  ]);
}
