import { browserSessionAuthorization, authenticatedAuthorization } from "contracts/principal";
import { Schema } from "effect";
import { CreateEventInput, GetEventInput, createEvent, getEvent, listEvents, updateEvent } from "./service";
import { EventOutput, UpdateEventInput } from "./schema";

const UpdateEventOperationInput = Schema.extend(GetEventInput, UpdateEventInput);

export const operations = [
  {
    id: "events.create",
    kind: "command",
    input: CreateEventInput,
    output: EventOutput,
    authorize: browserSessionAuthorization,
    invoke: createEvent,
    rest: {
      method: "post",
      path: "/events",
      input: { body: "all" },
      successStatus: 200,
    },
    idempotency: "none",
    concurrency: "none",
    emits: [],
  },
  {
    id: "events.list",
    kind: "query",
    input: Schema.Struct({}),
    output: Schema.Array(EventOutput),
    authorize: authenticatedAuthorization,
    invoke: listEvents,
    rest: {
      method: "get",
      path: "/events",
      input: {},
      successStatus: 200,
    },
    mcp: {
      name: "list_events",
      description: "List events accessible to the current user or API key.",
    },
    idempotency: "none",
    concurrency: "none",
    emits: [],
  },
  {
    id: "events.get",
    kind: "query",
    input: GetEventInput,
    output: EventOutput,
    authorize: authenticatedAuthorization,
    invoke: ({ idOrSlug }: typeof GetEventInput.Type) => getEvent(idOrSlug),
    rest: {
      method: "get",
      path: "/events/:idOrSlug",
      input: { path: ["idOrSlug"] },
      successStatus: 200,
    },
    mcp: {
      name: "get_event",
      description: "Get an event by its id or slug.",
    },
    party: { intentType: "events/get" },
    idempotency: "none",
    concurrency: "none",
    emits: [],
  },
  {
    id: "events.update",
    kind: "command",
    input: UpdateEventOperationInput,
    output: EventOutput,
    authorize: authenticatedAuthorization,
    invoke: ({ idOrSlug, ...input }: typeof UpdateEventOperationInput.Type) =>
      updateEvent(idOrSlug, input),
    rest: {
      method: "patch",
      path: "/events/:idOrSlug",
      input: { path: ["idOrSlug"], body: ["name", "slug", "description", "location", "timezone", "startsAt", "endsAt", "accentColor"] },
      successStatus: 200,
    },
    idempotency: "none",
    concurrency: "none",
    emits: [],
  },
] as const;
