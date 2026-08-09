import type { AnyOperationDef } from "contracts/operation";
import { browserSessionAuthorization, eventAuthorization, authenticatedAuthorization } from "contracts/principal";
import { Schema } from "effect";
import {
  CreateEventInput,
  GetEventInput,
  addEventMember,
  createEvent,
  getEvent,
  listEventMembers,
  listEvents,
  removeEventMember,
  updateEvent,
  updateEventMember,
} from "./service";
import {
  AddEventMemberInput,
  AddEventMemberOutput,
  EventMember,
  EventOutput,
  ListEventMembersInput,
  RemoveEventMemberInput,
  RemoveEventMemberOutput,
  UpdateEventInput,
  UpdateEventMemberInput,
  UpdateEventMemberOutput,
} from "./schema";

const UpdateEventOperationInput = Schema.extend(GetEventInput, UpdateEventInput);

const memberManagementAuthorization = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "deny" },
);

/** Keep the pre-generated first four positions stable until the integrator runs pnpm gen. */
export const operations = [
  {
    id: "events.create", kind: "command", input: CreateEventInput, output: EventOutput,
    authorize: browserSessionAuthorization, invoke: createEvent,
    rest: { method: "post", path: "/events", input: { body: "all" }, successStatus: 200 },
    idempotency: "none", concurrency: "none", emits: [],
  },
  {
    id: "events.list", kind: "query", input: Schema.Struct({}), output: Schema.Array(EventOutput),
    authorize: authenticatedAuthorization, invoke: listEvents,
    rest: { method: "get", path: "/events", input: {}, successStatus: 200 },
    mcp: { name: "list_events", description: "List events accessible to the current user or API key." },
    idempotency: "none", concurrency: "none", emits: [],
  },
  {
    id: "events.get", kind: "query", input: GetEventInput, output: EventOutput,
    authorize: authenticatedAuthorization, invoke: ({ idOrSlug }: typeof GetEventInput.Type) => getEvent(idOrSlug),
    rest: { method: "get", path: "/events/:idOrSlug", input: { path: ["idOrSlug"] }, successStatus: 200 },
    mcp: { name: "get_event", description: "Get an event by its id or slug." },
    party: { intentType: "events/get" }, idempotency: "none", concurrency: "none", emits: [],
  },
  {
    id: "events.update", kind: "command", input: UpdateEventOperationInput, output: EventOutput,
    authorize: authenticatedAuthorization,
    invoke: ({ idOrSlug, ...input }: typeof UpdateEventOperationInput.Type) => updateEvent(idOrSlug, input),
    rest: { method: "patch", path: "/events/:idOrSlug", input: { path: ["idOrSlug"], body: ["name", "slug", "description", "location", "timezone", "startsAt", "endsAt", "accentColor"] }, successStatus: 200 },
    idempotency: "none", concurrency: "none", emits: [],
  },
  {
    id: "events.addMember", kind: "command", input: AddEventMemberInput, output: AddEventMemberOutput,
    authorize: memberManagementAuthorization, invoke: addEventMember,
    rest: { method: "post", path: "/events/:idOrSlug/members", input: { path: ["idOrSlug"], body: ["email", "role", "idempotencyKey"] }, summary: "Add an existing authenticated user to an event", description: "Looks up an already authenticated account by normalized email. It does not send an invitation email.", successStatus: 201 },
    mcp: { name: "add_event_member", description: "Add an existing authenticated account to an event. This does not create or email an invitation." },
    idempotency: "required", concurrency: "none", emits: ["events.member.added"],
  } satisfies AnyOperationDef,
  {
    id: "events.listMembers", kind: "query", input: ListEventMembersInput, output: Schema.Array(EventMember),
    authorize: memberManagementAuthorization, invoke: listEventMembers,
    rest: { method: "get", path: "/events/:idOrSlug/members", input: { path: ["idOrSlug"] }, summary: "List event members", successStatus: 200 },
    mcp: { name: "list_event_members", description: "List existing event members and their roles." },
    idempotency: "none", concurrency: "none", emits: [],
  } satisfies AnyOperationDef,
  {
    id: "events.removeMember", kind: "command", input: RemoveEventMemberInput, output: RemoveEventMemberOutput,
    authorize: memberManagementAuthorization, invoke: removeEventMember,
    rest: { method: "delete", path: "/events/:idOrSlug/members/:memberId", input: { path: ["idOrSlug", "memberId"], body: ["expectedVersion", "idempotencyKey"] }, summary: "Remove an event member safely", successStatus: 200 },
    mcp: { name: "remove_event_member", description: "Remove a member while retaining at least one event owner." },
    idempotency: "required", concurrency: "required", emits: ["events.member.removed"],
  } satisfies AnyOperationDef,
  {
    id: "events.updateMember", kind: "command", input: UpdateEventMemberInput, output: UpdateEventMemberOutput,
    authorize: memberManagementAuthorization, invoke: updateEventMember,
    rest: { method: "patch", path: "/events/:idOrSlug/members/:memberId", input: { path: ["idOrSlug", "memberId"], body: ["role", "expectedVersion", "idempotencyKey"] }, summary: "Change an event member role safely", successStatus: 200 },
    mcp: { name: "update_event_member", description: "Change a member role with optimistic concurrency and last-owner protection." },
    idempotency: "required", concurrency: "required", emits: ["events.member.updated"],
  } satisfies AnyOperationDef,
] as const;
