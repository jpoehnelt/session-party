import type { AnyOperationDef } from "contracts/operation";
import { eventAuthorization, installStaffAuthorization } from "contracts/principal";
import {
  ApplyReturningSpeakerInviteInput,
  ApplyReturningSpeakerInviteOutput,
  ListSpeakerDirectoryInput,
  PreviewReturningSpeakerInviteInput,
  ReturningSpeakerInvitePlan,
  SpeakerDirectoryPage,
} from "./schema";
import { applyReturningSpeakerInvite, listSpeakerDirectory, previewReturningSpeakerInvite } from "./service";

const returningSpeakerAuthorization = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "deny" },
);

export const operations = [
  {
    id: "directory.listSpeakers",
    kind: "query",
    input: ListSpeakerDirectoryInput,
    output: SpeakerDirectoryPage,
    authorize: installStaffAuthorization,
    invoke: listSpeakerDirectory,
    rest: {
      method: "get",
      path: "/install/speakers",
      input: { query: ["query", "eventId", "status", "page", "pageSize"] },
      summary: "Search the installation speaker history",
      successStatus: 200,
    },
    idempotency: "none",
    concurrency: "none",
    emits: [],
  } satisfies AnyOperationDef,
  {
    id: "directory.previewReturningSpeakerInvite",
    kind: "query",
    input: PreviewReturningSpeakerInviteInput,
    output: ReturningSpeakerInvitePlan,
    authorize: returningSpeakerAuthorization,
    invoke: previewReturningSpeakerInvite,
    rest: {
      method: "get",
      path: "/events/:eventId/directory/speakers/invite-preview",
      input: { path: ["eventId"], query: ["groupKey"] },
      summary: "Preview a returning-speaker invite without writing",
      successStatus: 200,
    },
    idempotency: "none",
    concurrency: "none",
    emits: [],
  } satisfies AnyOperationDef,
  {
    id: "directory.inviteReturningSpeaker",
    kind: "command",
    input: ApplyReturningSpeakerInviteInput,
    output: ApplyReturningSpeakerInviteOutput,
    authorize: returningSpeakerAuthorization,
    invoke: applyReturningSpeakerInvite,
    rest: {
      method: "post",
      path: "/events/:eventId/directory/speakers/invite",
      input: { path: ["eventId"], body: ["groupKey", "expectedAction", "expectedSourceId", "expectedSourceVersion", "idempotencyKey"] },
      summary: "Create or link a returning speaker with profile review",
      successStatus: 201,
    },
    idempotency: "required",
    concurrency: "none",
    emits: ["portal.speaker.managed.created"],
  } satisfies AnyOperationDef,
] as const;
