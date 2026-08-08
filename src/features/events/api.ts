import { Effect } from "effect";
import { Hono } from "hono";
import { decode, runApi } from "@/server/adapt";
import {
  CreateEventInput,
  UpdateEventInput,
  createEvent,
  getEvent,
  listEvents,
  updateEvent,
} from "./service";

const api = new Hono<{ Bindings: Env }>();

api.get("/events", (c) => runApi(c, listEvents()));

api.post("/events", async (c) =>
  runApi(
    c,
    decode(CreateEventInput, await c.req.json().catch(() => null)).pipe(Effect.flatMap(createEvent)),
  ),
);

api.get("/events/:idOrSlug", (c) => runApi(c, getEvent(c.req.param("idOrSlug"))));

api.patch("/events/:idOrSlug", async (c) =>
  runApi(
    c,
    decode(UpdateEventInput, await c.req.json().catch(() => null)).pipe(
      Effect.flatMap((input) => updateEvent(c.req.param("idOrSlug"), input)),
    ),
  ),
);

export default api;

