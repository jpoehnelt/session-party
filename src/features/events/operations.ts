import type { AnyOperationDef } from "contracts/operation";
import { browserSessionAuthorization, eventAuthorization, authenticatedAuthorization } from "contracts/principal";
import { Schema } from "effect";
import {
  CreateEventInput,
  GetEventInput,
  acceptReviewerInvitation,
  addEventMember,
  createEventApiKey,
  createEvent,
  createReviewerInvitation,
  getEvent,
  listEventMembers,
  listEventAccess,
  listEventApiKeys,
  listEvents,
  listReviewerInvitations,
  removeEventMember,
  revokeEventApiKey,
  updateEvent,
  updateEventMember,
} from "./service";
import {
  AcceptReviewerInvitationInput,
  AcceptReviewerInvitationOutput,
  AddEventMemberInput,
  AddEventMemberOutput,
  CreateEventApiKeyInput,
  CreateEventApiKeyOutput,
  CreateReviewerInvitationInput,
  CreateReviewerInvitationOutput,
  EventApiKey,
  EventAccess,
  EventMember,
  EventOutput,
  ListEventMembersInput,
  ListReviewerInvitationsInput,
  ListEventApiKeysInput,
  RemoveEventMemberInput,
  RemoveEventMemberOutput,
  ReviewerInvitation,
  RevokeEventApiKeyInput,
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
    id: "events.listAccess", kind: "query", input: Schema.Struct({}), output: Schema.Array(EventAccess),
    authorize: browserSessionAuthorization, invoke: listEventAccess,
    rest: { method: "get", path: "/me/events", input: {}, summary: "List event-scoped browser destinations for the signed-in user", successStatus: 200 },
    idempotency: "none", concurrency: "none", emits: [],
  } satisfies AnyOperationDef,
  {
    id: "events.addMember", kind: "command", input: AddEventMemberInput, output: AddEventMemberOutput,
    authorize: memberManagementAuthorization, invoke: addEventMember,
    rest: { method: "post", path: "/events/:eventId/members", input: { path: ["eventId"], body: ["email", "role", "idempotencyKey"] }, summary: "Add an existing authenticated user to an event", description: "Looks up an already authenticated account by normalized email. It does not send an invitation email.", successStatus: 201 },
    idempotency: "required", concurrency: "none", emits: ["events.member.added"],
  } satisfies AnyOperationDef,
  {
    id: "events.acceptReviewerInvitation", kind: "command", input: AcceptReviewerInvitationInput, output: AcceptReviewerInvitationOutput,
    authorize: browserSessionAuthorization, invoke: acceptReviewerInvitation,
    rest: {
      method: "post", path: "/reviewer-invitations/accept",
      input: { headers: { idempotencyKey: "idempotency-key", requestId: "x-request-id" }, body: ["token"] },
      summary: "Accept an email-matched reviewer invitation using an authenticated browser session", successStatus: 200,
    },
    idempotency: "required", concurrency: "required", emits: ["events.reviewerInvitation.accepted", "events.member.added"],
  } satisfies AnyOperationDef,
  {
    id: "events.createReviewerInvitation", kind: "command", input: CreateReviewerInvitationInput, output: CreateReviewerInvitationOutput,
    authorize: memberManagementAuthorization, invoke: createReviewerInvitation,
    rest: {
      method: "post", path: "/events/:eventId/reviewer-invitations",
      input: { path: ["eventId"], headers: { idempotencyKey: "idempotency-key", requestId: "x-request-id" }, body: ["email"] },
      summary: "Invite someone by email to join an event as a reviewer", successStatus: 201,
    },
    idempotency: "required", concurrency: "none", emits: ["events.reviewerInvitation.created"],
  } satisfies AnyOperationDef,
  {
    id: "events.listMembers", kind: "query", input: ListEventMembersInput, output: Schema.Array(EventMember),
    authorize: memberManagementAuthorization, invoke: listEventMembers,
    rest: { method: "get", path: "/events/:eventId/members", input: { path: ["eventId"] }, summary: "List event members", successStatus: 200 },
    idempotency: "none", concurrency: "none", emits: [],
  } satisfies AnyOperationDef,
  {
    id: "events.listReviewerInvitations", kind: "query", input: ListReviewerInvitationsInput, output: Schema.Array(ReviewerInvitation),
    authorize: memberManagementAuthorization, invoke: listReviewerInvitations,
    rest: { method: "get", path: "/events/:eventId/reviewer-invitations", input: { path: ["eventId"] }, summary: "List reviewer invitations and delivery state", successStatus: 200 },
    idempotency: "none", concurrency: "none", emits: [],
  } satisfies AnyOperationDef,
  {
    id: "events.removeMember", kind: "command", input: RemoveEventMemberInput, output: RemoveEventMemberOutput,
    authorize: memberManagementAuthorization, invoke: removeEventMember,
    rest: { method: "delete", path: "/events/:eventId/members/:memberId", input: { path: ["eventId", "memberId"], body: ["expectedVersion", "idempotencyKey"] }, summary: "Remove an event member safely", successStatus: 200 },
    idempotency: "required", concurrency: "required", emits: ["events.member.removed"],
  } satisfies AnyOperationDef,
  {
    id: "events.updateMember", kind: "command", input: UpdateEventMemberInput, output: UpdateEventMemberOutput,
    authorize: memberManagementAuthorization, invoke: updateEventMember,
    rest: { method: "patch", path: "/events/:eventId/members/:memberId", input: { path: ["eventId", "memberId"], body: ["role", "expectedVersion", "idempotencyKey"] }, summary: "Change an event member role safely", successStatus: 200 },
    idempotency: "required", concurrency: "required", emits: ["events.member.updated"],
  } satisfies AnyOperationDef,
  {
    id: "events.listApiKeys", kind: "query", input: ListEventApiKeysInput, output: Schema.Array(EventApiKey),
    authorize: memberManagementAuthorization, invoke: listEventApiKeys,
    rest: { method: "get", path: "/events/:eventId/api-keys", input: { path: ["eventId"] }, summary: "List event API keys", description: "Returns key metadata only; bearer secrets are never readable after creation.", successStatus: 200 },
    idempotency: "none", concurrency: "none", emits: [],
  } satisfies AnyOperationDef,
  {
    id: "events.createApiKey", kind: "command", input: CreateEventApiKeyInput, output: CreateEventApiKeyOutput,
    authorize: memberManagementAuthorization, invoke: createEventApiKey,
    rest: { method: "post", path: "/events/:eventId/api-keys", input: { path: ["eventId"], body: ["name", "scopes", "expiresAt"] }, summary: "Create an event API key", description: "Creates an expiring, event-bound key and returns its bearer secret exactly once.", successStatus: 201 },
    idempotency: "none", concurrency: "none", emits: [],
  } satisfies AnyOperationDef,
  {
    id: "events.revokeApiKey", kind: "command", input: RevokeEventApiKeyInput, output: EventApiKey,
    authorize: memberManagementAuthorization, invoke: revokeEventApiKey,
    rest: { method: "delete", path: "/events/:eventId/api-keys/:apiKeyId", input: { path: ["eventId", "apiKeyId"], body: ["expectedVersion"] }, summary: "Revoke an event API key", successStatus: 200 },
    idempotency: "none", concurrency: "required", emits: [],
  } satisfies AnyOperationDef,
] as const;
