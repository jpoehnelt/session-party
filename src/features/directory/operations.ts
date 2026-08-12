import type { AnyOperationDef } from "contracts/operation";
import { installStaffAuthorization } from "contracts/principal";
import { ListSpeakerDirectoryInput, SpeakerDirectoryPage } from "./schema";
import { listSpeakerDirectory } from "./service";

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
] as const;
