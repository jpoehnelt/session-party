import type { AnyOperationDef } from "contracts/operation";
import { publicAuthorization } from "contracts/principal";
import {
  CreateEmbedInput,
  EmbedDefinition,
  EmbedDefinitions,
  ListEmbedsInput,
  PublicEmbedInput,
  UpdateEmbedInput,
} from "./schema";
import {
  createEmbed,
  embedOrganizerAuthorization,
  getPublicEmbed,
  listEmbeds,
  updateEmbed,
} from "./service";

const createEmbedOperation = {
  id: "publication.createEmbed",
  kind: "command",
  input: CreateEmbedInput,
  output: EmbedDefinition,
  authorize: embedOrganizerAuthorization,
  invoke: createEmbed,
  rest: {
    method: "post",
    path: "/events/:eventId/embeds",
    input: { path: ["eventId"], body: ["name", "widget", "preset", "aesthetic", "accent", "trackId", "track", "fields", "enabled"] },
    summary: "Create a stable public embed definition",
    successStatus: 201,
  },
  idempotency: "none",
  concurrency: "none",
  emits: ["publication.embed.created"],
} as const satisfies AnyOperationDef;

const getPublicEmbedOperation = {
  id: "publication.getPublicEmbed",
  kind: "query",
  input: PublicEmbedInput,
  output: EmbedDefinition,
  authorize: publicAuthorization,
  invoke: getPublicEmbed,
  rest: {
    method: "get",
    path: "/public/events/:eventSlug/embeds/:embedId",
    input: { path: ["eventSlug", "embedId"] },
    summary: "Resolve one enabled public embed definition",
    successStatus: 200,
  },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} as const satisfies AnyOperationDef;

const listEmbedsOperation = {
  id: "publication.listEmbeds",
  kind: "query",
  input: ListEmbedsInput,
  output: EmbedDefinitions,
  authorize: embedOrganizerAuthorization,
  invoke: listEmbeds,
  rest: {
    method: "get",
    path: "/events/:eventId/embeds",
    input: { path: ["eventId"] },
    summary: "List saved embed definitions for an event",
    successStatus: 200,
  },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} as const satisfies AnyOperationDef;

const updateEmbedOperation = {
  id: "publication.updateEmbed",
  kind: "command",
  input: UpdateEmbedInput,
  output: EmbedDefinition,
  authorize: embedOrganizerAuthorization,
  invoke: updateEmbed,
  rest: {
    method: "put",
    path: "/events/:eventId/embeds/:embedId",
    input: { path: ["eventId", "embedId"], body: ["expectedVersion", "name", "widget", "preset", "aesthetic", "accent", "trackId", "track", "fields", "enabled"] },
    summary: "Update or disable a versioned embed definition",
    successStatus: 200,
  },
  idempotency: "none",
  concurrency: "required",
  emits: ["publication.embed.updated"],
} as const satisfies AnyOperationDef;

/** Bytewise operation-id order; registry generation must preserve this sequence. */
export const operations = [
  createEmbedOperation,
  getPublicEmbedOperation,
  listEmbedsOperation,
  updateEmbedOperation,
] as const satisfies readonly AnyOperationDef[];
