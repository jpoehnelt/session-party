import type { EnqueueCommunicationInput } from "../src/features/comms/schema";
import { resolveLocalRuntime } from "./local-runtime";

const { origin } = resolveLocalRuntime();
const apiBase = `${origin}/api/v1`;
const eventId = "demo-event";
const eventSlug = "ai-engineer-sandbox";
const ownerSession = "demo-owner-session";
const reviewerSession = "demo-reviewer-session";
const recusedReviewerSession = "demo-reviewer-recused-session";
const speakerSession = "demo-speaker-session";
const DAY_MS = 86_400_000;

const fixtureSpeakerNames = [
  "Priya Raman", "Alex Morgan", "Avery Chen", "Blair Okafor", "Cameron Singh",
  "Casey Rivera", "Dakota Kim", "Drew Williams", "Elliot Hassan", "Emerson Silva",
  "Finley Jones", "Harper Brown", "Hayden Garcia", "Jamie Patel", "Jordan Lee",
  "Kai Thompson", "Kendall Martin", "Lane Davis", "Logan Wilson", "Marley Taylor",
  "Morgan Clark", "Nico Anderson", "Parker Lewis", "Quinn Robinson", "Reese Walker",
  "Remy Martinez", "Robin Moore", "Rowan Hall", "Sasha Nguyen", "Taylor Jackson",
] as const;

const fixtureSpeakers = fixtureSpeakerNames.map((name, index) => {
  const ordinal = String(index + 1).padStart(2, "0");
  return {
    name,
    email: index === 0 ? "sbek-speaker@example.com" : `speaker${ordinal}@sessionparty.local`,
    session: index === 0 ? speakerSession : `demo-speaker-${ordinal}-session`,
  };
});

interface FormField {
  readonly id: string;
  readonly label: string;
}

interface FormDetail {
  readonly id: string;
  readonly version: number;
  readonly publishedVersion: null | {
    readonly id: string;
    readonly fields: readonly FormField[];
  };
}

interface SubmissionOutput {
  readonly submissionId: string;
  readonly status: "submitted";
}

interface Workbench {
  readonly selected: null | {
    readonly id: string;
    readonly version: number;
    readonly speakers: readonly { readonly id: string; readonly isPrimary: boolean }[];
  };
}

interface AssignmentOutput {
  readonly assignment: {
    readonly id: string;
    readonly version: number;
  };
}

interface AcceptanceOutput {
  readonly provisioningId: string;
  readonly primarySpeakerId: string;
  readonly submissionVersion: number;
}

interface ClaimOutput {
  readonly speakerId: string;
  readonly acceptanceEventId: string;
  readonly provisioningId: string;
  readonly speakerVersion: number;
  readonly provisioningVersion: number;
  readonly provisioningStatus: "claimed" | "provisioned";
}

interface PortalTask {
  readonly id: string;
  readonly version: number;
}

interface SpeakerProfile {
  readonly id: string;
  readonly version: number;
}

interface UploadOutput {
  readonly task: null | { readonly completionVersion: number };
}

interface AgendaMutation {
  readonly talk: { readonly id: string; readonly version: number };
}

interface AgendaSnapshot {
  readonly workspaceVersion: number;
  readonly eventVersion: number;
  readonly publication: { readonly revision: number };
}

interface CommunicationTemplate {
  readonly id: string;
  readonly version: number;
}

interface DeliveryHistory {
  readonly localCaptureCount: number;
  readonly deliveries: readonly { readonly status: string }[];
}

interface ImportRun {
  readonly runId: string;
  readonly counts: {
    readonly total: number;
    readonly created: number;
    readonly updated: number;
    readonly unchanged: number;
    readonly failed: number;
  };
}

const encode = (value: string): string => encodeURIComponent(value);

async function request<T>(
  path: string,
  options: {
    readonly method?: string;
    readonly session?: string;
    readonly body?: unknown;
    readonly headers?: Readonly<Record<string, string>>;
    readonly expectedStatus?: number;
  } = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.session) headers.set("Cookie", `sp_session=${encodeURIComponent(options.session)}`);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`${apiBase}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const expected = options.expectedStatus ?? 200;
  const payload = await response.json().catch(() => undefined) as unknown;
  if (response.status !== expected) {
    throw new Error(`${options.method ?? "GET"} ${path} returned ${response.status}, expected ${expected}: ${JSON.stringify(payload)}`);
  }
  return payload as T;
}

function primary(fields: readonly FormField[], label: string): string {
  const field = fields.find((candidate) => candidate.label === label);
  if (!field) throw new Error(`Published form is missing field: ${label}`);
  return field.id;
}

const draftFields = [
  {
    id: "demo-field-title",
    type: "text",
    label: "Session title",
    semanticKey: "submissionTitle",
    helpText: "Keep it specific and under 90 characters.",
    required: true,
    options: [],
    logic: null,
    routing: {},
  },
  {
    id: "demo-field-abstract",
    type: "textarea",
    label: "Session abstract",
    semanticKey: "submissionAbstract",
    helpText: "What will attendees learn and apply?",
    required: true,
    options: [],
    logic: null,
    routing: {},
  },
  {
    id: "demo-field-speaker-name",
    type: "text",
    label: "Speaker name",
    semanticKey: "speakerName",
    helpText: null,
    required: true,
    options: [],
    logic: null,
    routing: {},
  },
  {
    id: "demo-field-speaker-email",
    type: "email",
    label: "Speaker email",
    semanticKey: "speakerEmail",
    helpText: "Used for proposal updates and onboarding.",
    required: true,
    options: [],
    logic: null,
    routing: {},
  },
  {
    id: "demo-field-track",
    type: "radio",
    label: "Best-fit track",
    semanticKey: null,
    helpText: "Choose the audience that benefits most.",
    required: true,
    options: ["AI systems", "Developer tools", "Applied research"],
    logic: null,
    routing: {
      "AI systems": "ai-systems",
      "Developer tools": "developer-tools",
      "Applied research": "applied-research",
    },
  },
  {
    id: "demo-field-details",
    type: "textarea",
    label: "Workshop exercise plan",
    semanticKey: null,
    helpText: "Shown only for developer tools proposals.",
    required: true,
    options: [],
    logic: {
      action: "show",
      mode: "all",
      conditions: [{ fieldId: "demo-field-track", op: "eq", value: "Developer tools" }],
    },
    routing: {},
  },
] as const;

console.log(`Hydrating ${origin} as the deterministic demo environment...`);

await request(`/events/${eventId}`, { session: ownerSession });

const cfp = await request<FormDetail>(`/events/${eventId}/forms`, {
  method: "POST",
  session: ownerSession,
  expectedStatus: 201,
  headers: { "Idempotency-Key": "demo-create-primary-cfp-v1" },
  body: {
    purpose: "primary-cfp",
    name: "AI Engineer Sandbox — Call for proposals",
    description: "Share a practical session for builders shipping reliable AI systems.",
    opensAt: null,
    closesAt: null,
    fields: draftFields,
  },
});

const publishedCfp = await request<FormDetail>(`/events/${eventId}/forms/${encode(cfp.id)}/publish`, {
  method: "POST",
  session: ownerSession,
  expectedStatus: 200,
  headers: {
    "Idempotency-Key": "demo-publish-primary-cfp-v1",
    "If-Match": String(cfp.version),
  },
});
if (!publishedCfp.publishedVersion) throw new Error("Primary CFP did not publish");
const cfpFields = publishedCfp.publishedVersion.fields;

const taskForm = await request<FormDetail>(`/events/${eventId}/forms`, {
  method: "POST",
  session: ownerSession,
  expectedStatus: 201,
  headers: { "Idempotency-Key": "demo-create-logistics-form-v1" },
  body: {
    purpose: "additional",
    name: "Accepted speaker logistics",
    description: "Travel, accessibility, and dietary details for event production.",
    opensAt: null,
    closesAt: null,
    fields: [
      {
        id: "demo-logistics-notes",
        type: "textarea",
        label: "Travel or accessibility notes",
        semanticKey: null,
        helpText: "Shared only with the production team.",
        required: false,
        options: [],
        logic: null,
        routing: {},
      },
      {
        id: "demo-logistics-diet",
        type: "radio",
        label: "Dietary preference",
        semanticKey: null,
        helpText: null,
        required: true,
        options: ["No restriction", "Vegetarian", "Vegan"],
        logic: null,
        routing: {},
      },
    ],
  },
});
const publishedTaskForm = await request<FormDetail>(`/events/${eventId}/forms/${encode(taskForm.id)}/publish`, {
  method: "POST",
  session: ownerSession,
  headers: {
    "Idempotency-Key": "demo-publish-logistics-form-v1",
    "If-Match": String(taskForm.version),
  },
});
if (!publishedTaskForm.publishedVersion) throw new Error("Task form did not publish");

const cfpFieldIds = {
  title: primary(cfpFields, "Session title"),
  abstract: primary(cfpFields, "Session abstract"),
  speakerName: primary(cfpFields, "Speaker name"),
  speakerEmail: primary(cfpFields, "Speaker email"),
  track: primary(cfpFields, "Best-fit track"),
  details: primary(cfpFields, "Workshop exercise plan"),
};
const trackOptions = ["AI systems", "Developer tools", "Applied research"] as const;
const acceptedSubmissions: SubmissionOutput[] = [];
const submittedBacklog: SubmissionOutput[] = [];

for (const [speakerIndex, speaker] of fixtureSpeakers.entries()) {
  for (let proposalIndex = 0; proposalIndex < 2; proposalIndex += 1) {
    const track = trackOptions[(speakerIndex + proposalIndex) % trackOptions.length]!;
    const isWalkthrough = speakerIndex === 0 && proposalIndex === 0;
    const answers: Array<{ readonly fieldId: string; readonly value: string }> = [
      {
        fieldId: cfpFieldIds.title,
        value: isWalkthrough
          ? "Reliable agents: from prototype to production"
          : `${speaker.name}: ${proposalIndex === 0 ? "production patterns" : "field notes"} for ${track.toLowerCase()}`,
      },
      {
        fieldId: cfpFieldIds.abstract,
        value: isWalkthrough
          ? "A hands-on guide to durable state, observable tool use, and failure-safe agent workflows."
          : `A practical, evidence-backed session from ${speaker.name} covering repeatable ${track.toLowerCase()} techniques, tradeoffs, and failure recovery.`,
      },
      { fieldId: cfpFieldIds.speakerName, value: speaker.name },
      { fieldId: cfpFieldIds.speakerEmail, value: speaker.email },
      { fieldId: cfpFieldIds.track, value: track },
    ];
    if (track === "Developer tools") {
      answers.push({
        fieldId: cfpFieldIds.details,
        value: isWalkthrough
          ? "Attendees repair a deliberately fragile multi-step agent and inspect its recovery trace."
          : "Attendees diagnose a broken workflow, apply one focused repair, and compare the resulting trace.",
      });
    }
    const created = await request<SubmissionOutput>(
      `/public/events/${eventSlug}/forms/${encode(publishedCfp.id)}/submissions`,
      {
        method: "POST",
        expectedStatus: 201,
        headers: { "Idempotency-Key": `demo-proposal-${speakerIndex + 1}-${proposalIndex + 1}-v1` },
        body: { answers },
      },
    );
    (proposalIndex === 0 ? acceptedSubmissions : submittedBacklog).push(created);
  }
}

const submission = acceptedSubmissions[0];
if (!submission || acceptedSubmissions.length !== 30 || submittedBacklog.length !== 30) {
  throw new Error("Deterministic CFP scale did not create 30 accepted candidates and 30 backlog submissions");
}

const recusalSubmission = submittedBacklog[0];
if (!recusalSubmission) throw new Error("Deterministic CFP scale did not create a recusal fixture submission");
const recusalAssignment = await request<AssignmentOutput>(`/events/${eventId}/review/assignments`, {
  method: "POST",
  session: ownerSession,
  expectedStatus: 201,
  headers: { "x-request-id": "demo-review-recusal-assignment-v1" },
  body: {
    roundId: "demo-review-round-active",
    submissionId: recusalSubmission.submissionId,
    reviewerUserId: "demo-reviewer-recused",
    expectedVersion: 0,
  },
});
await request(`/events/${eventId}/review/assignments/${encode(recusalAssignment.assignment.id)}/recusal`, {
  method: "POST",
  session: recusedReviewerSession,
  headers: {
    "idempotency-key": "demo-review-recusal-v1",
    "x-request-id": "demo-review-recusal-request-v1",
  },
  body: {
    expectedVersion: recusalAssignment.assignment.version,
    reason: "Topic creates a prior-work conflict for this reviewer.",
  },
});

let workbench = await request<Workbench>(
  `/events/${eventId}/review?selectedSubmissionId=${encode(submission.submissionId)}`,
  { session: ownerSession },
);

await request(`/events/${eventId}/review/assignments`, {
  method: "POST",
  session: ownerSession,
  expectedStatus: 201,
  headers: { "x-request-id": "demo-review-assignment-v1" },
  body: {
    roundId: "demo-review-round-active",
    submissionId: submission.submissionId,
    reviewerUserId: "demo-reviewer",
    expectedVersion: 0,
  },
});

await request(`/events/${eventId}/review/rounds/demo-review-round-active/submissions/${encode(submission.submissionId)}/score`, {
  method: "PUT",
  session: reviewerSession,
  headers: { "x-request-id": "demo-review-score-v1" },
  body: {
    expectedVersion: 0,
    scores: [
      { criterionKey: "relevance", score: 5 },
      { criterionKey: "specificity", score: 5 },
      { criterionKey: "delivery", score: 4 },
    ],
    comment: "Specific, useful, and grounded in a credible live exercise.",
  },
});

workbench = await request<Workbench>(
  `/events/${eventId}/review?selectedSubmissionId=${encode(submission.submissionId)}`,
  { session: ownerSession },
);
if (!workbench.selected) throw new Error("Submission disappeared after review");
const accepted = await request<AcceptanceOutput>(
  `/events/${eventId}/review/submissions/${encode(submission.submissionId)}/acceptance`,
  {
    method: "POST",
    session: ownerSession,
    headers: {
      "idempotency-key": "demo-accept-primary-proposal-v1",
      "x-request-id": "demo-accept-request-v1",
    },
    body: { expectedVersion: workbench.selected.version },
  },
);

const claimed = await request<ClaimOutput>(`/events/${eventId}/portal/claim`, {
  method: "POST",
  session: speakerSession,
  body: { idempotencyKey: "demo-claim-primary-speaker-v1" },
});
if (claimed.speakerId !== accepted.primarySpeakerId || claimed.provisioningId !== accepted.provisioningId) {
  throw new Error("Speaker claim did not resolve the accepted primary speaker");
}
await request(`/events/${eventId}/portal/speakers/${encode(accepted.primarySpeakerId)}/provision`, {
  method: "POST",
  session: ownerSession,
  body: { provisioningId: claimed.provisioningId, expectedVersion: claimed.provisioningVersion },
});

const acceptedPeople: Array<{ readonly submission: SubmissionOutput; readonly acceptance: AcceptanceOutput }> = [
  { submission, acceptance: accepted },
];
for (let index = 1; index < acceptedSubmissions.length; index += 1) {
  const candidate = acceptedSubmissions[index]!;
  const speaker = fixtureSpeakers[index]!;
  const acceptance = await request<AcceptanceOutput>(
    `/events/${eventId}/review/submissions/${encode(candidate.submissionId)}/acceptance`,
    {
      method: "POST",
      session: ownerSession,
      headers: {
        "idempotency-key": `demo-accept-proposal-${index + 1}-v1`,
        "x-request-id": `demo-accept-request-${index + 1}-v1`,
      },
      body: { expectedVersion: 1 },
    },
  );
  const claim = await request<ClaimOutput>(`/events/${eventId}/portal/claim`, {
    method: "POST",
    session: speaker.session,
    body: { idempotencyKey: `demo-claim-speaker-${index + 1}-v1` },
  });
  if (claim.speakerId !== acceptance.primarySpeakerId) {
    throw new Error(`Speaker ${index + 1} claimed the wrong accepted profile`);
  }
  await request(`/events/${eventId}/portal/speakers/${encode(acceptance.primarySpeakerId)}/provision`, {
    method: "POST",
    session: ownerSession,
    body: { provisioningId: claim.provisioningId, expectedVersion: claim.provisioningVersion },
  });
  acceptedPeople.push({ submission: candidate, acceptance });
}

const tasks = await Promise.all([
  ["Complete your speaker profile", "Add a biography and public link.", "profile", null, 1],
  ["Upload a headshot", "PNG, JPEG, or WebP.", "upload", null, 2],
  ["Upload session materials", "Add slides and supporting notes.", "upload", null, 3],
  ["Submit logistics", "Complete the linked travel and accessibility form.", "form", publishedTaskForm.id, 4],
  ["Confirm participation", "Confirm that your session details are correct.", "confirm", null, 5],
].map(async ([name, description, kind, formId, order]) =>
  request<PortalTask>(`/events/${eventId}/portal/tasks`, {
    method: "POST",
    session: ownerSession,
    expectedStatus: 201,
    body: { name, description, kind, formId, dueAt: null, order },
  })
));

await request(`/events/${eventId}/portal/resources`, {
  method: "POST",
  session: ownerSession,
  expectedStatus: 201,
  body: {
    slug: "speaker-production-guide",
    title: "Speaker production guide",
    body: "Use this guide for stage setup, slide ratios, arrival timing, and accessibility support.",
    embedUrl: "https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ",
    audience: "speakers",
    order: 1,
  },
});

const profile = await request<SpeakerProfile>(`/events/${eventId}/portal/profile`, {
  method: "PUT",
  session: speakerSession,
  body: {
    expectedVersion: claimed.speakerVersion,
    idempotencyKey: "demo-speaker-profile-v1",
    displayName: "Priya Raman",
    title: "Principal AI Engineer",
    company: "Fieldcraft Labs",
    bio: "Priya builds reliable agent systems and teaches teams how to operate them in production.",
    links: [{ label: "Website", url: "https://example.com/priya-raman" }],
  },
});

await request(`/events/${eventId}/portal/tasks/${encode(tasks[0]!.id)}/completion`, {
  method: "PUT",
  session: speakerSession,
  body: { completed: true, data: { source: "demo-hydrator" }, idempotencyKey: "demo-complete-profile-v1" },
});

await request(`/events/${eventId}/portal/assets`, {
  method: "POST",
  session: speakerSession,
  expectedStatus: 201,
  body: {
    taskId: tasks[1]!.id,
    purpose: "headshot",
    filename: "priya-raman.png",
    contentType: "image/png",
    contentBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    expectedVersion: profile.version,
    idempotencyKey: "demo-headshot-upload-v1",
  },
});

let materialsVersion = 0;
for (const [purpose, filename, key, taskId] of [
  ["slides", "reliable-agents-slides.pdf", "demo-slides-upload-v1", tasks[2]!.id],
  ["document", "reliable-agents-notes.pdf", "demo-document-upload-v1", undefined],
] as const) {
  const uploaded = await request<UploadOutput>(`/events/${eventId}/portal/assets`, {
    method: "POST",
    session: speakerSession,
    expectedStatus: 201,
    body: {
      taskId,
      purpose,
      filename,
      contentType: "application/pdf",
      contentBase64: "JVBERi0xLjQKJSBkZXRlcm1pbmlzdGljIGRlbW8K",
      expectedVersion: taskId ? materialsVersion : 0,
      idempotencyKey: key,
    },
  });
  if (taskId) materialsVersion = uploaded.task?.completionVersion ?? materialsVersion;
}

const taskPublicForm = await request<{ readonly form: { readonly fields: readonly FormField[] } }>(
  `/events/${eventId}/portal/forms/${encode(publishedTaskForm.id)}`,
  { session: speakerSession },
);
await request(`/events/${eventId}/portal/forms/${encode(publishedTaskForm.id)}/submissions`, {
  method: "POST",
  session: speakerSession,
  expectedStatus: 201,
  headers: { "Idempotency-Key": "demo-speaker-logistics-v1" },
  body: {
    answers: [
      { fieldId: primary(taskPublicForm.form.fields, "Travel or accessibility notes"), value: "No travel support needed; please reserve a quiet preparation space." },
      { fieldId: primary(taskPublicForm.form.fields, "Dietary preference"), value: "Vegetarian" },
    ],
  },
});
await request(`/events/${eventId}/portal/tasks/${encode(tasks[3]!.id)}/completion`, {
  method: "PUT",
  session: speakerSession,
  body: { completed: true, data: { source: "task-form" }, idempotencyKey: "demo-complete-logistics-v1" },
});
await request(`/events/${eventId}/portal/tasks/${encode(tasks[4]!.id)}/completion`, {
  method: "PUT",
  session: speakerSession,
  body: { completed: true, data: { source: "demo-hydrator" }, idempotencyKey: "demo-confirm-participation-v1" },
});

const createdTalk = await request<AgendaMutation>(`/events/${eventId}/agenda/talks`, {
  method: "POST",
  session: ownerSession,
  expectedStatus: 201,
  body: {
    submissionId: submission.submissionId,
    trackId: null,
    roomId: null,
    startsAt: null,
    durationMin: 45,
    idempotencyKey: "demo-create-talk-v1",
  },
});
const scheduledTalks = [createdTalk];
const trackIds = [
  "demo-track-systems",
  "demo-track-tools",
  "demo-track-research",
  "demo-track-leadership",
] as const;
const roomIds = [
  "demo-room-harbor",
  "demo-room-summit",
  "demo-room-studio",
  "demo-room-lab",
] as const;
for (let index = 0; index < 18; index += 1) {
  const talk = index === 0
    ? createdTalk
    : await request<AgendaMutation>(`/events/${eventId}/agenda/talks`, {
        method: "POST",
        session: ownerSession,
        expectedStatus: 201,
        body: {
          submissionId: acceptedPeople[index]!.submission.submissionId,
          trackId: null,
          roomId: null,
          startsAt: null,
          durationMin: 45,
          idempotencyKey: `demo-create-talk-${index + 1}-v1`,
        },
      });
  if (index > 0) scheduledTalks.push(talk);
  const dayIndex = Math.floor(index / 6);
  const slotWithinDay = index % 6;
  await request(`/events/${eventId}/agenda/talks/${encode(talk.talk.id)}/schedule`, {
    method: "PUT",
    session: ownerSession,
    body: {
      trackId: trackIds[index % trackIds.length],
      roomId: roomIds[slotWithinDay % roomIds.length],
      startsAt: 1_789_664_400_000 + dayIndex * DAY_MS + Math.floor(slotWithinDay / roomIds.length) * 3_600_000,
      durationMin: 45,
      expectedVersion: talk.talk.version,
      idempotencyKey: `demo-schedule-talk-${index + 1}-v1`,
    },
  });
}
const agenda = await request<AgendaSnapshot>(`/events/${eventId}/agenda?view=day`, { session: ownerSession });
await request(`/events/${eventId}/agenda/publications`, {
  method: "POST",
  session: ownerSession,
  expectedStatus: 201,
  body: {
    expectedRevision: agenda.publication.revision,
    expectedWorkspaceVersion: agenda.workspaceVersion,
    expectedEventVersion: agenda.eventVersion,
    idempotencyKey: "demo-publish-agenda-v1",
  },
});

const template = await request<CommunicationTemplate>(`/events/${eventId}/comms/templates`, {
  method: "POST",
  session: ownerSession,
  expectedStatus: 201,
  body: {
    name: "Speaker schedule confirmation",
    subject: "{{speaker.name}}, your {{event.name}} schedule is confirmed",
    textBody: "Hi {{speaker.name}}, your session {{talk.title}} is confirmed in {{talk.room}}. Open your portal: {{portal.url}}",
    htmlBody: "<p>Hi {{speaker.name}},</p><p>Your session <strong>{{talk.title}}</strong> is confirmed in {{talk.room}}.</p><p><a href=\"{{portal.url}}\">Open your speaker portal</a></p>",
    attachIcs: true,
    idempotencyKey: "demo-create-comms-template-v1",
  },
});
await request(`/events/${eventId}/comms/deliveries`, {
  method: "POST",
  session: ownerSession,
  expectedStatus: 202,
  body: {
    templateId: template.id,
    expectedTemplateVersion: template.version,
    recipientKeys: [`${accepted.primarySpeakerId}:accepted`],
    replyToEmail: "program@sessionparty.local",
    scheduledFor: null,
    idempotencyKey: "demo-enqueue-speaker-mail-v1",
  } satisfies Omit<EnqueueCommunicationInput, "eventId">,
});

let deliveryHistory: DeliveryHistory | undefined;
for (let attempt = 0; attempt < 30; attempt += 1) {
  deliveryHistory = await request<DeliveryHistory>(`/events/${eventId}/comms/deliveries`, { session: ownerSession });
  if (deliveryHistory.localCaptureCount > 0 && deliveryHistory.deliveries.some(({ status }) => status === "sent")) break;
  await new Promise((resolve) => setTimeout(resolve, 200));
}
if (!deliveryHistory || deliveryHistory.localCaptureCount === 0) {
  throw new Error("Local communication delivery did not reach sent capture state");
}

const firstImport = await request<ImportRun>(`/events/${eventId}/integrations/accelevents/imports`, {
  method: "POST",
  session: ownerSession,
  body: { idempotencyKey: "demo-accelevents-import-v1" },
});
const secondImport = await request<ImportRun>(`/events/${eventId}/integrations/accelevents/imports`, {
  method: "POST",
  session: ownerSession,
  body: { idempotencyKey: "demo-accelevents-import-v2" },
});
if (firstImport.counts.created !== 4 || secondImport.counts.unchanged !== 4) {
  throw new Error(`Accelevents fixture did not prove create-then-unchanged behavior: ${JSON.stringify({ firstImport, secondImport })}`);
}

const [publicSpeakers, publicAgenda] = await Promise.all([
  request<{ readonly speakers: readonly unknown[] }>(`/public/events/${eventSlug}/speakers`),
  request<{ readonly revision: number; readonly talks: readonly unknown[] }>(`/public/events/${eventSlug}/agenda/published`),
]);
if (publicSpeakers.speakers.length !== 32 || publicAgenda.talks.length !== 18) {
  throw new Error(
    `Public demo scale mismatch: expected 32 speakers and 18 talks, received ${publicSpeakers.speakers.length} speakers and ${publicAgenda.talks.length} talks`,
  );
}

console.log(JSON.stringify({
  mode: "local-fake",
  hydrated: true,
  origin,
  event: { id: eventId, slug: eventSlug },
  forms: { cfp: publishedCfp.id, task: publishedTaskForm.id },
  submission: submission.submissionId,
  speaker: accepted.primarySpeakerId,
  provisioning: accepted.provisioningId,
  tasks: tasks.map(({ id }) => id),
  scale: {
    speakers: publicSpeakers.speakers.length,
    submissions: acceptedSubmissions.length + submittedBacklog.length,
    accepted: acceptedPeople.length,
    talks: scheduledTalks.length,
    tracks: trackIds.length,
    rooms: roomIds.length,
  },
  talk: createdTalk.talk.id,
  publicationRevision: publicAgenda.revision,
  deliveries: deliveryHistory.deliveries.length,
  accelevents: { firstRun: firstImport.runId, secondRun: secondImport.runId },
}, null, 2));
