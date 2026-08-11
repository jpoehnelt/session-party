import type { EvidenceCheck, EvidencePlan } from "./model.ts";

const test = (file: string, title: string): EvidenceCheck => ({ kind: "vitest", file, title });
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
    gap("No deterministic test reloads the public form and proves a partially completed draft is restored."),
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
    gap("No rubric probe proves the reviewer shell omits every organizer/admin capability."),
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
    test(commsService, "wakes only after one durable enqueue and wakes the same durable row again on replay"),
    gap("The communications audience contains accepted speakers only; rejected applicants cannot be selected."),
  ],
  "CFP-15": [
    test(agendaService, "lists only accepted, provisioned proposals in the backlog"),
    test(agendaService, "creates, schedules, moves, replays idempotently, and cancels a talk with evidence"),
  ],
  "CFP-16": [
    test(submitService, "renders the immutable closed snapshot but rejects creation without writes"),
    gap("Accepted primary speakers retain a deliberate closed-CFP edit exception."),
  ],
  "CFP-17": [test(eventsService, "creates, lists, and gets an event for its owner")],
  "CFP-18": [
    test(eventsService, "requires exact API-key scopes and rejects cross-event keys"),
    test(submitService, "denies non-members and cross-event API keys"),
    test(reviewService, "keeps committee comments inside their event boundary"),
  ],

  "ABS-01": [
    test(reviewService, "creates pending or active rounds with validated rubrics, authoritative counts, and replay"),
    gap("Review rounds do not expose configurable open/close dates or a per-round scorecard editor."),
  ],
  "ABS-02": [
    test(reviewService, "allows pending assignments but limits scoring and AI suggestions to active rounds"),
    gap("There is no independent reviewer-pool configuration UI per round."),
  ],
  "ABS-03": [
    test(reviewService, "lets an event reviewer save complete bounded 1–5 scores without requiring assignment or changing status"),
    gap("The scorecard supports bounded numeric scores and a comment, but not dropdown and free-text criterion types."),
  ],
  "ABS-04": [gap("Rubric criteria have no configurable weights or weighted aggregate calculation.")],
  "ABS-05": [gap("Assignments are intentionally optional worklist filters; event reviewers can open every event proposal.")],
  "ABS-06": [gap("No reviewer caps, auto-distribution, or track-filtered bulk assignment operation exists.")],
  "ABS-07": [gap("Review rounds have no anonymization mode.")],
  "ABS-08": [gap("The organizer UI has proposal-level review counts but no per-reviewer progress dashboard.")],
  "ABS-09": [gap("There is no reviewer-outstanding bulk reminder action.")],
  "ABS-10": [
    test("src/features/review/ordering.test.ts", "orders decisions by highest human average, then review count, age, and stable ID, with unscored last"),
  ],
  "ABS-11": [
    test(submitService, "creates trimmed primary and repeatable co-speaker snapshots atomically and replays without duplicates"),
    gap("Co-speakers persist, but organizer results do not expose arbitrary presenter role labels."),
  ],
  "ABS-12": [gap("Reviewers cannot record a conflict of interest or recusal.")],
  "ABS-13": [gap("The institutional archive is JSON; review results have no CSV/XLSX export.")],
  "ABS-14": [
    test(reviewService, "limits AI input, labels the suggestion, and never transitions submission status"),
    test(reviewService, "lets an event reviewer save complete bounded 1–5 scores without requiring assignment or changing status"),
  ],

  "SPK-01": [
    test(portalRoute, "renders a dense speaker directory and readiness matrix from returned state"),
    test(portalRoute, "filters a large speaker directory by search text and operational state"),
  ],
  "SPK-02": [gap("Organizer speaker creation and profile editing are not implemented.")],
  "SPK-03": [gap("There is no speaker CSV importer.")],
  "SPK-04": [
    test(portalRoute, "filters a large speaker directory by search text and operational state"),
    gap("Readiness/provisioning states are filterable but not a general organizer-editable workflow status."),
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
  "SPK-10": [gap("Organizer directory rows do not expose or download speaker-uploaded deliverables.")],
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
  "CNT-04": [gap("Replacing a task-linked asset removes the old object instead of retaining browsable versions.")],
  "CNT-05": [gap("Uploaded files have no cross-role comment thread.")],
  "CNT-06": [
    test(portalRoute, "rejects files over 10 MiB before reading or encoding them"),
    test(portalService, "enforces the decoded 10 MiB transport limit for every asset kind"),
  ],
  "CNT-07": [
    test(portalService, "builds an owner-only speaker chase from missing, overdue, and confirm tasks"),
    gap("The readiness matrix does not show per-file metadata or deliverable-specific filters."),
  ],
  "CNT-08": [gap("There is no bulk reminder action scoped to speakers with outstanding upload tasks.")],
  "CNT-09": [gap("Organizer agenda controls cannot edit a session title and abstract.")],
  "CNT-10": [gap("Organizer controls cannot edit speaker bio and headshot.")],
  "CNT-11": [gap("Audit/domain changes are not exposed as a restorable content version history.")],
  "CNT-12": [test(publicationService, "publishes only confirmed talks and visible speaker names as an immutable snapshot")],
  "CNT-13": [gap("There is no central organizer files library.")],
  "CNT-14": [gap("There is no multi-select ZIP export for latest deliverable versions.")],

  "AIA-01": [
    test(agendaService, "covers every required deterministic scenario"),
    gap("No deterministic browser probe currently asserts the multi-day builder layout and day navigation."),
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
  "AIA-08": [gap("There is no automatic or assisted placement action.")],

  "EMB-01": [test(publicProgram, "renders a populated, navigable sessions list from canonical public DTOs")],
  "EMB-02": [test(publicProgram, "searches sessions by title or speaker and applies facets")],
  "EMB-03": [test(publicProgram, "searches sessions by title or speaker and applies facets")],
  "EMB-04": [
    test(publicProgram, "orders the directory by surname"),
    test(publicProgram, "renders a populated, navigable sessions list from canonical public DTOs"),
  ],
  "EMB-05": [
    test(publicProgram, "orders the directory by surname"),
    gap("No deterministic interaction probe opens a speaker-list entry and asserts the complete detail panel."),
  ],
  "EMB-06": [test(publishedSchedule, "renders the public day view from the canonical published DTO")],
  "EMB-07": [
    test(publishedSchedule, "renders the public day view from the canonical published DTO"),
    gap("No deterministic browser probe clicks between event days and verifies the new set of sessions."),
  ],
  "EMB-08": [gap("No deterministic browser probe opens and closes an agenda session detail while checking every field.")],
  "EMB-09": [
    test(publicProgram, "renders itinerary controls and a calendar export affordance"),
    gap("The current static render test does not assert every itinerary card field or day interaction."),
  ],
  "EMB-10": [
    test(publicProgram, "renders itinerary controls and a calendar export affordance"),
    gap("No deterministic interaction probe selects sessions and verifies the exact personal-only set."),
  ],
  "EMB-11": [
    test(publicProgram, "renders itinerary controls and a calendar export affordance"),
    gap("Calendar export is asserted, but localStorage persistence across a reload is not."),
  ],
  "EMB-12": [
    test(publicProgram, "orders the directory by surname"),
    gap("No deterministic rendered-gallery probe covers missing-photo fallback and search interaction together."),
  ],
  "EMB-13": [gap("The gallery detail lacks a tested long-biography expansion flow.")],
  "EMB-14": [
    test(publicProgram, "renders a live-data widget builder for all five public surfaces"),
    test(publicProgram, "maps conventional public routes to discoverable surfaces"),
  ],
  "EMB-15": [
    test(publicProgram, "renders a live-data widget builder for all five public surfaces"),
    test(embedDesign, "round-trips a supported aesthetic and normalized brand color"),
    gap("Embed definitions are generated ephemerally and cannot be saved/listed for later retrieval."),
  ],
  "EMB-16": [
    test(publicationService, "publishes only confirmed talks and visible speaker names as an immutable snapshot"),
    test(publicProgram, "renders a populated, navigable sessions list from canonical public DTOs"),
    gap("No cross-surface interaction probe compares one session field-for-field against the organizer record."),
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
