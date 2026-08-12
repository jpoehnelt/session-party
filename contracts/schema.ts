/**
 * FROZEN CONTRACT — integrator-only after spine-v1.
 * Single source of truth for the D1 schema. Slices import tables from here
 * and write queries; slices NEVER add migrations.
 */
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { ApiScope, EventRole, InstallRole } from "./types";

const id = () => text("id").primaryKey();
const eventId = () => text("event_id").notNull();
const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
};
const version = () => integer("version").notNull().default(1);

// ---------- identity ----------

export const users = sqliteTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name"),
  avatarAssetId: text("avatar_asset_id"),
  version: version(),
  ...timestamps,
}, (t) => [check("users_version_positive", sql`${t.version} > 0`)]);

/** Speaker-owned identity reused deliberately across event-scoped snapshots. */
export const speakerProfiles = sqliteTable(
  "speaker_profiles",
  {
    id: id(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    title: text("title"),
    company: text("company"),
    bio: text("bio"),
    headshotUrl: text("headshot_url"),
    links: text("links", { mode: "json" }).$type<readonly { label: string; url: string }[]>(),
    visible: integer("visible", { mode: "boolean" }).notNull().default(false),
    version: version(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("speaker_profiles_user_unique").on(t.userId),
    uniqueIndex("speaker_profiles_slug_unique").on(t.slug),
    index("speaker_profiles_visible").on(t.visible, t.slug),
    check("speaker_profiles_slug_format", sql`length(${t.slug}) between 3 and 80 and ${t.slug} = lower(${t.slug}) and ${t.slug} not glob '*[^a-z0-9-]*'`),
    check("speaker_profiles_version_positive", sql`${t.version} > 0`),
  ],
);

/** Append-only history for cross-event speaker-owned profile changes. */
export const speakerProfileChanges = sqliteTable(
  "speaker_profile_changes",
  {
    id: id(),
    profileId: text("profile_id").notNull().references(() => speakerProfiles.id, { onDelete: "cascade", onUpdate: "cascade" }),
    profileVersion: integer("profile_version").notNull(),
    actorUserId: text("actor_user_id").notNull().references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }),
    before: text("before", { mode: "json" }),
    after: text("after", { mode: "json" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("speaker_profile_changes_version_unique").on(t.profileId, t.profileVersion),
    index("speaker_profile_changes_actor").on(t.actorUserId, t.createdAt),
    check("speaker_profile_changes_version_positive", sql`${t.profileVersion} > 0`),
  ],
);

/** Audited installation-level authority. Revocation closes a record; re-granting creates a new one. */
export const installGrants = sqliteTable(
  "install_grants",
  {
    id: id(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    role: text("role").$type<InstallRole>().notNull(),
    grantedByUserId: text("granted_by_user_id").notNull().references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }),
    grantedAt: integer("granted_at", { mode: "timestamp_ms" }).notNull(),
    revokedByUserId: text("revoked_by_user_id").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    grantKeyHash: text("grant_key_hash"),
    grantRequestHash: text("grant_request_hash"),
    revokeKeyHash: text("revoke_key_hash"),
    revokeRequestHash: text("revoke_request_hash"),
    version: version(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("install_grants_one_active_user_role").on(t.userId, t.role).where(sql`${t.revokedAt} is null`),
    uniqueIndex("install_grants_grant_idempotency_unique").on(t.grantedByUserId, t.grantKeyHash).where(sql`${t.grantKeyHash} is not null`),
    uniqueIndex("install_grants_revoke_idempotency_unique").on(t.revokedByUserId, t.revokeKeyHash).where(sql`${t.revokeKeyHash} is not null`),
    index("install_grants_active_role").on(t.role, t.revokedAt, t.userId),
    index("install_grants_history").on(t.userId, t.grantedAt),
    check("install_grants_role_staff", sql`${t.role} = 'staff'`),
    check("install_grants_version_positive", sql`${t.version} > 0`),
    check("install_grants_revocation_pair", sql`(${t.revokedAt} is null) = (${t.revokedByUserId} is null)`),
    check("install_grants_grant_replay_pair", sql`(${t.grantKeyHash} is null) = (${t.grantRequestHash} is null)`),
    check("install_grants_revoke_replay_pair", sql`(${t.revokeKeyHash} is null) = (${t.revokeRequestHash} is null)`),
  ],
);

/** The presented bearer value is never persisted; id is a public lookup id. */
export const authTokens = sqliteTable(
  "auth_tokens",
  {
    id: id(),
    tokenHash: text("token_hash").notNull(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    kind: text("kind", { enum: ["magic_link", "session"] }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("auth_tokens_hash_unique").on(t.tokenHash),
    uniqueIndex("auth_tokens_one_pending_magic_link")
      .on(t.userId)
      .where(sql`${t.kind} = 'magic_link' and ${t.consumedAt} is null`),
    index("auth_tokens_user_kind").on(t.userId, t.kind),
    index("auth_tokens_expiry_cleanup").on(t.expiresAt, t.consumedAt),
    check("auth_tokens_hash_format", sql`length(${t.tokenHash}) = 64 and ${t.tokenHash} = lower(${t.tokenHash}) and ${t.tokenHash} not glob '*[^0-9a-f]*'`),
  ],
);

// ---------- events and ownership ----------

export const events = sqliteTable(
  "events",
  {
    id: id(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    location: text("location"),
    timezone: text("timezone").notNull().default("America/Los_Angeles"),
    startsAt: integer("starts_at", { mode: "timestamp_ms" }),
    endsAt: integer("ends_at", { mode: "timestamp_ms" }),
    bannerAssetId: text("banner_asset_id"),
    accentColor: text("accent_color"),
    version: version(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("events_slug_unique").on(t.slug),
    check("events_version_positive", sql`${t.version} > 0`),
    check("events_date_order", sql`${t.startsAt} is null or ${t.endsAt} is null or ${t.endsAt} >= ${t.startsAt}`),
  ],
);

export const assets = sqliteTable(
  "assets",
  {
    id: id(),
    eventId: text("event_id").references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    uploaderUserId: text("uploader_user_id").notNull().references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }),
    /** Portal ownership and immutable lineage; null for non-portal event assets. */
    speakerId: text("speaker_id"),
    purpose: text("purpose", { enum: ["headshot", "slides", "document"] }),
    supersedesAssetId: text("supersedes_asset_id"),
    restoredFromAssetId: text("restored_from_asset_id"),
    current: integer("current", { mode: "boolean" }).notNull().default(true),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    version: version(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("assets_event_id_unique").on(t.eventId, t.id),
    uniqueIndex("assets_current_lineage_unique")
      .on(t.eventId, t.speakerId, t.purpose)
      .where(sql`${t.current} = 1 and ${t.speakerId} is not null and ${t.purpose} is not null`),
    index("assets_event").on(t.eventId),
    index("assets_speaker_purpose").on(t.eventId, t.speakerId, t.purpose, t.current),
    index("assets_uploader").on(t.uploaderUserId),
    check("assets_size_nonnegative", sql`${t.size} >= 0`),
    check("assets_version_positive", sql`${t.version} > 0`),
    foreignKey({ columns: [t.eventId, t.supersedesAssetId], foreignColumns: [t.eventId, t.id], name: "assets_supersedes_fk" })
      .onDelete("restrict").onUpdate("cascade"),
    foreignKey({ columns: [t.eventId, t.restoredFromAssetId], foreignColumns: [t.eventId, t.id], name: "assets_restored_from_fk" })
      .onDelete("restrict").onUpdate("cascade"),
  ],
);

export const eventMembers = sqliteTable(
  "event_members",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    role: text("role").$type<EventRole>().notNull(),
    version: version(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("event_members_event_user_unique").on(t.eventId, t.userId),
    uniqueIndex("event_members_event_id_unique").on(t.eventId, t.id),
    index("event_members_user").on(t.userId),
    check("event_members_version_positive", sql`${t.version} > 0`),
  ],
);

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    scopes: text("scopes", { mode: "json" }).$type<readonly ApiScope[]>().notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }),
    version: version(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("api_keys_hash_unique").on(t.keyHash),
    uniqueIndex("api_keys_event_id_unique").on(t.eventId, t.id),
    index("api_keys_event_active").on(t.eventId, t.revokedAt, t.expiresAt),
    index("api_keys_creator").on(t.createdBy),
    check("api_keys_hash_format", sql`length(${t.keyHash}) = 64 and ${t.keyHash} = lower(${t.keyHash}) and ${t.keyHash} not glob '*[^0-9a-f]*'`),
    check("api_keys_scopes_json", sql`json_valid(${t.scopes}) and json_type(${t.scopes}) = 'array' and json_array_length(${t.scopes}) > 0`),
    check("api_keys_version_positive", sql`${t.version} > 0`),
  ],
);

// ---------- forms (draft plus copy-on-publish snapshots) ----------

export const forms = sqliteTable(
  "forms",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    kind: text("kind", { enum: ["cfp", "task"] }).notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status", { enum: ["draft", "open", "closed"] }).notNull().default("draft"),
    opensAt: integer("opens_at", { mode: "timestamp_ms" }),
    closesAt: integer("closes_at", { mode: "timestamp_ms" }),
    version: version(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("forms_event_id_unique").on(t.eventId, t.id),
    index("forms_event_status").on(t.eventId, t.status),
    check("forms_version_positive", sql`${t.version} > 0`),
    check("forms_date_order", sql`${t.opensAt} is null or ${t.closesAt} is null or ${t.closesAt} >= ${t.opensAt}`),
  ],
);

export const formFields = sqliteTable(
  "form_fields",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    formId: text("form_id").notNull(),
    order: integer("order").notNull(),
    type: text("type", {
      enum: ["text", "textarea", "select", "multiselect", "radio", "checkbox", "email", "url", "file", "date", "heading", "html"],
    }).notNull(),
    label: text("label").notNull(),
    helpText: text("help_text"),
    semanticKey: text("semantic_key", {
      enum: ["submissionTitle", "submissionAbstract", "speakerName", "speakerEmail"],
    }),
    required: integer("required", { mode: "boolean" }).notNull().default(false),
    options: text("options", { mode: "json" }).$type<readonly string[]>(),
    logic: text("logic", { mode: "json" }),
    routing: text("routing", { mode: "json" }),
    version: version(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("form_fields_event_id_unique").on(t.eventId, t.id),
    uniqueIndex("form_fields_form_order_unique").on(t.eventId, t.formId, t.order),
    uniqueIndex("form_fields_semantic_key_unique")
      .on(t.eventId, t.formId, t.semanticKey)
      .where(sql`${t.semanticKey} is not null`),
    index("form_fields_form").on(t.eventId, t.formId),
    foreignKey({ columns: [t.eventId, t.formId], foreignColumns: [forms.eventId, forms.id], name: "form_fields_form_fk" })
      .onDelete("cascade").onUpdate("cascade"),
    check(
      "form_fields_semantic_key",
      sql`${t.semanticKey} is null or ${t.semanticKey} in ('submissionTitle', 'submissionAbstract', 'speakerName', 'speakerEmail')`,
    ),
    check("form_fields_version_positive", sql`${t.version} > 0`),
  ],
);

export const formVersions = sqliteTable(
  "form_versions",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    formId: text("form_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }).notNull(),
    retiredAt: integer("retired_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("form_versions_event_id_unique").on(t.eventId, t.id),
    uniqueIndex("form_versions_event_form_id_unique").on(t.eventId, t.formId, t.id),
    uniqueIndex("form_versions_number_unique").on(t.eventId, t.formId, t.versionNumber),
    index("form_versions_current").on(t.eventId, t.formId, t.retiredAt),
    foreignKey({ columns: [t.eventId, t.formId], foreignColumns: [forms.eventId, forms.id], name: "form_versions_form_fk" })
      .onDelete("restrict").onUpdate("cascade"),
    check("form_versions_number_positive", sql`${t.versionNumber} > 0`),
    check("form_versions_retired_after_publish", sql`${t.retiredAt} is null or ${t.retiredAt} >= ${t.publishedAt}`),
  ],
);

export const formVersionFields = sqliteTable(
  "form_version_fields",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    formVersionId: text("form_version_id").notNull(),
    sourceFieldId: text("source_field_id"),
    order: integer("order").notNull(),
    type: text("type").notNull(),
    label: text("label").notNull(),
    helpText: text("help_text"),
    semanticKey: text("semantic_key", {
      enum: ["submissionTitle", "submissionAbstract", "speakerName", "speakerEmail"],
    }),
    required: integer("required", { mode: "boolean" }).notNull(),
    options: text("options", { mode: "json" }).$type<readonly string[]>(),
    logic: text("logic", { mode: "json" }),
    routing: text("routing", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("form_version_fields_event_id_unique").on(t.eventId, t.id),
    uniqueIndex("form_version_fields_event_version_id_unique").on(t.eventId, t.formVersionId, t.id),
    uniqueIndex("form_version_fields_order_unique").on(t.eventId, t.formVersionId, t.order),
    uniqueIndex("form_version_fields_semantic_key_unique")
      .on(t.eventId, t.formVersionId, t.semanticKey)
      .where(sql`${t.semanticKey} is not null`),
    index("form_version_fields_version").on(t.eventId, t.formVersionId),
    foreignKey({ columns: [t.eventId, t.formVersionId], foreignColumns: [formVersions.eventId, formVersions.id], name: "form_version_fields_version_fk" })
      .onDelete("cascade").onUpdate("cascade"),
    check(
      "form_version_fields_semantic_key",
      sql`${t.semanticKey} is null or ${t.semanticKey} in ('submissionTitle', 'submissionAbstract', 'speakerName', 'speakerEmail')`,
    ),
  ],
);

// ---------- submissions and speakers ----------

export const submissions = sqliteTable(
  "submissions",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    formId: text("form_id").notNull(),
    formVersionId: text("form_version_id").notNull(),
    title: text("title").notNull(),
    category: text("category"),
    status: text("status", { enum: ["submitted", "in_review", "accepted", "rejected", "waitlist", "withdrawn"] }).notNull().default("submitted"),
    submittedAt: integer("submitted_at", { mode: "timestamp_ms" }).notNull(),
    acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
    version: version(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("submissions_event_id_unique").on(t.eventId, t.id),
    uniqueIndex("submissions_event_id_version_unique").on(t.eventId, t.id, t.formVersionId),
    index("submissions_event_status").on(t.eventId, t.status, t.submittedAt),
    index("submissions_form").on(t.eventId, t.formId),
    index("submissions_form_version").on(t.eventId, t.formVersionId),
    foreignKey({ columns: [t.eventId, t.formId], foreignColumns: [forms.eventId, forms.id], name: "submissions_form_fk" })
      .onDelete("restrict").onUpdate("cascade"),
    foreignKey({
      columns: [t.eventId, t.formId, t.formVersionId],
      foreignColumns: [formVersions.eventId, formVersions.formId, formVersions.id],
      name: "submissions_form_version_fk",
    }).onDelete("restrict").onUpdate("cascade"),
    check("submissions_version_positive", sql`${t.version} > 0`),
    check("submissions_acceptance_state", sql`(${t.status} = 'accepted' and ${t.acceptedAt} is not null) or (${t.status} <> 'accepted')`),
  ],
);

export const submissionAnswers = sqliteTable(
  "submission_answers",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    submissionId: text("submission_id").notNull(),
    formVersionId: text("form_version_id").notNull(),
    formVersionFieldId: text("form_version_field_id").notNull(),
    value: text("value", { mode: "json" }).notNull(),
    version: version(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("submission_answers_event_id_unique").on(t.eventId, t.id),
    uniqueIndex("submission_answers_field_unique").on(t.eventId, t.submissionId, t.formVersionId, t.formVersionFieldId),
    index("submission_answers_submission").on(t.eventId, t.submissionId),
    foreignKey({
      columns: [t.eventId, t.submissionId, t.formVersionId],
      foreignColumns: [submissions.eventId, submissions.id, submissions.formVersionId],
      name: "submission_answers_submission_version_fk",
    }).onDelete("cascade").onUpdate("cascade"),
    foreignKey({
      columns: [t.eventId, t.formVersionId, t.formVersionFieldId],
      foreignColumns: [formVersionFields.eventId, formVersionFields.formVersionId, formVersionFields.id],
      name: "submission_answers_version_field_fk",
    }).onDelete("restrict").onUpdate("cascade"),
    check("submission_answers_version_positive", sql`${t.version} > 0`),
  ],
);

export const speakers = sqliteTable(
  "speakers",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" }),
    /** Event-scoped logistics address for speakers who do not yet have an account. Never public. */
    contactEmail: text("contact_email"),
    displayName: text("display_name").notNull(),
    title: text("title"),
    company: text("company"),
    bio: text("bio"),
    workflowStatus: text("workflow_status").notNull().default("Invited"),
    headshotAssetId: text("headshot_asset_id"),
    headshotUrl: text("headshot_url"),
    links: text("links", { mode: "json" }).$type<readonly { label: string; url: string }[]>(),
    visible: integer("visible", { mode: "boolean" }).notNull().default(true),
    /** Canonical profile version this event snapshot was last copied from. */
    profileSourceId: text("profile_source_id").references(() => speakerProfiles.id, { onDelete: "set null", onUpdate: "cascade" }),
    profileSourceVersion: integer("profile_source_version"),
    profileReviewStatus: text("profile_review_status", {
      enum: ["draft", "in_review", "changes_requested", "approved"],
    }).notNull().default("approved"),
    profileReviewNote: text("profile_review_note"),
    profileSubmittedAt: integer("profile_submitted_at", { mode: "timestamp_ms" }),
    profileReviewedAt: integer("profile_reviewed_at", { mode: "timestamp_ms" }),
    profileReviewedBy: text("profile_reviewed_by").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" }),
    version: version(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("speakers_event_id_unique").on(t.eventId, t.id),
    uniqueIndex("speakers_event_user_unique").on(t.eventId, t.userId),
    index("speakers_event_visible").on(t.eventId, t.visible),
    index("speakers_user").on(t.userId),
    index("speakers_profile_source").on(t.profileSourceId),
    index("speakers_profile_review").on(t.eventId, t.profileReviewStatus, t.visible),
    foreignKey({ columns: [t.eventId, t.headshotAssetId], foreignColumns: [assets.eventId, assets.id], name: "speakers_headshot_fk" })
      .onDelete("restrict").onUpdate("cascade"),
    check("speakers_version_positive", sql`${t.version} > 0`),
    check("speakers_profile_source_version_positive", sql`${t.profileSourceVersion} is null or ${t.profileSourceVersion} > 0`),
  ],
);

/** Normalized email claims for organizer-managed speaker identities only. */
export const managedSpeakerEmails = sqliteTable(
  "managed_speaker_emails",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    normalizedEmail: text("normalized_email").notNull(),
    speakerId: text("speaker_id").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("managed_speaker_emails_event_email_unique").on(t.eventId, t.normalizedEmail),
    uniqueIndex("managed_speaker_emails_event_speaker_unique").on(t.eventId, t.speakerId),
    foreignKey({
      columns: [t.eventId, t.speakerId],
      foreignColumns: [speakers.eventId, speakers.id],
      name: "managed_speaker_emails_speaker_fk",
    }).onDelete("cascade").onUpdate("cascade"),
    check("managed_speaker_emails_normalized", sql`length(${t.normalizedEmail}) > 0 and ${t.normalizedEmail} = lower(trim(${t.normalizedEmail}))`),
  ],
);

export const assetComments = sqliteTable(
  "asset_comments",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    assetId: text("asset_id").notNull(),
    actorUserId: text("actor_user_id").notNull().references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }),
    body: text("body").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("asset_comments_event_id_unique").on(t.eventId, t.id),
    index("asset_comments_asset_time").on(t.eventId, t.assetId, t.createdAt),
    foreignKey({ columns: [t.eventId, t.assetId], foreignColumns: [assets.eventId, assets.id], name: "asset_comments_asset_fk" })
      .onDelete("cascade").onUpdate("cascade"),
  ],
);

export const submissionSpeakers = sqliteTable(
  "submission_speakers",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    submissionId: text("submission_id").notNull(),
    speakerId: text("speaker_id").notNull(),
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
    /** Immutable presenter role supplied with the proposal (for example, facilitator or moderator). */
    roleLabel: text("role_label"),
    /** Immutable professional context captured when the submission-speaker link is created. */
    titleAtTime: text("title_at_time"),
    organizationAtTime: text("organization_at_time"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("submission_speakers_event_id_unique").on(t.eventId, t.id),
    uniqueIndex("submission_speakers_primary_parent_unique").on(
      t.eventId,
      t.submissionId,
      t.id,
      t.speakerId,
      t.isPrimary,
    ),
    uniqueIndex("submission_speakers_pair_unique").on(t.eventId, t.submissionId, t.speakerId),
    uniqueIndex("submission_speakers_one_primary").on(t.eventId, t.submissionId).where(sql`${t.isPrimary} = 1`),
    index("submission_speakers_speaker").on(t.eventId, t.speakerId),
    foreignKey({ columns: [t.eventId, t.submissionId], foreignColumns: [submissions.eventId, submissions.id], name: "submission_speakers_submission_fk" })
      .onDelete("cascade").onUpdate("cascade"),
    foreignKey({ columns: [t.eventId, t.speakerId], foreignColumns: [speakers.eventId, speakers.id], name: "submission_speakers_speaker_fk" })
      .onDelete("cascade").onUpdate("cascade"),
  ],
);

/** Append-only acceptance contract consumed by portal, agenda, and comms. */
export const acceptanceEvents = sqliteTable(
  "acceptance_events",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    submissionId: text("submission_id").notNull(),
    primarySubmissionSpeakerId: text("primary_submission_speaker_id").notNull(),
    primarySpeakerId: text("primary_speaker_id").notNull(),
    primaryAssociationIsPrimary: integer("primary_association_is_primary", { mode: "boolean" }).notNull().default(true),
    type: text("type", { enum: ["accepted", "revoked"] }).notNull(),
    submissionVersion: integer("submission_version").notNull(),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" }),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("acceptance_events_event_id_unique").on(t.eventId, t.id),
    uniqueIndex("acceptance_events_provisioning_parent_unique").on(t.eventId, t.id, t.submissionId, t.primarySpeakerId),
    uniqueIndex("acceptance_events_submission_version_unique").on(t.eventId, t.submissionId, t.submissionVersion),
    index("acceptance_events_event_cursor").on(t.eventId, t.occurredAt, t.id),
    index("acceptance_events_primary_speaker").on(t.eventId, t.primarySpeakerId),
    foreignKey({
      columns: [
        t.eventId,
        t.submissionId,
        t.primarySubmissionSpeakerId,
        t.primarySpeakerId,
        t.primaryAssociationIsPrimary,
      ],
      foreignColumns: [
        submissionSpeakers.eventId,
        submissionSpeakers.submissionId,
        submissionSpeakers.id,
        submissionSpeakers.speakerId,
        submissionSpeakers.isPrimary,
      ],
      name: "acceptance_events_primary_submission_speaker_fk",
    }).onDelete("restrict").onUpdate("cascade"),
    check("acceptance_events_version_positive", sql`${t.submissionVersion} > 0`),
    check("acceptance_events_primary_association", sql`${t.primaryAssociationIsPrimary} = 1`),
  ],
);

export const speakerProvisioning = sqliteTable(
  "speaker_provisioning",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    acceptanceEventId: text("acceptance_event_id").notNull(),
    submissionId: text("submission_id").notNull(),
    primarySpeakerId: text("primary_speaker_id").notNull(),
    status: text("status", { enum: ["pending", "claimed", "provisioned", "retry", "failed", "revoked"] }).notNull().default("pending"),
    availableAt: integer("available_at", { mode: "timestamp_ms" }).notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    provisionedAt: integer("provisioned_at", { mode: "timestamp_ms" }),
    version: version(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("speaker_provisioning_event_id_unique").on(t.eventId, t.id),
    uniqueIndex("speaker_provisioning_acceptance_unique").on(t.eventId, t.acceptanceEventId),
    index("speaker_provisioning_claim").on(t.status, t.availableAt, t.leaseExpiresAt, t.createdAt),
    index("speaker_provisioning_submission").on(t.eventId, t.submissionId),
    foreignKey({
      columns: [t.eventId, t.acceptanceEventId, t.submissionId, t.primarySpeakerId],
      foreignColumns: [
        acceptanceEvents.eventId,
        acceptanceEvents.id,
        acceptanceEvents.submissionId,
        acceptanceEvents.primarySpeakerId,
      ],
      name: "speaker_provisioning_acceptance_tuple_fk",
    }).onDelete("cascade").onUpdate("cascade"),
    check("speaker_provisioning_attempts_nonnegative", sql`${t.attemptCount} >= 0`),
    check("speaker_provisioning_version_positive", sql`${t.version} > 0`),
    check("speaker_provisioning_lease_pair", sql`(${t.leaseOwner} is null) = (${t.leaseExpiresAt} is null)`),
  ],
);

// ---------- review ----------

export const reviewRounds = sqliteTable(
  "review_rounds",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    name: text("name").notNull(),
    order: integer("order").notNull(),
    status: text("status", { enum: ["pending", "active", "complete"] }).notNull().default("pending"),
    startsAt: integer("starts_at", { mode: "timestamp_ms" }),
    endsAt: integer("ends_at", { mode: "timestamp_ms" }),
    blind: integer("blind", { mode: "boolean" }).notNull().default(false),
    rubric: text("rubric", { mode: "json" }),
    version: version(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("review_rounds_event_id_unique").on(t.eventId, t.id),
    uniqueIndex("review_rounds_event_order_unique").on(t.eventId, t.order),
    check("review_rounds_date_order", sql`${t.startsAt} is null or ${t.endsAt} is null or ${t.endsAt} > ${t.startsAt}`),
    check("review_rounds_version_positive", sql`${t.version} > 0`),
  ],
);

export const reviewAssignments = sqliteTable(
  "review_assignments",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    roundId: text("round_id").notNull(),
    submissionId: text("submission_id").notNull(),
    reviewerUserId: text("reviewer_user_id").notNull(),
    status: text("status", { enum: ["assigned", "recused"] }).notNull().default("assigned"),
    recusalReason: text("recusal_reason"),
    recusedAt: integer("recused_at", { mode: "timestamp_ms" }),
    version: version(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("review_assignments_event_id_unique").on(t.eventId, t.id),
    uniqueIndex("review_assignments_active_pair_unique")
      .on(t.eventId, t.roundId, t.submissionId, t.reviewerUserId)
      .where(sql`${t.status} = 'assigned'`),
    index("review_assignments_reviewer").on(t.eventId, t.reviewerUserId, t.roundId),
    index("review_assignments_submission").on(t.eventId, t.submissionId),
    index("review_assignments_recusals").on(t.eventId, t.roundId, t.status, t.recusedAt),
    foreignKey({ columns: [t.eventId, t.roundId], foreignColumns: [reviewRounds.eventId, reviewRounds.id], name: "review_assignments_round_fk" })
      .onDelete("cascade").onUpdate("cascade"),
    foreignKey({ columns: [t.eventId, t.submissionId], foreignColumns: [submissions.eventId, submissions.id], name: "review_assignments_submission_fk" })
      .onDelete("cascade").onUpdate("cascade"),
    foreignKey({ columns: [t.eventId, t.reviewerUserId], foreignColumns: [eventMembers.eventId, eventMembers.userId], name: "review_assignments_member_fk" })
      .onDelete("cascade").onUpdate("cascade"),
    check("review_assignments_version_positive", sql`${t.version} > 0`),
    check(
      "review_assignments_recusal_state",
      sql`(${t.status} = 'assigned' and ${t.recusalReason} is null and ${t.recusedAt} is null) or (${t.status} = 'recused' and ${t.recusedAt} is not null)`,
    ),
  ],
);

export const reviews = sqliteTable(
  "reviews",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    roundId: text("round_id").notNull(),
    submissionId: text("submission_id").notNull(),
    reviewerUserId: text("reviewer_user_id"),
    ai: integer("ai", { mode: "boolean" }).notNull().default(false),
    score: real("score").notNull(),
    scores: text("scores", { mode: "json" }).$type<Record<string, number | string>>(),
    comment: text("comment"),
    version: version(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("reviews_event_id_unique").on(t.eventId, t.id),
    uniqueIndex("reviews_human_unique").on(t.eventId, t.roundId, t.submissionId, t.reviewerUserId).where(sql`${t.ai} = 0`),
    index("reviews_submission").on(t.eventId, t.submissionId),
    foreignKey({ columns: [t.eventId, t.roundId], foreignColumns: [reviewRounds.eventId, reviewRounds.id], name: "reviews_round_fk" })
      .onDelete("cascade").onUpdate("cascade"),
    foreignKey({ columns: [t.eventId, t.submissionId], foreignColumns: [submissions.eventId, submissions.id], name: "reviews_submission_fk" })
      .onDelete("cascade").onUpdate("cascade"),
    foreignKey({ columns: [t.eventId, t.reviewerUserId], foreignColumns: [eventMembers.eventId, eventMembers.userId], name: "reviews_member_fk" })
      .onDelete("cascade").onUpdate("cascade"),
    check("reviews_actor_kind", sql`(${t.ai} = 1 and ${t.reviewerUserId} is null) or (${t.ai} = 0 and ${t.reviewerUserId} is not null)`),
    check("reviews_score_bounds", sql`${t.score} between 0 and 10`),
    check("reviews_version_positive", sql`${t.version} > 0`),
  ],
);

/** Append-only committee conversation, independent from rubric score revisions. */
export const reviewComments = sqliteTable(
  "review_comments",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    submissionId: text("submission_id").notNull(),
    authorUserId: text("author_user_id").notNull(),
    body: text("body").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("review_comments_event_id_unique").on(t.eventId, t.id),
    index("review_comments_submission_time").on(t.eventId, t.submissionId, t.createdAt),
    foreignKey({ columns: [t.eventId, t.submissionId], foreignColumns: [submissions.eventId, submissions.id], name: "review_comments_submission_fk" })
      .onDelete("cascade").onUpdate("cascade"),
    foreignKey({ columns: [t.eventId, t.authorUserId], foreignColumns: [eventMembers.eventId, eventMembers.userId], name: "review_comments_member_fk" })
      .onDelete("cascade").onUpdate("cascade"),
    check("review_comments_body_nonempty", sql`length(trim(${t.body})) > 0`),
  ],
);

// ---------- agenda ----------

export const tracks = sqliteTable("tracks", {
  id: id(),
  eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
  name: text("name").notNull(),
  color: text("color"),
  order: integer("order").notNull().default(0),
  version: version(),
  ...timestamps,
}, (t) => [
  uniqueIndex("tracks_event_id_unique").on(t.eventId, t.id),
  uniqueIndex("tracks_event_name_unique").on(t.eventId, t.name),
  check("tracks_version_positive", sql`${t.version} > 0`),
]);

export const rooms = sqliteTable("rooms", {
  id: id(),
  eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
  name: text("name").notNull(),
  capacity: integer("capacity"),
  order: integer("order").notNull().default(0),
  version: version(),
  ...timestamps,
}, (t) => [
  uniqueIndex("rooms_event_id_unique").on(t.eventId, t.id),
  uniqueIndex("rooms_event_name_unique").on(t.eventId, t.name),
  check("rooms_capacity_positive", sql`${t.capacity} is null or ${t.capacity} > 0`),
  check("rooms_version_positive", sql`${t.version} > 0`),
]);

export const talks = sqliteTable(
  "talks",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    submissionId: text("submission_id"),
    title: text("title").notNull(),
    description: text("description"),
    trackId: text("track_id"),
    roomId: text("room_id"),
    startsAt: integer("starts_at", { mode: "timestamp_ms" }),
    durationMin: integer("duration_min").notNull().default(30),
    status: text("status", { enum: ["draft", "confirmed", "cancelled"] }).notNull().default("draft"),
    version: version(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("talks_event_id_unique").on(t.eventId, t.id),
    index("talks_event_schedule").on(t.eventId, t.startsAt, t.roomId),
    index("talks_submission").on(t.eventId, t.submissionId),
    index("talks_track").on(t.eventId, t.trackId),
    foreignKey({ columns: [t.eventId, t.submissionId], foreignColumns: [submissions.eventId, submissions.id], name: "talks_submission_fk" })
      .onDelete("restrict").onUpdate("cascade"),
    foreignKey({ columns: [t.eventId, t.trackId], foreignColumns: [tracks.eventId, tracks.id], name: "talks_track_fk" })
      .onDelete("restrict").onUpdate("cascade"),
    foreignKey({ columns: [t.eventId, t.roomId], foreignColumns: [rooms.eventId, rooms.id], name: "talks_room_fk" })
      .onDelete("restrict").onUpdate("cascade"),
    check("talks_duration_positive", sql`${t.durationMin} > 0`),
    check("talks_version_positive", sql`${t.version} > 0`),
  ],
);

export const talkSpeakers = sqliteTable(
  "talk_speakers",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    talkId: text("talk_id").notNull(),
    speakerId: text("speaker_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("talk_speakers_event_id_unique").on(t.eventId, t.id),
    uniqueIndex("talk_speakers_pair_unique").on(t.eventId, t.talkId, t.speakerId),
    index("talk_speakers_speaker").on(t.eventId, t.speakerId),
    foreignKey({ columns: [t.eventId, t.talkId], foreignColumns: [talks.eventId, talks.id], name: "talk_speakers_talk_fk" })
      .onDelete("cascade").onUpdate("cascade"),
    foreignKey({ columns: [t.eventId, t.speakerId], foreignColumns: [speakers.eventId, speakers.id], name: "talk_speakers_speaker_fk" })
      .onDelete("cascade").onUpdate("cascade"),
  ],
);

// ---------- onboarding tasks ----------

export const tasks = sqliteTable("tasks", {
  id: id(),
  eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  kind: text("kind", { enum: ["profile", "upload", "form", "link", "confirm"] }).notNull(),
  formId: text("form_id"),
  dueAt: integer("due_at", { mode: "timestamp_ms" }),
  order: integer("order").notNull().default(0),
  targetMode: text("target_mode", { enum: ["all", "selected"] }).notNull().default("all"),
  version: version(),
  ...timestamps,
}, (t) => [
  uniqueIndex("tasks_event_id_unique").on(t.eventId, t.id),
  index("tasks_event_order").on(t.eventId, t.order),
  foreignKey({ columns: [t.eventId, t.formId], foreignColumns: [forms.eventId, forms.id], name: "tasks_form_fk" })
    .onDelete("restrict").onUpdate("cascade"),
  check("tasks_form_kind", sql`(${t.kind} = 'form' and ${t.formId} is not null) or (${t.kind} <> 'form' and ${t.formId} is null)`),
  check("tasks_version_positive", sql`${t.version} > 0`),
]);

export const taskAssignments = sqliteTable(
  "task_assignments",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    taskId: text("task_id").notNull(),
    speakerId: text("speaker_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("task_assignments_event_id_unique").on(t.eventId, t.id),
    uniqueIndex("task_assignments_pair_unique").on(t.eventId, t.taskId, t.speakerId),
    index("task_assignments_speaker").on(t.eventId, t.speakerId),
    foreignKey({ columns: [t.eventId, t.taskId], foreignColumns: [tasks.eventId, tasks.id], name: "task_assignments_task_fk" })
      .onDelete("cascade").onUpdate("cascade"),
    foreignKey({ columns: [t.eventId, t.speakerId], foreignColumns: [speakers.eventId, speakers.id], name: "task_assignments_speaker_fk" })
      .onDelete("cascade").onUpdate("cascade"),
  ],
);

export const taskCompletions = sqliteTable(
  "task_completions",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    taskId: text("task_id").notNull(),
    speakerId: text("speaker_id").notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }).notNull(),
    data: text("data", { mode: "json" }),
    version: version(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("task_completions_event_id_unique").on(t.eventId, t.id),
    uniqueIndex("task_completions_pair_unique").on(t.eventId, t.taskId, t.speakerId),
    index("task_completions_speaker").on(t.eventId, t.speakerId),
    foreignKey({ columns: [t.eventId, t.taskId], foreignColumns: [tasks.eventId, tasks.id], name: "task_completions_task_fk" })
      .onDelete("cascade").onUpdate("cascade"),
    foreignKey({ columns: [t.eventId, t.speakerId], foreignColumns: [speakers.eventId, speakers.id], name: "task_completions_speaker_fk" })
      .onDelete("cascade").onUpdate("cascade"),
    check("task_completions_version_positive", sql`${t.version} > 0`),
  ],
);

/** Organizer-recorded chase history. Draft generation alone is never treated as contact. */
export const speakerContacts = sqliteTable(
  "speaker_contacts",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    speakerId: text("speaker_id").notNull(),
    actorUserId: text("actor_user_id").notNull().references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }),
    medium: text("medium", { enum: ["toolEmail", "personalEmail", "text", "phone"] }).notNull(),
    note: text("note"),
    contactedAt: integer("contacted_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("speaker_contacts_event_id_unique").on(t.eventId, t.id),
    index("speaker_contacts_speaker_time").on(t.eventId, t.speakerId, t.contactedAt),
    foreignKey({ columns: [t.eventId, t.speakerId], foreignColumns: [speakers.eventId, speakers.id], name: "speaker_contacts_speaker_fk" })
      .onDelete("cascade").onUpdate("cascade"),
  ],
);

// ---------- communications ----------

export const emailTemplates = sqliteTable("email_templates", {
  id: id(),
  eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
  name: text("name").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  attachIcs: integer("attach_ics", { mode: "boolean" }).notNull().default(false),
  version: version(),
  ...timestamps,
}, (t) => [
  uniqueIndex("email_templates_event_id_unique").on(t.eventId, t.id),
  uniqueIndex("email_templates_event_name_unique").on(t.eventId, t.name),
  check("email_templates_version_positive", sql`${t.version} > 0`),
]);

/** Immutable rendered delivery content; auth bodies may be irreversibly redacted after terminal delivery. */
export const mailDeliverySnapshots = sqliteTable(
  "mail_delivery_snapshots",
  {
    id: id(),
    eventId: text("event_id").references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    templateId: text("template_id"),
    recipientUserId: text("recipient_user_id").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" }),
    recipientEmail: text("recipient_email").notNull(),
    recipientName: text("recipient_name"),
    fromEmail: text("from_email").notNull(),
    replyToEmail: text("reply_to_email"),
    subject: text("subject").notNull(),
    renderedHtml: text("rendered_html"),
    renderedText: text("rendered_text"),
    icsFilename: text("ics_filename"),
    icsContent: text("ics_content"),
    redactedAt: integer("redacted_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("mail_snapshots_event_id_unique").on(t.eventId, t.id),
    index("mail_snapshots_retention").on(t.redactedAt, t.createdAt),
    foreignKey({ columns: [t.eventId, t.templateId], foreignColumns: [emailTemplates.eventId, emailTemplates.id], name: "mail_snapshots_template_fk" })
      .onDelete("restrict").onUpdate("cascade"),
    check("mail_snapshots_template_event", sql`${t.templateId} is null or ${t.eventId} is not null`),
    check("mail_snapshots_ics_pair", sql`(${t.icsFilename} is null) = (${t.icsContent} is null)`),
    check(
      "mail_snapshots_content_state",
      sql`(${t.redactedAt} is null and ${t.renderedHtml} is not null) or (${t.redactedAt} is not null and ${t.renderedHtml} is null and ${t.renderedText} is null and ${t.icsFilename} is null and ${t.icsContent} is null)`,
    ),
  ],
);

/** Durable recipient/event identity retained after rendered calendar content is redacted. */
export const mailCalendarEvents = sqliteTable(
  "mail_calendar_events",
  {
    id: id(),
    snapshotId: text("snapshot_id").notNull().references(() => mailDeliverySnapshots.id, { onDelete: "cascade", onUpdate: "cascade" }),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    speakerId: text("speaker_id").notNull(),
    talkId: text("talk_id").notNull(),
    calendarUid: text("calendar_uid").notNull(),
    sequence: integer("sequence").notNull(),
    publicationRevision: integer("publication_revision").notNull(),
    status: text("status", { enum: ["confirmed", "cancelled"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("mail_calendar_events_snapshot_talk_unique").on(t.snapshotId, t.talkId),
    index("mail_calendar_events_event_recipient").on(t.eventId, t.speakerId, t.sequence),
    index("mail_calendar_events_event_talk").on(t.eventId, t.talkId, t.sequence),
    foreignKey({
      columns: [t.eventId, t.snapshotId],
      foreignColumns: [mailDeliverySnapshots.eventId, mailDeliverySnapshots.id],
      name: "mail_calendar_events_snapshot_event_fk",
    }).onDelete("cascade").onUpdate("cascade"),
    check("mail_calendar_events_sequence_positive", sql`${t.sequence} > 0`),
    check("mail_calendar_events_publication_revision_positive", sql`${t.publicationRevision} > 0`),
  ],
);

export const mailDeliveries = sqliteTable(
  "mail_deliveries",
  {
    id: id(),
    snapshotId: text("snapshot_id").notNull().references(() => mailDeliverySnapshots.id, { onDelete: "cascade", onUpdate: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status", { enum: ["pending", "claimed", "dispatching", "retry", "sent", "dead_letter", "cancelled"] }).notNull().default("pending"),
    scheduledFor: integer("scheduled_for", { mode: "timestamp_ms" }).notNull(),
    availableAt: integer("available_at", { mode: "timestamp_ms" }).notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    supersededAt: integer("superseded_at", { mode: "timestamp_ms" }),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(8),
    provider: text("provider").notNull().default("cloudflare-email"),
    providerMessageId: text("provider_message_id"),
    providerResult: text("provider_result", { mode: "json" }),
    lastError: text("last_error"),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    deadLetteredAt: integer("dead_lettered_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("mail_deliveries_snapshot_unique").on(t.snapshotId),
    uniqueIndex("mail_deliveries_idempotency_unique").on(t.idempotencyKey),
    uniqueIndex("mail_deliveries_provider_message_unique").on(t.provider, t.providerMessageId),
    index("mail_deliveries_claim").on(t.status, t.availableAt, t.leaseExpiresAt, t.createdAt),
    index("mail_deliveries_status").on(t.status, t.createdAt),
    check("mail_deliveries_attempts", sql`${t.attemptCount} >= 0 and ${t.maxAttempts} > 0 and ${t.attemptCount} <= ${t.maxAttempts}`),
    check("mail_deliveries_lease_pair", sql`(${t.leaseOwner} is null) = (${t.leaseExpiresAt} is null)`),
    check("mail_deliveries_sent_state", sql`(${t.status} = 'sent' and ${t.sentAt} is not null and ${t.providerMessageId} is not null) or ${t.status} <> 'sent'`),
    check("mail_deliveries_dead_state", sql`(${t.status} = 'dead_letter' and ${t.deadLetteredAt} is not null) or ${t.status} <> 'dead_letter'`),
  ],
);

/** Reviewer-specific invitation bridge into the existing user and event-member model. */
export const reviewerInvitations = sqliteTable(
  "reviewer_invitations",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull(),
    status: text("status", { enum: ["pending", "accepted", "expired"] }).notNull().default("pending"),
    invitedByUserId: text("invited_by_user_id").notNull().references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }),
    acceptedByUserId: text("accepted_by_user_id").references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }),
    deliveryId: text("delivery_id").notNull().references(() => mailDeliveries.id, { onDelete: "cascade", onUpdate: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
    version: version(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("reviewer_invitations_event_id_unique").on(t.eventId, t.id),
    uniqueIndex("reviewer_invitations_token_hash_unique").on(t.tokenHash),
    uniqueIndex("reviewer_invitations_pending_email_unique")
      .on(t.eventId, t.email)
      .where(sql`${t.status} = 'pending'`),
    index("reviewer_invitations_event_status").on(t.eventId, t.status, t.createdAt),
    check("reviewer_invitations_token_hash_format", sql`length(${t.tokenHash}) = 64 and ${t.tokenHash} = lower(${t.tokenHash}) and ${t.tokenHash} not glob '*[^0-9a-f]*'`),
    check("reviewer_invitations_version_positive", sql`${t.version} > 0`),
    check(
      "reviewer_invitations_acceptance_state",
      sql`(${t.status} = 'accepted' and ${t.acceptedAt} is not null and ${t.acceptedByUserId} is not null) or (${t.status} <> 'accepted' and ${t.acceptedAt} is null and ${t.acceptedByUserId} is null)`,
    ),
  ],
);

export const mailDeliveryAttempts = sqliteTable(
  "mail_delivery_attempts",
  {
    id: id(),
    deliveryId: text("delivery_id").notNull().references(() => mailDeliveries.id, { onDelete: "cascade", onUpdate: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    leaseOwner: text("lease_owner").notNull(),
    status: text("status", { enum: ["started", "sent", "retry", "failed"] }).notNull(),
    providerMessageId: text("provider_message_id"),
    providerResult: text("provider_result", { mode: "json" }),
    error: text("error"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("mail_attempts_number_unique").on(t.deliveryId, t.attemptNumber),
    index("mail_attempts_delivery").on(t.deliveryId, t.startedAt),
    check("mail_attempts_number_positive", sql`${t.attemptNumber} > 0`),
    check("mail_attempts_completion", sql`${t.status} = 'started' or ${t.completedAt} is not null`),
  ],
);

// ---------- content ----------

export const pages = sqliteTable("pages", {
  id: id(),
  eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  htmlEmbed: text("html_embed"),
  audience: text("audience", { enum: ["speakers", "public"] }).notNull().default("speakers"),
  order: integer("order").notNull().default(0),
  version: version(),
  ...timestamps,
}, (t) => [
  uniqueIndex("pages_event_id_unique").on(t.eventId, t.id),
  uniqueIndex("pages_event_slug_unique").on(t.eventId, t.slug),
  check("pages_version_positive", sql`${t.version} > 0`),
]);

export const embeds = sqliteTable("embeds", {
  id: id(),
  eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
  name: text("name").notNull(),
  widget: text("widget", { enum: ["schedule", "speakerGallery"] }).notNull(),
  preset: text("preset", { enum: ["sessions", "agenda", "itinerary", "speakerList", "speakerGallery"] }).notNull(),
  aesthetic: text("aesthetic", { enum: ["bold", "minimal", "editorial"] }).notNull().default("bold"),
  accent: text("accent").notNull().default("#7857FF"),
  trackId: text("track_id"),
  track: text("track"),
  fields: text("fields", { mode: "json" }).$type<readonly string[]>().notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  version: version(),
  ...timestamps,
}, (t) => [
  uniqueIndex("embeds_event_id_unique").on(t.eventId, t.id),
  index("embeds_event_updated").on(t.eventId, t.updatedAt),
  index("embeds_track").on(t.eventId, t.trackId),
  foreignKey({ columns: [t.eventId, t.trackId], foreignColumns: [tracks.eventId, tracks.id], name: "embeds_track_fk" })
    .onDelete("restrict").onUpdate("cascade"),
  check("embeds_name_nonempty", sql`length(trim(${t.name})) > 0`),
  check("embeds_accent_hex", sql`${t.accent} glob '#[0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]'`),
  check("embeds_version_positive", sql`${t.version} > 0`),
  check(
    "embeds_widget_preset",
    sql`(${t.widget} = 'schedule' and ${t.preset} in ('sessions', 'agenda', 'itinerary')) or (${t.widget} = 'speakerGallery' and ${t.preset} in ('speakerList', 'speakerGallery'))`,
  ),
]);

// ---------- integration configuration and Airtable synchronization ----------

export const integrations = sqliteTable(
  "integrations",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    kind: text("kind", { enum: ["airtable", "accelevents"] }).notNull(),
    secretRef: text("secret_ref").notNull(),
    config: text("config", { mode: "json" }).notNull(),
    cursor: text("cursor"),
    lastSyncAt: integer("last_sync_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
    version: version(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("integrations_event_kind_unique").on(t.eventId, t.kind),
    uniqueIndex("integrations_event_id_unique").on(t.eventId, t.id),
    index("integrations_secret_ref").on(t.secretRef),
    check("integrations_secret_ref_nonempty", sql`length(${t.secretRef}) > 0`),
    check("integrations_version_positive", sql`${t.version} > 0`),
  ],
);

export const acceleventsExternalIdentities = sqliteTable(
  "accelevents_external_identities",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    integrationId: text("integration_id").notNull(),
    sourceEventId: text("source_event_id").notNull(),
    entityType: text("entity_type", { enum: ["speaker", "talk"] }).notNull(),
    externalId: text("external_id").notNull(),
    entityId: text("entity_id").notNull(),
    speakerId: text("speaker_id"),
    talkId: text("talk_id"),
    sourceHash: text("source_hash").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("accelevents_identities_event_id_unique").on(t.eventId, t.id),
    uniqueIndex("accelevents_identities_source_unique").on(
      t.eventId,
      t.integrationId,
      t.sourceEventId,
      t.entityType,
      t.externalId,
    ),
    uniqueIndex("accelevents_identities_local_unique").on(
      t.eventId,
      t.integrationId,
      t.sourceEventId,
      t.entityType,
      t.entityId,
    ),
    index("accelevents_identities_integration").on(
      t.eventId,
      t.integrationId,
      t.sourceEventId,
      t.entityType,
    ),
    foreignKey({
      columns: [t.eventId, t.integrationId],
      foreignColumns: [integrations.eventId, integrations.id],
      name: "accelevents_identities_integration_fk",
    }).onDelete("cascade").onUpdate("cascade"),
    foreignKey({
      columns: [t.eventId, t.speakerId],
      foreignColumns: [speakers.eventId, speakers.id],
      name: "accelevents_identities_speaker_fk",
    }).onDelete("cascade").onUpdate("cascade"),
    foreignKey({
      columns: [t.eventId, t.talkId],
      foreignColumns: [talks.eventId, talks.id],
      name: "accelevents_identities_talk_fk",
    }).onDelete("cascade").onUpdate("cascade"),
    check("accelevents_identities_entity_type", sql`${t.entityType} in ('speaker', 'talk')`),
    check(
      "accelevents_identities_entity_owner",
      sql`(
        ${t.entityType} = 'speaker'
        and ${t.speakerId} = ${t.entityId}
        and ${t.talkId} is null
      ) or (
        ${t.entityType} = 'talk'
        and ${t.speakerId} is null
        and ${t.talkId} = ${t.entityId}
      )`,
    ),
    check("accelevents_identities_source_event_nonempty", sql`length(${t.sourceEventId}) > 0`),
    check("accelevents_identities_external_nonempty", sql`length(${t.externalId}) > 0`),
    check("accelevents_identities_hash_length", sql`length(${t.sourceHash}) = 64`),
  ],
);

export const acceleventsImportRuns = sqliteTable(
  "accelevents_import_runs",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    integrationId: text("integration_id").notNull(),
    sourceEventId: text("source_event_id").notNull(),
    eventUrl: text("event_url").notNull(),
    mode: text("mode", { enum: ["fixture", "live"] }).notNull(),
    status: text("status", { enum: ["running", "succeeded", "partial", "failed"] }).notNull(),
    totalCount: integer("total_count").notNull().default(0),
    createdCount: integer("created_count").notNull().default(0),
    updatedCount: integer("updated_count").notNull().default(0),
    unchangedCount: integer("unchanged_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    errorCode: text("error_code"),
    errorDetail: text("error_detail"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("accelevents_runs_event_id_unique").on(t.eventId, t.id),
    uniqueIndex("accelevents_runs_parent_unique").on(t.eventId, t.integrationId, t.id),
    index("accelevents_runs_latest").on(t.eventId, t.integrationId, t.startedAt, t.id),
    foreignKey({
      columns: [t.eventId, t.integrationId],
      foreignColumns: [integrations.eventId, integrations.id],
      name: "accelevents_runs_integration_fk",
    }).onDelete("cascade").onUpdate("cascade"),
    check("accelevents_runs_mode", sql`${t.mode} in ('fixture', 'live')`),
    check("accelevents_runs_status", sql`${t.status} in ('running', 'succeeded', 'partial', 'failed')`),
    check("accelevents_runs_source_event_nonempty", sql`length(${t.sourceEventId}) > 0`),
    check("accelevents_runs_event_url_nonempty", sql`length(${t.eventUrl}) > 0`),
    check(
      "accelevents_runs_counts",
      sql`${t.totalCount} >= 0
        and ${t.createdCount} >= 0
        and ${t.updatedCount} >= 0
        and ${t.unchangedCount} >= 0
        and ${t.failedCount} >= 0
        and ${t.totalCount} = ${t.createdCount} + ${t.updatedCount} + ${t.unchangedCount} + ${t.failedCount}`,
    ),
    check(
      "accelevents_runs_completion",
      sql`(${t.status} = 'running' and ${t.completedAt} is null)
        or (${t.status} <> 'running' and ${t.completedAt} is not null)`,
    ),
    check(
      "accelevents_runs_error_shape",
      sql`(${t.status} = 'failed' and ${t.errorCode} is not null and ${t.errorDetail} is not null)
        or (${t.status} <> 'failed' and ${t.errorCode} is null and ${t.errorDetail} is null)`,
    ),
  ],
);

export const acceleventsImportItems = sqliteTable(
  "accelevents_import_items",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    integrationId: text("integration_id").notNull(),
    runId: text("run_id").notNull(),
    order: integer("item_order").notNull(),
    entityType: text("entity_type", { enum: ["speaker", "talk"] }).notNull(),
    externalId: text("external_id").notNull(),
    action: text("action", { enum: ["created", "updated", "unchanged", "failed"] }).notNull(),
    localId: text("local_id"),
    errorCode: text("error_code"),
    errorDetail: text("error_detail"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("accelevents_items_event_id_unique").on(t.eventId, t.id),
    uniqueIndex("accelevents_items_order_unique").on(t.eventId, t.runId, t.order),
    index("accelevents_items_run").on(t.eventId, t.integrationId, t.runId, t.order),
    foreignKey({
      columns: [t.eventId, t.integrationId, t.runId],
      foreignColumns: [
        acceleventsImportRuns.eventId,
        acceleventsImportRuns.integrationId,
        acceleventsImportRuns.id,
      ],
      name: "accelevents_items_run_fk",
    }).onDelete("cascade").onUpdate("cascade"),
    check("accelevents_items_entity_type", sql`${t.entityType} in ('speaker', 'talk')`),
    check("accelevents_items_action", sql`${t.action} in ('created', 'updated', 'unchanged', 'failed')`),
    check("accelevents_items_order_nonnegative", sql`${t.order} >= 0`),
    check("accelevents_items_external_nonempty", sql`length(${t.externalId}) > 0`),
    check(
      "accelevents_items_result_shape",
      sql`(${t.action} = 'failed'
        and ${t.localId} is null
        and ${t.errorCode} is not null
        and ${t.errorDetail} is not null)
        or (${t.action} <> 'failed'
        and ${t.localId} is not null
        and ${t.errorCode} is null
        and ${t.errorDetail} is null)`,
    ),
  ],
);

export const airtableRecordLinks = sqliteTable(
  "airtable_record_links",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    integrationId: text("integration_id").notNull(),
    entityType: text("entity_type", { enum: ["speaker", "submission", "talk"] }).notNull(),
    entityId: text("entity_id").notNull(),
    speakerId: text("speaker_id"),
    submissionId: text("submission_id"),
    talkId: text("talk_id"),
    sessionPartyId: text("session_party_id").notNull(),
    airtableRecordId: text("airtable_record_id").notNull(),
    outboundRevision: integer("outbound_revision").notNull().default(0),
    outboundHash: text("outbound_hash"),
    inboundRevision: text("inbound_revision"),
    inboundHash: text("inbound_hash"),
    origin: text("origin"),
    lastRefreshedAt: integer("last_refreshed_at", { mode: "timestamp_ms" }),
    version: version(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("airtable_links_event_id_unique").on(t.eventId, t.id),
    uniqueIndex("airtable_links_entity_unique").on(t.eventId, t.integrationId, t.entityType, t.entityId),
    uniqueIndex("airtable_links_session_party_unique").on(t.integrationId, t.entityType, t.sessionPartyId),
    uniqueIndex("airtable_links_record_unique").on(t.integrationId, t.entityType, t.airtableRecordId),
    index("airtable_links_refresh").on(t.integrationId, t.entityType, t.lastRefreshedAt),
    foreignKey({
      columns: [t.eventId, t.integrationId],
      foreignColumns: [integrations.eventId, integrations.id],
      name: "airtable_links_integration_fk",
    }).onDelete("cascade").onUpdate("cascade"),
    foreignKey({
      columns: [t.eventId, t.speakerId],
      foreignColumns: [speakers.eventId, speakers.id],
      name: "airtable_links_speaker_fk",
    }).onDelete("cascade").onUpdate("cascade"),
    foreignKey({
      columns: [t.eventId, t.submissionId],
      foreignColumns: [submissions.eventId, submissions.id],
      name: "airtable_links_submission_fk",
    }).onDelete("cascade").onUpdate("cascade"),
    foreignKey({
      columns: [t.eventId, t.talkId],
      foreignColumns: [talks.eventId, talks.id],
      name: "airtable_links_talk_fk",
    }).onDelete("cascade").onUpdate("cascade"),
    check(
      "airtable_links_entity_owner",
      sql`(
        ${t.entityType} = 'speaker'
        and ${t.speakerId} = ${t.entityId}
        and ${t.submissionId} is null
        and ${t.talkId} is null
      ) or (
        ${t.entityType} = 'submission'
        and ${t.speakerId} is null
        and ${t.submissionId} = ${t.entityId}
        and ${t.talkId} is null
      ) or (
        ${t.entityType} = 'talk'
        and ${t.speakerId} is null
        and ${t.submissionId} is null
        and ${t.talkId} = ${t.entityId}
      )`,
    ),
    check("airtable_links_session_party_matches", sql`${t.sessionPartyId} = ${t.entityId}`),
    check("airtable_links_revision_nonnegative", sql`${t.outboundRevision} >= 0`),
    check("airtable_links_outbound_hash_length", sql`${t.outboundHash} is null or length(${t.outboundHash}) = 64`),
    check("airtable_links_inbound_hash_length", sql`${t.inboundHash} is null or length(${t.inboundHash}) = 64`),
    check("airtable_links_version_positive", sql`${t.version} > 0`),
  ],
);

export const airtablePendingEdits = sqliteTable(
  "airtable_pending_edits",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    integrationId: text("integration_id").notNull(),
    entityType: text("entity_type", { enum: ["speaker", "submission", "talk"] }).notNull(),
    entityId: text("entity_id").notNull(),
    speakerId: text("speaker_id"),
    submissionId: text("submission_id"),
    talkId: text("talk_id"),
    fieldKey: text("field_key").notNull(),
    intendedValue: text("intended_value", { mode: "json" }).notNull(),
    baseInboundRevision: text("base_inbound_revision"),
    baseInboundHash: text("base_inbound_hash"),
    status: text("status", { enum: ["pending", "confirmed", "conflict", "cancelled"] }).notNull().default("pending"),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    conflictValue: text("conflict_value", { mode: "json" }),
    version: version(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("airtable_pending_event_id_unique").on(t.eventId, t.id),
    uniqueIndex("airtable_pending_outbox_parent_unique").on(
      t.eventId,
      t.integrationId,
      t.id,
      t.entityType,
      t.entityId,
    ),
    uniqueIndex("airtable_pending_one_active").on(
      t.eventId,
      t.integrationId,
      t.entityType,
      t.entityId,
      t.fieldKey,
    ).where(sql`${t.status} = 'pending'`),
    index("airtable_pending_entity").on(t.eventId, t.entityType, t.entityId, t.status),
    index("airtable_pending_integration").on(t.integrationId, t.status, t.createdAt),
    foreignKey({
      columns: [t.eventId, t.integrationId],
      foreignColumns: [integrations.eventId, integrations.id],
      name: "airtable_pending_integration_fk",
    }).onDelete("cascade").onUpdate("cascade"),
    foreignKey({
      columns: [t.eventId, t.speakerId],
      foreignColumns: [speakers.eventId, speakers.id],
      name: "airtable_pending_speaker_fk",
    }).onDelete("cascade").onUpdate("cascade"),
    foreignKey({
      columns: [t.eventId, t.submissionId],
      foreignColumns: [submissions.eventId, submissions.id],
      name: "airtable_pending_submission_fk",
    }).onDelete("cascade").onUpdate("cascade"),
    foreignKey({
      columns: [t.eventId, t.talkId],
      foreignColumns: [talks.eventId, talks.id],
      name: "airtable_pending_talk_fk",
    }).onDelete("cascade").onUpdate("cascade"),
    check(
      "airtable_pending_entity_owner",
      sql`(
        ${t.entityType} = 'speaker'
        and ${t.speakerId} = ${t.entityId}
        and ${t.submissionId} is null
        and ${t.talkId} is null
      ) or (
        ${t.entityType} = 'submission'
        and ${t.speakerId} is null
        and ${t.submissionId} = ${t.entityId}
        and ${t.talkId} is null
      ) or (
        ${t.entityType} = 'talk'
        and ${t.speakerId} is null
        and ${t.submissionId} is null
        and ${t.talkId} = ${t.entityId}
      )`,
    ),
    check("airtable_pending_hash_length", sql`${t.baseInboundHash} is null or length(${t.baseInboundHash}) = 64`),
    check("airtable_pending_resolution", sql`(${t.status} = 'pending' and ${t.resolvedAt} is null) or (${t.status} <> 'pending' and ${t.resolvedAt} is not null)`),
    check("airtable_pending_version_positive", sql`${t.version} > 0`),
  ],
);

export const airtableOutbox = sqliteTable(
  "airtable_outbox",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    integrationId: text("integration_id").notNull(),
    pendingEditId: text("pending_edit_id"),
    entityType: text("entity_type", { enum: ["speaker", "submission", "talk"] }).notNull(),
    entityId: text("entity_id").notNull(),
    speakerId: text("speaker_id"),
    submissionId: text("submission_id"),
    talkId: text("talk_id"),
    sessionPartyId: text("session_party_id").notNull(),
    operation: text("operation", { enum: ["upsert", "delete"] }).notNull(),
    changedFields: text("changed_fields", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    outboundRevision: integer("outbound_revision").notNull(),
    outboundHash: text("outbound_hash").notNull(),
    origin: text("origin").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status", { enum: ["pending", "claimed", "retry", "succeeded", "dead_letter", "blocked"] }).notNull().default("pending"),
    availableAt: integer("available_at", { mode: "timestamp_ms" }).notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    deadLetteredAt: integer("dead_lettered_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("airtable_outbox_event_id_unique").on(t.eventId, t.id),
    uniqueIndex("airtable_outbox_revision_unique").on(t.integrationId, t.entityType, t.entityId, t.outboundRevision),
    uniqueIndex("airtable_outbox_idempotency_unique").on(t.integrationId, t.idempotencyKey),
    index("airtable_outbox_claim").on(t.integrationId, t.status, t.availableAt, t.leaseExpiresAt, t.createdAt),
    index("airtable_outbox_order").on(t.integrationId, t.entityType, t.entityId, t.outboundRevision),
    foreignKey({
      columns: [t.eventId, t.integrationId],
      foreignColumns: [integrations.eventId, integrations.id],
      name: "airtable_outbox_integration_fk",
    }).onDelete("cascade").onUpdate("cascade"),
    foreignKey({
      columns: [t.eventId, t.speakerId],
      foreignColumns: [speakers.eventId, speakers.id],
      name: "airtable_outbox_speaker_fk",
    }).onDelete("cascade").onUpdate("cascade"),
    foreignKey({
      columns: [t.eventId, t.submissionId],
      foreignColumns: [submissions.eventId, submissions.id],
      name: "airtable_outbox_submission_fk",
    }).onDelete("cascade").onUpdate("cascade"),
    foreignKey({
      columns: [t.eventId, t.talkId],
      foreignColumns: [talks.eventId, talks.id],
      name: "airtable_outbox_talk_fk",
    }).onDelete("cascade").onUpdate("cascade"),
    foreignKey({
      columns: [t.eventId, t.integrationId, t.pendingEditId, t.entityType, t.entityId],
      foreignColumns: [
        airtablePendingEdits.eventId,
        airtablePendingEdits.integrationId,
        airtablePendingEdits.id,
        airtablePendingEdits.entityType,
        airtablePendingEdits.entityId,
      ],
      name: "airtable_outbox_pending_fk",
    }).onDelete("restrict").onUpdate("cascade"),
    check(
      "airtable_outbox_entity_owner",
      sql`(
        ${t.entityType} = 'speaker'
        and ${t.speakerId} = ${t.entityId}
        and ${t.submissionId} is null
        and ${t.talkId} is null
      ) or (
        ${t.entityType} = 'submission'
        and ${t.speakerId} is null
        and ${t.submissionId} = ${t.entityId}
        and ${t.talkId} is null
      ) or (
        ${t.entityType} = 'talk'
        and ${t.speakerId} is null
        and ${t.submissionId} is null
        and ${t.talkId} = ${t.entityId}
      )`,
    ),
    check("airtable_outbox_session_party_matches", sql`${t.sessionPartyId} = ${t.entityId}`),
    check("airtable_outbox_revision_positive", sql`${t.outboundRevision} > 0`),
    check("airtable_outbox_hash_length", sql`length(${t.outboundHash}) = 64`),
    check("airtable_outbox_attempts_nonnegative", sql`${t.attemptCount} >= 0`),
    check("airtable_outbox_lease_pair", sql`(${t.leaseOwner} is null) = (${t.leaseExpiresAt} is null)`),
    check("airtable_outbox_dead_state", sql`(${t.status} = 'dead_letter' and ${t.deadLetteredAt} is not null) or ${t.status} <> 'dead_letter'`),
  ],
);

export const airtableRefreshState = sqliteTable(
  "airtable_refresh_state",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    integrationId: text("integration_id").notNull(),
    entityType: text("entity_type", { enum: ["speaker", "submission", "talk"] }).notNull(),
    status: text("status", { enum: ["idle", "requested", "claimed", "retry", "dead_letter"] }).notNull().default("idle"),
    requestedAt: integer("requested_at", { mode: "timestamp_ms" }),
    dueAt: integer("due_at", { mode: "timestamp_ms" }),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    attemptCount: integer("attempt_count").notNull().default(0),
    cursor: text("cursor"),
    lastSuccessAt: integer("last_success_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
    deadLetteredAt: integer("dead_lettered_at", { mode: "timestamp_ms" }),
    version: version(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("airtable_refresh_event_id_unique").on(t.eventId, t.id),
    uniqueIndex("airtable_refresh_entity_unique").on(t.eventId, t.integrationId, t.entityType),
    index("airtable_refresh_claim").on(t.integrationId, t.status, t.dueAt, t.leaseExpiresAt),
    index("airtable_refresh_staleness").on(t.integrationId, t.entityType, t.lastSuccessAt),
    foreignKey({ columns: [t.eventId, t.integrationId], foreignColumns: [integrations.eventId, integrations.id], name: "airtable_refresh_integration_fk" })
      .onDelete("cascade").onUpdate("cascade"),
    check("airtable_refresh_attempts_nonnegative", sql`${t.attemptCount} >= 0`),
    check("airtable_refresh_lease_pair", sql`(${t.leaseOwner} is null) = (${t.leaseExpiresAt} is null)`),
    check("airtable_refresh_dead_state", sql`(${t.status} = 'dead_letter' and ${t.deadLetteredAt} is not null) or ${t.status} <> 'dead_letter'`),
    check("airtable_refresh_version_positive", sql`${t.version} > 0`),
  ],
);

export const airtableDeadLetters = sqliteTable(
  "airtable_dead_letters",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    integrationId: text("integration_id").notNull(),
    sourceType: text("source_type", { enum: ["outbox", "refresh"] }).notNull(),
    sourceId: text("source_id").notNull(),
    errorCode: text("error_code").notNull(),
    errorMessage: text("error_message").notNull(),
    evidence: text("evidence", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    resolvedByUserId: text("resolved_by_user_id").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" }),
    resolution: text("resolution"),
  },
  (t) => [
    uniqueIndex("airtable_dead_event_id_unique").on(t.eventId, t.id),
    uniqueIndex("airtable_dead_source_unique").on(t.integrationId, t.sourceType, t.sourceId),
    index("airtable_dead_unresolved").on(t.eventId, t.resolvedAt, t.createdAt),
    foreignKey({ columns: [t.eventId, t.integrationId], foreignColumns: [integrations.eventId, integrations.id], name: "airtable_dead_integration_fk" })
      .onDelete("cascade").onUpdate("cascade"),
    check("airtable_dead_resolution_pair", sql`(${t.resolvedAt} is null) = (${t.resolution} is null)`),
  ],
);

// ---------- mutation safety and replay ----------

export const idempotencyRecords = sqliteTable(
  "idempotency_records",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    operationId: text("operation_id").notNull(),
    principalId: text("principal_id").notNull(),
    keyHash: text("key_hash").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status", { enum: ["in_progress", "completed", "failed"] }).notNull().default("in_progress"),
    responseStatus: integer("response_status"),
    responseBody: text("response_body", { mode: "json" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("idempotency_event_id_unique").on(t.eventId, t.id),
    uniqueIndex("idempotency_key_unique").on(t.eventId, t.operationId, t.principalId, t.keyHash),
    index("idempotency_cleanup").on(t.expiresAt),
    index("idempotency_in_progress").on(t.status, t.createdAt),
    check("idempotency_key_hash_length", sql`length(${t.keyHash}) = 64`),
    check("idempotency_request_hash_length", sql`length(${t.requestHash}) = 64`),
    check("idempotency_completion_state", sql`(${t.status} = 'in_progress' and ${t.completedAt} is null) or (${t.status} <> 'in_progress' and ${t.completedAt} is not null)`),
  ],
);

/** Append-only event-scoped replay source; sequence is the monotonic cursor. */
export const domainChanges = sqliteTable(
  "domain_changes",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    id: text("id").notNull(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    aggregateVersion: integer("aggregate_version").notNull(),
    eventType: text("event_type").notNull(),
    audiences: text("audiences", { mode: "json" }).notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" }),
    actorApiKeyId: text("actor_api_key_id").references(() => apiKeys.id, { onDelete: "set null", onUpdate: "cascade" }),
    requestId: text("request_id").notNull(),
    idempotencyRecordId: text("idempotency_record_id"),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("domain_changes_id_unique").on(t.id),
    uniqueIndex("domain_changes_aggregate_version_unique").on(t.eventId, t.aggregateType, t.aggregateId, t.aggregateVersion, t.eventType),
    index("domain_changes_event_cursor").on(t.eventId, t.sequence),
    index("domain_changes_request").on(t.requestId),
    foreignKey({ columns: [t.eventId, t.idempotencyRecordId], foreignColumns: [idempotencyRecords.eventId, idempotencyRecords.id], name: "domain_changes_idempotency_fk" })
      .onDelete("restrict").onUpdate("cascade"),
    check("domain_changes_version_positive", sql`${t.aggregateVersion} > 0`),
  ],
);

/** Append-only security/administrative evidence retained independently of actors. */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: id(),
    eventId: eventId().references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    requestId: text("request_id").notNull(),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" }),
    actorApiKeyId: text("actor_api_key_id").references(() => apiKeys.id, { onDelete: "set null", onUpdate: "cascade" }),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    before: text("before", { mode: "json" }),
    after: text("after", { mode: "json" }),
    metadata: text("metadata", { mode: "json" }),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("audit_log_event_id_unique").on(t.eventId, t.id),
    index("audit_log_event_time").on(t.eventId, t.occurredAt, t.id),
    index("audit_log_resource").on(t.eventId, t.resourceType, t.resourceId, t.occurredAt),
    index("audit_log_request").on(t.requestId),
  ],
);
