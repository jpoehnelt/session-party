import type { AnyOperationDef } from "contracts/operation";
import {
  authenticatedAuthorization,
  eventAuthorization,
  publicAuthorization,
} from "contracts/principal";
import {
  AgendaSnapshot,
  PublishedAgenda,
  PublishAgendaInput,
} from "@/features/agenda/schema";
import { PublicationBySlugInput } from "./schema";
import {
  getPublicationStatus,
  getPublicSchedule,
  publishSchedule,
} from "./service";

const publicationWriteAuthorization = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "api-key", scopes: ["agenda:write"] },
);

export const getScheduleOperation = {
  id: "publication.getSchedule",
  kind: "query",
  input: PublicationBySlugInput,
  output: PublishedAgenda,
  authorize: publicAuthorization,
  invoke: getPublicSchedule,
  rest: {
    method: "get",
    path: "/publication/:eventSlug/schedule",
    input: { path: ["eventSlug"] },
    summary: "Get the public schedule",
    successStatus: 200,
  },
  mcp: {
    name: "publication_get_schedule",
    description: "Read the latest immutable public schedule revision for an event slug.",
  },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} as const satisfies AnyOperationDef;

export const getStatusOperation = {
  id: "publication.getStatus",
  kind: "query",
  input: PublicationBySlugInput,
  output: AgendaSnapshot,
  authorize: authenticatedAuthorization,
  invoke: getPublicationStatus,
  rest: {
    method: "get",
    path: "/publication/:eventSlug/status",
    input: { path: ["eventSlug"] },
    summary: "Get organizer publication status",
    successStatus: 200,
  },
  mcp: {
    name: "publication_get_status",
    description: "Read organizer-only schedule publication status and the current private agenda revision.",
  },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} as const satisfies AnyOperationDef;

export const publishScheduleOperation = {
  id: "publication.publishSchedule",
  kind: "command",
  input: PublishAgendaInput,
  output: PublishedAgenda,
  authorize: publicationWriteAuthorization,
  invoke: publishSchedule,
  rest: {
    method: "post",
    path: "/events/:eventId/publication/schedule",
    input: {
      path: ["eventId"],
      body: [
        "expectedRevision",
        "expectedWorkspaceVersion",
        "expectedEventVersion",
        "idempotencyKey",
      ],
    },
    summary: "Publish a schedule revision",
    successStatus: 201,
  },
  mcp: {
    name: "publication_publish_schedule",
    description: "Publish an immutable schedule projection containing only confirmed talks and visible speakers.",
  },
  idempotency: "required",
  concurrency: "required",
  emits: ["agenda/published"],
} as const satisfies AnyOperationDef;

/** Bytewise order is deliberate and matches the registry generator comparator. */
export const operations = [
  getScheduleOperation,
  getStatusOperation,
  publishScheduleOperation,
] as const satisfies readonly AnyOperationDef[];
