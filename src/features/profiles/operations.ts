import type { AnyOperationDef } from "contracts/operation";
import { browserSessionAuthorization, publicAuthorization } from "contracts/principal";
import {
  GetMyProfileInput,
  GetPublicProfileInput,
  MyProfile,
  PublicReusableSpeakerProfile,
  ReusableSpeakerProfile,
  SaveMyProfileInput,
} from "./schema";
import { getMyProfile, getPublicProfile, saveMyProfile } from "./service";

const getMyProfileOperation = {
  id: "profiles.getMine",
  kind: "query",
  input: GetMyProfileInput,
  output: MyProfile,
  authorize: browserSessionAuthorization,
  invoke: getMyProfile,
  rest: { method: "get", path: "/speaker-profile", input: {}, summary: "Get the signed-in speaker's reusable profile" },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} as const satisfies AnyOperationDef;

const saveMyProfileOperation = {
  id: "profiles.saveMine",
  kind: "command",
  input: SaveMyProfileInput,
  output: ReusableSpeakerProfile,
  authorize: browserSessionAuthorization,
  invoke: saveMyProfile,
  rest: { method: "put", path: "/speaker-profile", input: { body: "all" }, summary: "Create or update the signed-in speaker's reusable profile" },
  idempotency: "none",
  concurrency: "required",
  emits: ["profiles.profile.saved"],
} as const satisfies AnyOperationDef;

const getPublicProfileOperation = {
  id: "profiles.getPublic",
  kind: "query",
  input: GetPublicProfileInput,
  output: PublicReusableSpeakerProfile,
  authorize: publicAuthorization,
  invoke: getPublicProfile,
  rest: { method: "get", path: "/public/speakers/:slug", input: { path: ["slug"] }, summary: "Get a public reusable speaker profile and published appearances" },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} as const satisfies AnyOperationDef;

export const operations = [getMyProfileOperation, getPublicProfileOperation, saveMyProfileOperation] as const;
