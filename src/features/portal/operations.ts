import type { AnyOperationDef } from "contracts/operation";
import { browserSessionAuthorization } from "contracts/principal";
import {
  CompletePortalTaskInput,
  GetPortalAssetInput,
  GetPortalInput,
  PortalAssetContent,
  PortalMutationResult,
  PortalSnapshot,
  UpdatePortalProfileInput,
  UploadPortalAssetInput,
} from "./schema";
import {
  completePortalTask,
  getPortal,
  getPortalAsset,
  updatePortalProfile,
  uploadPortalAsset,
} from "./service";

export const completeTaskOperation = {
  id: "portal.completeTask",
  kind: "command",
  input: CompletePortalTaskInput,
  output: PortalMutationResult,
  authorize: browserSessionAuthorization,
  invoke: completePortalTask,
  rest: {
    method: "post",
    path: "/events/:eventSlug/portal/tasks/:taskId/complete",
    input: { path: ["eventSlug", "taskId"], body: ["expectedVersion", "idempotencyKey"] },
    summary: "Complete one accepted-speaker onboarding task",
    successStatus: 200,
  },
  mcp: {
    name: "complete_speaker_portal_task",
    description: "Complete one onboarding task for the signed-in accepted speaker after its prerequisite is satisfied.",
  },
  idempotency: "required",
  concurrency: "required",
  emits: ["portal.task.completed"],
} as const satisfies AnyOperationDef;

export const getPortalOperation = {
  id: "portal.get",
  kind: "query",
  input: GetPortalInput,
  output: PortalSnapshot,
  authorize: browserSessionAuthorization,
  invoke: getPortal,
  rest: {
    method: "get",
    path: "/events/:eventSlug/portal",
    input: { path: ["eventSlug"] },
    summary: "Get the signed-in accepted speaker portal",
    successStatus: 200,
  },
  mcp: {
    name: "get_speaker_portal",
    description: "Get submissions, private profile, onboarding tasks, and resources for the signed-in accepted speaker.",
  },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} as const satisfies AnyOperationDef;

export const getAssetOperation = {
  id: "portal.getAsset",
  kind: "query",
  input: GetPortalAssetInput,
  output: PortalAssetContent,
  authorize: browserSessionAuthorization,
  invoke: getPortalAsset,
  rest: {
    method: "get",
    path: "/events/:eventSlug/portal/assets/:assetId",
    input: { path: ["eventSlug", "assetId"] },
    summary: "Read an asset linked to the signed-in speaker portal",
    successStatus: 200,
  },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} as const satisfies AnyOperationDef;

export const updateProfileOperation = {
  id: "portal.updateProfile",
  kind: "command",
  input: UpdatePortalProfileInput,
  output: PortalMutationResult,
  authorize: browserSessionAuthorization,
  invoke: updatePortalProfile,
  rest: {
    method: "patch",
    path: "/events/:eventSlug/portal/profile",
    input: {
      path: ["eventSlug"],
      body: ["displayName", "title", "company", "bio", "links", "expectedVersion", "idempotencyKey"],
    },
    summary: "Update the signed-in accepted speaker profile",
    successStatus: 200,
  },
  mcp: {
    name: "update_speaker_portal_profile",
    description: "Update permitted profile fields for the signed-in accepted speaker with optimistic concurrency and idempotency.",
  },
  idempotency: "required",
  concurrency: "required",
  emits: ["portal.profile.updated"],
} as const satisfies AnyOperationDef;

export const uploadAssetOperation = {
  id: "portal.uploadAsset",
  kind: "command",
  input: UploadPortalAssetInput,
  output: PortalMutationResult,
  authorize: browserSessionAuthorization,
  invoke: uploadPortalAsset,
  rest: {
    method: "post",
    path: "/events/:eventSlug/portal/assets",
    input: {
      path: ["eventSlug"],
      body: ["taskId", "purpose", "filename", "contentType", "contentBase64", "expectedVersion", "idempotencyKey"],
    },
    summary: "Upload or replace a speaker portal asset",
    description: "Stores validated headshots, slides, or supporting documents through the Files service and records their durable relationship.",
    successStatus: 200,
  },
  mcp: {
    name: "upload_speaker_portal_asset",
    description: "Upload base64-encoded headshot, slides, or supporting-document content for the signed-in accepted speaker.",
  },
  idempotency: "required",
  concurrency: "required",
  emits: ["portal.headshot.replaced", "portal.task.uploaded"],
} as const satisfies AnyOperationDef;

/** Operation IDs stay bytewise sorted for deterministic registry generation. */
export const operations = [
  completeTaskOperation,
  getPortalOperation,
  getAssetOperation,
  updateProfileOperation,
  uploadAssetOperation,
] as const;
