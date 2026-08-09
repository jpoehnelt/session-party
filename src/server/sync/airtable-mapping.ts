import type { AirtableConfig, AirtableEntityType } from "contracts/types";
import { IntegrationConfig } from "contracts/types";
import { Schema } from "effect";

export const AIRTABLE_ENTITY_TYPES = ["speaker", "submission", "talk"] as const satisfies readonly AirtableEntityType[];

export const decodeAirtableConfig = (value: unknown): AirtableConfig | null => {
  const decoded = Schema.decodeUnknownEither(IntegrationConfig)(value);
  return decoded._tag === "Right" && decoded.right.kind === "airtable"
    ? decoded.right
    : null;
};

const sortJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
};

export const canonicalJson = (value: unknown): string => JSON.stringify(sortJson(value));

export const sha256 = async (value: unknown): Promise<string> => {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const tableConfigFor = (config: AirtableConfig, entityType: AirtableEntityType) => {
  switch (entityType) {
    case "speaker": return config.tables.speakers;
    case "submission": return config.tables.submissions;
    case "talk": return config.tables.talks;
  }
};

export const airtableOwnedLogicalFields = (
  entityType: AirtableEntityType,
): readonly string[] => {
  switch (entityType) {
    case "speaker": return ["displayName", "title", "company", "bio"];
    case "submission": return ["title", "abstract", "category"];
    case "talk": return ["title", "description"];
  }
};

export const d1OwnedLogicalFields = (
  entityType: AirtableEntityType,
): readonly string[] => {
  switch (entityType) {
    case "speaker": return ["visible"];
    case "submission": return ["status", "submittedAt", "speakerLinks"];
    case "talk": return [
      "track",
      "room",
      "startsAt",
      "durationMin",
      "status",
      "speakerLinks",
      "submissionLink",
    ];
  }
};

export const physicalFieldId = (
  config: AirtableConfig,
  entityType: AirtableEntityType,
  logicalField: string,
): string | null => {
  if (entityType === "speaker") {
    const fields = config.tables.speakers.fields;
    const mapping: Readonly<Record<string, string>> = {
      displayName: fields.displayName,
      title: fields.jobTitle,
      company: fields.company,
      bio: fields.bio,
      visible: fields.visibility,
    };
    return mapping[logicalField] ?? null;
  }
  if (entityType === "submission") {
    const fields = config.tables.submissions.fields;
    const mapping: Readonly<Record<string, string>> = {
      title: fields.title,
      abstract: fields.abstract,
      category: fields.category,
      status: fields.status,
      submittedAt: fields.submittedAt,
      speakerLinks: fields.speakerLinks,
    };
    return mapping[logicalField] ?? null;
  }
  const fields = config.tables.talks.fields;
  const mapping: Readonly<Record<string, string>> = {
    title: fields.title,
    description: fields.description,
    track: fields.track,
    room: fields.room,
    startsAt: fields.startsAt,
    durationMin: fields.durationMin,
    status: fields.status,
    speakerLinks: fields.speakerLinks,
    submissionLink: fields.submissionLink,
  };
  return mapping[logicalField] ?? null;
};

export const mapLogicalFieldsToAirtable = (
  config: AirtableConfig,
  entityType: AirtableEntityType,
  fields: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const mapped: Record<string, unknown> = {};
  for (const [logicalField, value] of Object.entries(fields)) {
    const physical = physicalFieldId(config, entityType, logicalField);
    if (physical) mapped[physical] = value;
  }
  return mapped;
};

export const readLogicalField = (
  config: AirtableConfig,
  entityType: AirtableEntityType,
  logicalField: string,
  fields: Readonly<Record<string, unknown>>,
): unknown => {
  const physical = physicalFieldId(config, entityType, logicalField);
  return physical ? fields[physical] : undefined;
};

export const connectorFieldIds = (
  config: AirtableConfig,
  entityType: AirtableEntityType,
): readonly string[] => {
  const fields = tableConfigFor(config, entityType).fields;
  return [fields.sessionPartyId, fields.spRevision, fields.spHash, fields.spOrigin];
};

export const allMappedFieldIds = (
  config: AirtableConfig,
  entityType: AirtableEntityType,
): readonly string[] => [
  ...new Set([
    ...connectorFieldIds(config, entityType),
    ...airtableOwnedLogicalFields(entityType)
      .map((field) => physicalFieldId(config, entityType, field))
      .filter((field): field is string => field !== null),
    ...d1OwnedLogicalFields(entityType)
      .map((field) => physicalFieldId(config, entityType, field))
      .filter((field): field is string => field !== null),
  ]),
];

export const connectorFields = (
  config: AirtableConfig,
  entityType: AirtableEntityType,
  input: {
    readonly sessionPartyId: string;
    readonly revision: number;
    readonly hash: string;
    readonly origin: string;
  },
): Readonly<Record<string, unknown>> => {
  const fields = tableConfigFor(config, entityType).fields;
  return {
    [fields.sessionPartyId]: input.sessionPartyId,
    [fields.spRevision]: input.revision,
    [fields.spHash]: input.hash,
    [fields.spOrigin]: input.origin,
  };
};

export const valueEquals = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);
