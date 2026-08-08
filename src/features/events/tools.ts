import type { ToolDef } from "contracts/mcp";
import { Schema } from "effect";
import { CreateEventInput, createEvent, getEvent, listEvents } from "./service";

export const tools: ToolDef[] = [
  {
    name: "create_event",
    description: "Create an event and make the current user its owner.",
    args: CreateEventInput,
    handler: createEvent,
  },
  {
    name: "list_events",
    description: "List events accessible to the current user or API key.",
    args: Schema.Struct({}),
    handler: () => listEvents(),
  },
  {
    name: "get_event",
    description: "Get an event by its id or slug.",
    args: Schema.Struct({ idOrSlug: Schema.String.pipe(Schema.minLength(1)) }),
    handler: ({ idOrSlug }) => getEvent(idOrSlug),
  },
];

