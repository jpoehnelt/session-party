import type { FormDetail, FormField, FormVersionField } from "./schema";

export const FORMS_FIXTURE_EVENT_ID = "event-ai-engineer-sandbox";
export const FORMS_FIXTURE_EVENT_SLUG = "ai-engineer-sandbox";
export const FORMS_FIXTURE_NOW = Date.UTC(2026, 7, 7, 16, 0, 0);

export interface FormsFixture {
  readonly id: "empty" | "draft" | "published" | "routed";
  readonly label: string;
  readonly description: string;
  readonly eventId: string;
  readonly eventSlug: string;
  readonly forms: readonly FormDetail[];
}

const routedDraftFields: readonly FormField[] = [
  {
    id: "field-session-title",
    order: 1,
    type: "text",
    label: "Session title",
    semanticKey: "submissionTitle",
    helpText: "Keep it specific and under 90 characters.",
    required: true,
    options: [],
    logic: null,
    routing: {},
    version: 1,
  },
  {
    id: "field-session-abstract",
    order: 2,
    type: "textarea",
    label: "Session abstract",
    semanticKey: "submissionAbstract",
    helpText: "What will attendees learn?",
    required: true,
    options: [],
    logic: null,
    routing: {},
    version: 1,
  },
  {
    id: "field-track",
    order: 3,
    type: "radio",
    label: "Best-fit track",
    semanticKey: null,
    helpText: "Choose the audience that benefits most.",
    required: true,
    options: ["AI systems", "Developer tools", "Research"],
    logic: null,
    routing: {
      "AI systems": "ai-systems",
      "Developer tools": "developer-tools",
      Research: "research",
    },
    version: 1,
  },
  {
    id: "field-workshop-plan",
    order: 4,
    type: "textarea",
    label: "Workshop exercise plan",
    semanticKey: null,
    helpText: "Shown only for developer tools proposals.",
    required: true,
    options: [],
    logic: {
      action: "show",
      mode: "all",
      conditions: [{ fieldId: "field-track", op: "eq", value: "Developer tools" }],
    },
    routing: {},
    version: 1,
  },
  {
    id: "field-commercial-disclosure",
    order: 5,
    type: "textarea",
    label: "Commercial disclosure",
    semanticKey: null,
    helpText: "Hidden for research submissions.",
    required: false,
    options: [],
    logic: {
      action: "hide",
      mode: "all",
      conditions: [{ fieldId: "field-track", op: "eq", value: "Research" }],
    },
    routing: {},
    version: 1,
  },
];

const publishedFields: readonly FormVersionField[] = routedDraftFields.map((field) => ({
  id: `version-1-${field.id}`,
  sourceFieldId: field.id,
  order: field.order,
  type: field.type,
  label: field.label,
  semanticKey: field.semanticKey,
  helpText: field.helpText,
  required: field.required,
  options: field.options,
  logic: field.logic,
  routing: field.routing,
}));

const draftPrimary: FormDetail = {
  id: "form-primary-cfp",
  eventId: FORMS_FIXTURE_EVENT_ID,
  purpose: "primary-cfp",
  name: "AI Engineer Sandbox — Call for proposals",
  description: "Share a practical session for builders shipping reliable AI systems.",
  status: "draft",
  opensAt: Date.UTC(2026, 7, 10, 16, 0, 0),
  closesAt: Date.UTC(2026, 8, 5, 23, 59, 0),
  version: 1,
  createdAt: FORMS_FIXTURE_NOW - 86_400_000,
  updatedAt: FORMS_FIXTURE_NOW,
  fields: routedDraftFields,
  publishedVersion: null,
};

const publishedPrimary: FormDetail = {
  ...draftPrimary,
  status: "open",
  version: 2,
  opensAt: Date.UTC(2026, 7, 7, 15, 0, 0),
  updatedAt: FORMS_FIXTURE_NOW + 3_600_000,
  publishedVersion: {
    id: "form-primary-cfp-version-1",
    versionNumber: 1,
    name: draftPrimary.name,
    description: draftPrimary.description,
    publishedAt: FORMS_FIXTURE_NOW + 3_600_000,
    retiredAt: null,
    fields: publishedFields,
  },
};

const additionalForm: FormDetail = {
  id: "form-speaker-logistics",
  eventId: FORMS_FIXTURE_EVENT_ID,
  purpose: "additional",
  name: "Accepted speaker logistics",
  description: "Collect travel and accessibility details after acceptance.",
  status: "draft",
  opensAt: null,
  closesAt: null,
  version: 1,
  createdAt: FORMS_FIXTURE_NOW + 7_200_000,
  updatedAt: FORMS_FIXTURE_NOW + 7_200_000,
  fields: [
    {
      id: "field-travel-notes",
      order: 1,
      type: "textarea",
      label: "Travel or accessibility notes",
      semanticKey: null,
      helpText: "Shared only with the event production team.",
      required: false,
      options: [],
      logic: null,
      routing: {},
      version: 1,
    },
  ],
  publishedVersion: null,
};

export const emptyFormsFixture: FormsFixture = Object.freeze({
  id: "empty",
  label: "Empty event",
  description: "No forms have been created.",
  eventId: FORMS_FIXTURE_EVENT_ID,
  eventSlug: FORMS_FIXTURE_EVENT_SLUG,
  forms: [],
});

export const draftFormsFixture: FormsFixture = Object.freeze({
  id: "draft",
  label: "Draft CFP",
  description: "A routed primary CFP before its first publication.",
  eventId: FORMS_FIXTURE_EVENT_ID,
  eventSlug: FORMS_FIXTURE_EVENT_SLUG,
  forms: [draftPrimary],
});

export const publishedFormsFixture: FormsFixture = Object.freeze({
  id: "published",
  label: "Published CFP",
  description: "An open CFP with one immutable published version.",
  eventId: FORMS_FIXTURE_EVENT_ID,
  eventSlug: FORMS_FIXTURE_EVENT_SLUG,
  forms: [publishedPrimary],
});

export const routedFormsFixture: FormsFixture = Object.freeze({
  id: "routed",
  label: "Routed workbench",
  description: "The primary routed CFP plus an additional organizer form.",
  eventId: FORMS_FIXTURE_EVENT_ID,
  eventSlug: FORMS_FIXTURE_EVENT_SLUG,
  forms: [publishedPrimary, additionalForm],
});

/** Bytewise-stable scenario order used by the route preview and focused tests. */
export const formsFixtures: readonly FormsFixture[] = Object.freeze([
  emptyFormsFixture,
  draftFormsFixture,
  publishedFormsFixture,
  routedFormsFixture,
]);
