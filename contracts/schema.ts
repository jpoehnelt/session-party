/**
 * FROZEN CONTRACT — integrator-only after spine-v1.
 * Single source of truth for the D1 schema. Slices import tables from here
 * and write queries; slices NEVER add migrations.
 */
import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";

const id = () => text("id").primaryKey();
const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
};

// ---------- identity ----------

export const users = sqliteTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name"),
  avatarAssetId: text("avatar_asset_id"),
  ...timestamps,
});

/** Magic-link tokens + browser sessions. */
export const authTokens = sqliteTable(
  "auth_tokens",
  {
    id: id(), // token value (secret)
    userId: text("user_id").notNull(),
    kind: text("kind", { enum: ["magic_link", "session"] }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("auth_tokens_user").on(t.userId)],
);

export const apiKeys = sqliteTable("api_keys", {
  id: id(),
  eventId: text("event_id").notNull(),
  name: text("name").notNull(),
  hash: text("hash").notNull(), // sha-256 of key
  ...timestamps,
});

// ---------- events ----------

export const events = sqliteTable("events", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  location: text("location"),
  timezone: text("timezone").notNull().default("America/Los_Angeles"),
  startsAt: integer("starts_at", { mode: "timestamp_ms" }),
  endsAt: integer("ends_at", { mode: "timestamp_ms" }),
  bannerAssetId: text("banner_asset_id"),
  accentColor: text("accent_color"), // Luma-style per-event accent
  ...timestamps,
});

export const eventMembers = sqliteTable(
  "event_members",
  {
    id: id(),
    eventId: text("event_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role", { enum: ["owner", "admin", "reviewer"] }).notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("event_members_unique").on(t.eventId, t.userId)],
);

// ---------- forms (CFP + task forms) ----------

export const forms = sqliteTable("forms", {
  id: id(),
  eventId: text("event_id").notNull(),
  kind: text("kind", { enum: ["cfp", "task"] }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status", { enum: ["draft", "open", "closed"] }).notNull().default("draft"),
  opensAt: integer("opens_at", { mode: "timestamp_ms" }),
  closesAt: integer("closes_at", { mode: "timestamp_ms" }),
  ...timestamps,
});

/**
 * `logic` (JSON, zod: FieldLogic in types.ts): show-if rules referencing other
 * fields. `routing` on select/radio fields maps option value -> category/track
 * for category-based routing of submissions.
 */
export const formFields = sqliteTable(
  "form_fields",
  {
    id: id(),
    formId: text("form_id").notNull(),
    order: integer("order").notNull(),
    type: text("type", {
      enum: ["text", "textarea", "select", "multiselect", "radio", "checkbox", "email", "url", "file", "date", "heading", "html"],
    }).notNull(),
    label: text("label").notNull(),
    helpText: text("help_text"),
    required: integer("required", { mode: "boolean" }).notNull().default(false),
    options: text("options", { mode: "json" }).$type<string[]>(),
    logic: text("logic", { mode: "json" }), // FieldLogic | null
    routing: text("routing", { mode: "json" }), // Record<optionValue, categoryId> | null
    ...timestamps,
  },
  (t) => [index("form_fields_form").on(t.formId)],
);

// ---------- submissions ----------

export const submissions = sqliteTable(
  "submissions",
  {
    id: id(),
    eventId: text("event_id").notNull(),
    formId: text("form_id").notNull(),
    title: text("title").notNull(),
    category: text("category"), // set by routing rules or manually
    status: text("status", {
      enum: ["submitted", "in_review", "accepted", "rejected", "waitlist", "withdrawn"],
    }).notNull().default("submitted"),
    submittedAt: integer("submitted_at", { mode: "timestamp_ms" }).notNull(),
    ...timestamps,
  },
  (t) => [index("submissions_event").on(t.eventId), index("submissions_form").on(t.formId)],
);

export const submissionAnswers = sqliteTable(
  "submission_answers",
  {
    id: id(),
    submissionId: text("submission_id").notNull(),
    fieldId: text("field_id").notNull(),
    value: text("value", { mode: "json" }).notNull(), // string | string[] | { assetId }
  },
  (t) => [index("submission_answers_submission").on(t.submissionId)],
);

// ---------- speakers ----------

export const speakers = sqliteTable(
  "speakers",
  {
    id: id(),
    eventId: text("event_id").notNull(),
    userId: text("user_id").notNull(),
    displayName: text("display_name").notNull(),
    title: text("title"),
    company: text("company"),
    bio: text("bio"),
    headshotAssetId: text("headshot_asset_id"),
    links: text("links", { mode: "json" }).$type<{ label: string; url: string }[]>(),
    visible: integer("visible", { mode: "boolean" }).notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex("speakers_event_user").on(t.eventId, t.userId)],
);

export const submissionSpeakers = sqliteTable(
  "submission_speakers",
  {
    id: id(),
    submissionId: text("submission_id").notNull(),
    speakerId: text("speaker_id").notNull(),
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [uniqueIndex("submission_speakers_unique").on(t.submissionId, t.speakerId)],
);

// ---------- review ----------

export const reviewRounds = sqliteTable("review_rounds", {
  id: id(),
  eventId: text("event_id").notNull(),
  name: text("name").notNull(),
  order: integer("order").notNull(),
  status: text("status", { enum: ["pending", "active", "complete"] }).notNull().default("pending"),
  rubric: text("rubric", { mode: "json" }), // { criteria: { key, label, max }[] }
  ...timestamps,
});

export const reviewAssignments = sqliteTable(
  "review_assignments",
  {
    id: id(),
    roundId: text("round_id").notNull(),
    submissionId: text("submission_id").notNull(),
    reviewerUserId: text("reviewer_user_id").notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("review_assignments_unique").on(t.roundId, t.submissionId, t.reviewerUserId)],
);

export const reviews = sqliteTable(
  "reviews",
  {
    id: id(),
    roundId: text("round_id").notNull(),
    submissionId: text("submission_id").notNull(),
    reviewerUserId: text("reviewer_user_id"), // null when ai=true
    ai: integer("ai", { mode: "boolean" }).notNull().default(false),
    score: real("score").notNull(), // overall 0-10
    scores: text("scores", { mode: "json" }).$type<Record<string, number>>(), // per-criterion
    comment: text("comment"),
    ...timestamps,
  },
  (t) => [index("reviews_submission").on(t.submissionId)],
);

// ---------- agenda ----------

export const tracks = sqliteTable("tracks", {
  id: id(),
  eventId: text("event_id").notNull(),
  name: text("name").notNull(),
  color: text("color"),
  order: integer("order").notNull().default(0),
  ...timestamps,
});

export const rooms = sqliteTable("rooms", {
  id: id(),
  eventId: text("event_id").notNull(),
  name: text("name").notNull(),
  capacity: integer("capacity"),
  order: integer("order").notNull().default(0),
  ...timestamps,
});

/** A scheduled (or unscheduled backlog) talk. startsAt/roomId null = backlog. */
export const talks = sqliteTable(
  "talks",
  {
    id: id(),
    eventId: text("event_id").notNull(),
    submissionId: text("submission_id"), // null for manually-added slots (breaks, keynotes)
    title: text("title").notNull(),
    description: text("description"),
    trackId: text("track_id"),
    roomId: text("room_id"),
    startsAt: integer("starts_at", { mode: "timestamp_ms" }),
    durationMin: integer("duration_min").notNull().default(30),
    status: text("status", { enum: ["draft", "confirmed", "cancelled"] }).notNull().default("draft"),
    ...timestamps,
  },
  (t) => [index("talks_event").on(t.eventId)],
);

export const talkSpeakers = sqliteTable(
  "talk_speakers",
  {
    id: id(),
    talkId: text("talk_id").notNull(),
    speakerId: text("speaker_id").notNull(),
  },
  (t) => [uniqueIndex("talk_speakers_unique").on(t.talkId, t.speakerId)],
);

// ---------- onboarding tasks ----------

export const tasks = sqliteTable("tasks", {
  id: id(),
  eventId: text("event_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  kind: text("kind", { enum: ["profile", "upload", "form", "link", "confirm"] }).notNull(),
  formId: text("form_id"), // when kind=form
  dueAt: integer("due_at", { mode: "timestamp_ms" }),
  order: integer("order").notNull().default(0),
  ...timestamps,
});

export const taskCompletions = sqliteTable(
  "task_completions",
  {
    id: id(),
    taskId: text("task_id").notNull(),
    speakerId: text("speaker_id").notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }).notNull(),
    data: text("data", { mode: "json" }), // form answers / asset id / ack
  },
  (t) => [uniqueIndex("task_completions_unique").on(t.taskId, t.speakerId)],
);

// ---------- comms ----------

export const emailTemplates = sqliteTable("email_templates", {
  id: id(),
  eventId: text("event_id").notNull(),
  name: text("name").notNull(),
  subject: text("subject").notNull(),
  /** Markdown body with {{merge.fields}}: speaker.name, event.name, talk.title, portal.url, ... */
  body: text("body").notNull(),
  /** Attach calendar invite (.ics) built from the recipient's talk. */
  attachIcs: integer("attach_ics", { mode: "boolean" }).notNull().default(false),
  ...timestamps,
});

export const emailSends = sqliteTable(
  "email_sends",
  {
    id: id(),
    eventId: text("event_id").notNull(),
    templateId: text("template_id"),
    toUserId: text("to_user_id").notNull(),
    subject: text("subject").notNull(),
    scheduledFor: integer("scheduled_for", { mode: "timestamp_ms" }), // null = immediate
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    status: text("status", { enum: ["scheduled", "sent", "failed", "cancelled"] }).notNull(),
    error: text("error"),
    ...timestamps,
  },
  (t) => [index("email_sends_event").on(t.eventId)],
);

// ---------- content ----------

/** Wiki/resource pages in the speaker portal; body is markdown, htmlEmbed raw. */
export const pages = sqliteTable("pages", {
  id: id(),
  eventId: text("event_id").notNull(),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  htmlEmbed: text("html_embed"),
  audience: text("audience", { enum: ["speakers", "public"] }).notNull().default("speakers"),
  order: integer("order").notNull().default(0),
  ...timestamps,
});

export const assets = sqliteTable("assets", {
  id: id(), // also the R2 key
  eventId: text("event_id"),
  uploaderUserId: text("uploader_user_id").notNull(),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  ...timestamps,
});

// ---------- integrations ----------

export const integrations = sqliteTable(
  "integrations",
  {
    id: id(),
    eventId: text("event_id").notNull(),
    kind: text("kind", { enum: ["airtable", "accelevents"] }).notNull(),
    config: text("config", { mode: "json" }).notNull(), // AirtableConfig | AccelConfig (types.ts)
    cursor: text("cursor"), // sync watermark
    lastSyncAt: integer("last_sync_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
    ...timestamps,
  },
  (t) => [uniqueIndex("integrations_unique").on(t.eventId, t.kind)],
);
