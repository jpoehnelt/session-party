import type { EvidenceCheck, EvidencePlan } from "./model.ts";

const test = (file: string, title: string): EvidenceCheck => ({ kind: "vitest", file, title });
const browser = (file: string, title: string): EvidenceCheck => ({ kind: "vitest-browser", file, title });
const gap = (reason: string): EvidenceCheck => ({ kind: "gap", reason });
const manual = (instructions: string): EvidenceCheck => ({ kind: "manual", instructions });

const formsService = "src/features/forms/forms.test.ts";
const submitService = "src/features/submit/submit.test.ts";
const submitRoute = "src/features/submit/routes/submit.test.tsx";
const reviewService = "src/features/review/review.test.ts";
const reviewRoute = "src/features/review/routes/review-workbench.test.tsx";
const eventsService = "src/features/events/events.test.ts";
const portalService = "src/features/portal/portal.test.ts";
const portalRoute = "src/features/portal/routes/routes.test.tsx";
const commsService = "src/features/comms/comms.test.ts";
const commsRoute = "src/features/comms/routes/comms.test.tsx";
const agendaService = "src/features/agenda/agenda.test.ts";
const publicationService = "src/features/publication/publication.test.ts";
const publicProgram = "src/features/publication/components/PublicProgram.test.tsx";
const publishedSchedule = "src/features/publication/components/PublishedSchedule.test.tsx";
const embedDesign = "src/features/publication/embed-design.test.ts";
const submitDraftBrowser = "src/features/submit/routes/submit-draft.browser.tsx";
const portalContentBrowser = "src/features/portal/routes/organizer-content.browser.tsx";
const agendaBoardBrowser = "src/features/agenda/components/agenda-board.browser.tsx";
const publicProgramBrowser = "src/features/publication/components/public-program.browser.tsx";

/**
 * Every rubric item is explicit. A passing test is executable evidence; a gap is
 * a failed capability sub-check but is excluded from deterministic evidence
 * coverage; and a manual check remains pending/cannot_judge. Mixed test/gap
 * evidence derives a partial capability verdict. Nothing here silently inherits
 * the old source-audit score.
 */
export const evidencePlan = {
  "CFP-01": [
    test(formsService, "validates publish intent and preserves every conditional rule update"),
    test(submitRoute, "uses the bare public route and renders the immutable published form"),
    test(submitRoute, "surfaces the CFP-only validation response from the public producer"),
  ],
  "CFP-02": [
    test(formsService, "validates publish intent and preserves every conditional rule update"),
    test(submitRoute, "hides checkbox-dependent fields until the box is actually checked"),
  ],
  "CFP-03": [
    test(submitRoute, "uses the bare public route and renders the immutable published form"),
    test(submitRoute, "names drafts by immutable form version and renders the deadline"),
  ],
  "CFP-04": [
    test(submitRoute, "renders closed published content without an active submit control"),
    test(submitService, "renders the immutable closed snapshot but rejects creation without writes"),
  ],
  "CFP-05": [
    test(submitRoute, "exposes a durable success state with the real submission reference"),
    test(submitRoute, "uses a dedicated speaker route with editable and decided proposal states"),
    test(submitService, "scopes a speaker dashboard by signed-in email and edits the canonical abstract while the CFP is open"),
  ],
  "CFP-06": [
    test(submitService, "creates a real routed submission, immutable answers, primary speaker, and evidence"),
    test(reviewRoute, "resolves the slug before loading and renders authoritative review data"),
  ],
  "CFP-07": [
    test(submitRoute, "names drafts by immutable form version and renders the deadline"),
    browser(submitDraftBrowser, "saves a title-only draft and restores it after a real remount"),
  ],
  "CFP-08": [
    manual(
      "Submit a proposal using an inbox you can inspect and verify that a confirmation email arrives naming the event and submitted talk title.",
    ),
  ],
  "CFP-09": [
    test(submitService, "scopes a speaker dashboard by signed-in email and edits the canonical abstract while the CFP is open"),
  ],
  "CFP-10": [
    test(eventsService, "adds an existing user by normalized email, lists it, and records replayable evidence"),
    test(reviewRoute, "renders scoring and the private committee conversation for an assigned event reviewer"),
  ],
  "CFP-11": [
    test(reviewService, "lets an event reviewer save complete bounded 1–5 scores without requiring assignment or changing status"),
    test(reviewRoute, "renders scoring and the private committee conversation for an assigned event reviewer"),
  ],
  "CFP-12": [
    test(reviewService, "atomically resolves a same-version acceptance and rejection race"),
    test(reviewService, "records a versioned rejection, publishes speaker-visible evidence, and replays idempotently"),
  ],
  "CFP-13": [
    test(reviewService, "records a versioned rejection, publishes speaker-visible evidence, and replays idempotently"),
    test(submitRoute, "uses a dedicated speaker route with editable and decided proposal states"),
  ],
  "CFP-14": [
    test(commsService, "includes rejected applicants in bulk communications and queues their outcome email"),
    gap("Acceptance notifications and organizer-side dispatch confirmation are not implemented and proven together."),
  ],
  "CFP-15": [
    test(agendaService, "lists only accepted, provisioned proposals in the backlog"),
    test(agendaService, "creates, schedules, moves, replays idempotently, and cancels a talk with evidence"),
  ],
  "CFP-16": [
    gap("Accepted primary speakers intentionally remain editable after CFP close under the authoritative product contract."),
  ],
  "CFP-17": [test(eventsService, "creates, lists, and gets an event for its owner")],
  "CFP-18": [
    test(eventsService, "requires exact API-key scopes and rejects cross-event keys"),
    test(submitService, "denies non-members and cross-event API keys"),
    test(reviewService, "keeps committee comments inside their event boundary"),
  ],

  "ABS-01": [
    test(reviewService, "creates pending or active rounds with validated rubrics, authoritative counts, and replay"),
  ],
  "ABS-02": [
    test(reviewService, "allows pending assignments but limits scoring and AI suggestions to active rounds"),
    test(reviewService, "bulk-balances an independent round pool and reports per-reviewer completion"),
  ],
  "ABS-03": [
    test(reviewService, "calculates typed scorecards with configured numeric and dropdown weights"),
  ],
  "ABS-04": [test(reviewService, "calculates typed scorecards with configured numeric and dropdown weights")],
  "ABS-05": [
    test(reviewService, "returns the committee queue to reviewers and keeps assignments as an optional worklist filter"),
    gap("Committee reviewers can open unassigned proposals, so the rubric's exact-assignment isolation is not implemented."),
  ],
  "ABS-06": [test(reviewService, "bulk-balances an independent round pool and reports per-reviewer completion")],
  "ABS-07": [test(reviewService, "hides presenter identities from assigned reviewers in blind rounds")],
  "ABS-08": [test(reviewService, "bulk-balances an independent round pool and reports per-reviewer completion")],
  "ABS-09": [test(reviewService, "queues idempotent reminders only for reviewers with outstanding assignments")],
  "ABS-10": [
    test("src/features/review/ordering.test.ts", "orders decisions by highest human average, then review count, age, and stable ID, with unscored last"),
  ],
  "ABS-11": [
    test(submitService, "creates trimmed primary and repeatable co-speaker snapshots atomically and replays without duplicates"),
    gap("Co-presenter role labels are not persisted or shown in organizer review and results views."),
  ],
  "ABS-12": [
    test(reviewService, "derives organizer progress from active assignments and preserves recusal history through reassignment"),
    test(reviewRoute, "renders scoring and the private committee conversation for an assigned event reviewer"),
  ],
  "ABS-13": [test(reviewService, "exports normalized review results with criterion-level responses")],
  "ABS-14": [
    test(reviewService, "limits AI input, labels the suggestion, and never transitions submission status"),
    test(reviewService, "lets an event reviewer save complete bounded 1–5 scores without requiring assignment or changing status"),
  ],

  "SPK-01": [
    test(portalRoute, "renders a dense speaker directory and readiness matrix from returned state"),
    test(portalRoute, "filters a large speaker directory by search text and operational state"),
  ],
  "SPK-02": [test(portalService, "adds, edits, filters, and imports managed speaker workflow records")],
  "SPK-03": [test(portalService, "adds, edits, filters, and imports managed speaker workflow records")],
  "SPK-04": [
    test(portalService, "adds, edits, filters, and imports managed speaker workflow records"),
    test(portalRoute, "renders direct speaker creation, CSV import, workflow editing, messaging, and headshot controls"),
  ],
  "SPK-05": [
    test(portalService, "performs organizer task and resource CRUD with optimistic versions and iframe policy"),
    test(portalRoute, "renders complete create, edit, and versioned delete controls for tasks and resources"),
  ],
  "SPK-06": [
    test(commsService, "snapshots an absolute origin-safe portal URL from MailQueue and the immutable publication slug"),
    test(commsService, "wakes only after one durable enqueue and wakes the same durable row again on replay"),
  ],
  "SPK-07": [test(portalService, "requires organizer membership and the exact provisioned speaker browser session")],
  "SPK-08": [
    test(portalService, "stores a policy-validated R2 upload and links headshot and task completion"),
    test(portalService, "publishes only visible accepted provisioned public speaker fields"),
    test(portalRoute, "sends profile fields to the slug endpoint without trusting a body event id"),
  ],
  "SPK-09": [
    test(portalService, "persists completion and transitions readiness after provisioning"),
    test(portalRoute, "persists task toggles and real uploads against the speaker slug endpoint"),
  ],
  "SPK-10": [
    test(portalService, "retains content history, supports cross-role comments, downloads, restores, and organizer profile edits"),
    test(portalRoute, "renders content metadata, selection controls, history, comments, and a ZIP affordance"),
  ],
  "SPK-11": [
    test(portalRoute, "renders profile editing, accepted submission, one task checklist, files, and resources"),
    test(portalRoute, "renders a dense speaker directory and readiness matrix from returned state"),
  ],
  "SPK-12": [
    test(portalService, "builds an owner-only speaker chase from missing, overdue, and confirm tasks"),
    test(portalRoute, "renders a dense speaker directory and readiness matrix from returned state"),
  ],
  "SPK-13": [
    test(commsService, "wakes only after one durable enqueue and wakes the same durable row again on replay"),
    test(commsRoute, "treats recipient order as one confirmation and campaign changes as new confirmation identities"),
  ],
  "SPK-14": [test(commsService, "accepts the frozen dotted merge contract and rejects unknown or malformed variables")],
  "SPK-15": [test(submitService, "stores immutable answers against the exact existing speaker with actor evidence")],
  "SPK-16": [
    manual(
      "Assign an incomplete task due within 24–48 hours to a speaker whose inbox you control, wait through the reminder cycle, and verify the reminder names the task and due date.",
    ),
  ],

  "CNT-01": [
    test(portalService, "performs organizer task and resource CRUD with optimistic versions and iframe policy"),
    test(portalRoute, "renders complete create, edit, and versioned delete controls for tasks and resources"),
  ],
  "CNT-02": [
    test(portalService, "stores a policy-validated R2 upload and links headshot and task completion"),
    test(portalRoute, "persists task toggles and real uploads against the speaker slug endpoint"),
  ],
  "CNT-03": [test(portalService, "requires organizer membership and the exact provisioned speaker browser session")],
  "CNT-04": [test(portalService, "retains content history, supports cross-role comments, downloads, restores, and organizer profile edits")],
  "CNT-05": [test(portalService, "retains content history, supports cross-role comments, downloads, restores, and organizer profile edits")],
  "CNT-06": [
    test(portalRoute, "applies purpose-specific upload limits before reading or encoding files"),
  ],
  "CNT-07": [
    test(portalRoute, "renders content metadata, selection controls, history, comments, and a ZIP affordance"),
  ],
  "CNT-08": [
    test(portalService, "queues messages for accepted and directly managed portal speakers"),
    gap("No focused organizer UI assertion proves bulk reminder selection and a visible send confirmation."),
  ],
  "CNT-09": [test(agendaService, "edits the organizer session title and abstract with versioned evidence")],
  "CNT-10": [test(portalService, "retains content history, supports cross-role comments, downloads, restores, and organizer profile edits")],
  "CNT-11": [test(portalService, "retains content history, supports cross-role comments, downloads, restores, and organizer profile edits")],
  "CNT-12": [test(publicationService, "publishes only confirmed talks and visible speaker names as an immutable snapshot")],
  "CNT-13": [
    browser(portalContentBrowser, "shows session and version metadata and confirms a latest-only multi-file ZIP"),
  ],
  "CNT-14": [
    browser(portalContentBrowser, "shows session and version metadata and confirms a latest-only multi-file ZIP"),
    test(portalRoute, "builds standards-compliant stored ZIP archives"),
  ],

  "AIA-01": [
    test(agendaService, "covers every required deterministic scenario"),
    browser(agendaBoardBrowser, "renders room lanes and switches the active day to a different session set"),
  ],
  "AIA-02": [test(agendaService, "creates and updates tracks and rooms idempotently with stable ordering")],
  "AIA-03": [test(agendaService, "creates, schedules, moves, replays idempotently, and cancels a talk with evidence")],
  "AIA-04": [test(agendaService, "saves room and speaker overlaps as named non-blocking agenda warnings")],
  "AIA-05": [test(agendaService, "saves room and speaker overlaps as named non-blocking agenda warnings")],
  "AIA-06": [
    test(agendaService, "creates, schedules, moves, replays idempotently, and cancels a talk with evidence"),
    test(agendaService, "saves TBD placement through the versioned move operation and defers completeness to publication"),
  ],
  "AIA-07": [test(agendaService, "successfully publishes an unchanged speaker projection as an immutable revision")],
  "AIA-08": [test(agendaService, "auto-places an unplaced talk into the first conflict-free event slot")],

  "EMB-01": [browser(publicProgramBrowser, "proves complete session cards, title and speaker search, facets, and description expansion")],
  "EMB-02": [browser(publicProgramBrowser, "proves complete session cards, title and speaker search, facets, and description expansion")],
  "EMB-03": [browser(publicProgramBrowser, "proves complete session cards, title and speaker search, facets, and description expansion")],
  "EMB-04": [
    test(publicProgram, "orders the directory by surname"),
    test(publicProgram, "renders a populated, navigable sessions list from canonical public DTOs"),
  ],
  "EMB-05": [browser(publicProgramBrowser, "opens and closes a complete searchable speaker list profile")],
  "EMB-06": [test(publishedSchedule, "renders the public day view from the canonical published DTO")],
  "EMB-07": [
    browser(publicProgramBrowser, "switches agenda days and restores the agenda after closing complete session detail"),
  ],
  "EMB-08": [browser(publicProgramBrowser, "switches agenda days and restores the agenda after closing complete session detail")],
  "EMB-09": [
    browser(publicProgramBrowser, "renders a complete chronological itinerary and persists an exact personal schedule across remount"),
  ],
  "EMB-10": [browser(publicProgramBrowser, "renders a complete chronological itinerary and persists an exact personal schedule across remount")],
  "EMB-11": [
    browser(publicProgramBrowser, "renders a complete chronological itinerary and persists an exact personal schedule across remount"),
  ],
  "EMB-12": [
    test(publicProgram, "orders the directory by surname"),
    browser(publicProgramBrowser, "renders complete gallery cards, fallbacks, and speaker detail"),
  ],
  "EMB-13": [browser(publicProgramBrowser, "renders complete gallery cards, fallbacks, and speaker detail")],
  "EMB-14": [
    test(publicProgram, "presents two widgets with presets and separates feeds from embed code"),
    test(publicProgram, "maps conventional public routes to discoverable surfaces"),
  ],
  "EMB-15": [
    test(publicProgram, "presents two widgets with presets and separates feeds from embed code"),
    test(embedDesign, "round-trips a supported aesthetic and normalized brand color"),
    test(publicProgram, "generates stable, lazy iframe code from persisted definitions"),
    test(publicationService, "persists versioned embeds and makes disabling the stable URL real"),
  ],
  "EMB-16": [
    test(publicationService, "publishes only confirmed talks and visible speaker names as an immutable snapshot"),
    test(publicProgram, "keeps session and speaker identity consistent across public surfaces and organizer source"),
    gap("No focused round-trip proves title, date/time, room, and track across widgets or propagates an organizer edit without republishing."),
  ],

  "CRM-01": [gap("No organization-level cross-event contact directory exists.")],
  "CRM-02": [gap("No organization-level multi-criteria contact filters exist.")],
  "CRM-03": [gap("No organization-level contact profile with cross-event history exists.")],
  "CRM-04": [gap("No organization-level contact custom-field or tag system exists.")],
  "CRM-05": [gap("No organization-level contact CSV importer exists.")],
  "CRM-06": [gap("No organization-level duplicate-contact merge workflow exists.")],
  "CRM-07": [gap("No organization-level speaker sourcing pipeline exists.")],
  "CRM-08": [gap("No pipeline transition history exists.")],
  "CRM-09": [gap("No reusable organization-level contact segment exists.")],
  "CRM-10": [gap("No organization-level contact-to-event handoff exists.")],
  "CRM-11": [gap("No organization-level bulk contact email composer exists.")],
  "CRM-12": [gap("No organization-level CRM metrics dashboard exists.")],
} as const satisfies EvidencePlan;
