import type {
  AcceptanceSummary,
  AiSuggestion,
  ReviewRound,
  ReviewWorkbench,
  SubmissionReviewDetail,
  SubmissionReviewSummary,
} from "./schema";

export const fixtureClock = 1_786_118_400_000;
export const fixtureEventId = "event_review_fixture";
export const fixtureReviewerId = "user_reviewer_ada";
export const fixtureOwnerId = "user_owner_morgan";
export const fixturePrimarySpeakerId = "speaker_primary_01";

export const reviewerDirectoryFixture = [
  { id: fixtureReviewerId, name: "Ada Rivera", assignmentCount: 12 },
  { id: "user_reviewer_dev", name: "Dev Shah", assignmentCount: 11 },
  { id: "user_reviewer_mina", name: "Mina Okafor", assignmentCount: 10 },
] as const;

export const activeRoundFixture = {
  id: "round_program_fit",
  name: "Program fit",
  order: 1,
  status: "active",
  version: 3,
  rubric: {
    criteria: [
      {
        key: "relevance",
        label: "Audience relevance",
        description: "A clear fit for working event-production teams.",
        max: 5,
      },
      {
        key: "specificity",
        label: "Specificity",
        description: "Concrete lessons rather than a broad product pitch.",
        max: 5,
      },
      {
        key: "delivery",
        label: "Delivery potential",
        description: "A credible structure that will work in the allotted time.",
        max: 5,
      },
    ],
  },
} satisfies ReviewRound;

export const pendingRoundFixture = {
  id: "round_final_selection",
  name: "Final selection",
  order: 2,
  status: "pending",
  version: 1,
  rubric: {
    criteria: [
      { key: "program_balance", label: "Program balance", description: "Complements the accepted program.", max: 5 },
      { key: "readiness", label: "Speaker readiness", description: "Evidence supports a production-ready session.", max: 5 },
    ],
  },
} satisfies ReviewRound;

export const completedRoundFixture = {
  id: "round_blind_screen",
  name: "Blind screen",
  order: 0,
  status: "complete",
  version: 7,
  rubric: {
    criteria: [
      { key: "clarity", label: "Clarity", description: "The proposal is immediately legible.", max: 5 },
      { key: "originality", label: "Originality", description: "The angle adds something new.", max: 5 },
    ],
  },
} satisfies ReviewRound;

export const aiSuggestionFixture = {
  id: "review_ai_01",
  label: "AI suggestion — requires human confirmation",
  score: 4,
  scores: [
    { criterionKey: "relevance", score: 5 },
    { criterionKey: "specificity", score: 4 },
    { criterionKey: "delivery", score: 3 },
  ],
  comment:
    "Strong operational relevance and a concrete premise. Confirm that the live teardown fits the session length before saving a human review.",
  version: 1,
  createdAt: fixtureClock - 45 * 60_000,
  inputFields: ["title", "abstract", "rubric"],
} satisfies AiSuggestion;

export const acceptedProvisionedFixture = {
  acceptanceEventId: "acceptance_01",
  submissionVersion: 5,
  acceptedAt: fixtureClock - 86_400_000,
  provisioningId: "provisioning_01",
  provisioningStatus: "provisioned",
} satisfies AcceptanceSummary;

export const contentionFixture = {
  submissionId: "submission_03",
  expectedVersion: 2,
  currentVersion: 3,
  message: "This proposal changed after the workbench loaded. Reload before accepting it.",
} as const;

const proposalTitles = [
  "The 12-Minute Room Turnover",
  "Designing CFPs People Actually Finish",
  "A No-Panic Run of Show",
  "What Your Badge Queue Is Telling You",
  "When the Green Room Becomes the Control Room",
  "Accessible Captions Under Real Deadlines",
  "The Sponsor Demo That Survived Offline Mode",
  "Four Signals of a Healthy Speaker Pipeline",
  "Making Hybrid Q&A Feel Intentional",
  "The Quiet Work Behind a Great Hallway Track",
  "Conflict-Free Scheduling Without a Spreadsheet Maze",
  "From Accepted Talk to Ready Speaker",
  "Practical Load Tests for Registration Day",
  "A Field Guide to Last-Minute Track Changes",
  "Designing Session Feedback People Trust",
] as const;

const categories = ["Operations", "Program design", "Accessibility", "Community"] as const;

function statusFor(index: number): SubmissionReviewSummary["status"] {
  if (index === 0) return "accepted";
  if (index % 17 === 0) return "waitlist";
  if (index % 13 === 0) return "rejected";
  if (index % 4 === 0) return "in_review";
  return "submitted";
}

function reviewStateFor(index: number): SubmissionReviewSummary["reviewState"] {
  if (index % 9 === 0) return "complete";
  if (index % 4 === 0) return "in_progress";
  if (index % 2 === 0) return "assigned";
  return "unassigned";
}

export const submissionQueueFixture = Array.from({ length: 60 }, (_, index) => {
  const reviewState = reviewStateFor(index);
  const completedReviewCount = reviewState === "complete" ? 2 : reviewState === "in_progress" ? 1 : 0;
  return {
    id: `submission_${String(index + 1).padStart(2, "0")}`,
    title: proposalTitles[index % proposalTitles.length]!,
    category: categories[index % categories.length]!,
    status: statusFor(index),
    submittedAt: fixtureClock - index * 3_600_000,
    version: index === 2 ? contentionFixture.currentVersion : index === 0 ? 5 : 2,
    reviewState,
    assignmentCount: reviewState === "unassigned" ? 0 : 2,
    completedReviewCount,
    averageScore: completedReviewCount === 0 ? null : Number((3.2 + (index % 5) * 0.3).toFixed(1)),
  } satisfies SubmissionReviewSummary;
});

const selectedSummary = submissionQueueFixture[4]!;

export const assignedSubmissionFixture = {
  ...selectedSummary,
  abstract:
    "A practical teardown of a live session handoff: the cues, accessible checks, equipment reset, and ownership boundaries that let a small team turn a room in twelve minutes without rushing speakers or attendees.",
  speakers: [
    { id: fixturePrimarySpeakerId, displayName: "Jordan Lee", isPrimary: true },
    { id: "speaker_cospeaker_01", displayName: "Samira Bell", isPrimary: false },
  ],
  round: activeRoundFixture,
  assignments: [
    { id: "assignment_ada_01", reviewerUserId: fixtureReviewerId, reviewerName: "Ada Rivera", version: 1 },
    { id: "assignment_dev_01", reviewerUserId: "user_reviewer_dev", reviewerName: "Dev Shah", version: 1 },
  ],
  reviews: [
    {
      id: "review_human_01",
      reviewerUserId: fixtureReviewerId,
      reviewerName: "Ada Rivera",
      score: 4,
      scores: [
        { criterionKey: "relevance", score: 5 },
        { criterionKey: "specificity", score: 4 },
        { criterionKey: "delivery", score: 3 },
      ],
      comment: "Strong fit. I want one concrete accessibility checkpoint in the live walkthrough.",
      version: 2,
      updatedAt: fixtureClock - 30 * 60_000,
    },
  ],
  aiSuggestions: [aiSuggestionFixture],
  acceptance: null,
} satisfies SubmissionReviewDetail;

const acceptedSummary = submissionQueueFixture[0]!;

export const acceptedSubmissionFixture = {
  ...acceptedSummary,
  abstract:
    "A timed, repeatable room-turnover playbook for program leads, stage managers, and accessibility staff.",
  speakers: [{ id: fixturePrimarySpeakerId, displayName: "Jordan Lee", isPrimary: true }],
  round: completedRoundFixture,
  assignments: [
    { id: "assignment_accepted_01", reviewerUserId: fixtureReviewerId, reviewerName: "Ada Rivera", version: 1 },
  ],
  reviews: [
    {
      id: "review_accepted_01",
      reviewerUserId: fixtureReviewerId,
      reviewerName: "Ada Rivera",
      score: 4.5,
      scores: [
        { criterionKey: "clarity", score: 5 },
        { criterionKey: "originality", score: 4 },
      ],
      comment: "Ready for the program.",
      version: 1,
      updatedAt: fixtureClock - 2 * 86_400_000,
    },
  ],
  aiSuggestions: [],
  acceptance: acceptedProvisionedFixture,
} satisfies SubmissionReviewDetail;

export function detailForFixtureSubmission(submissionId: string): SubmissionReviewDetail | null {
  if (submissionId === acceptedSubmissionFixture.id) return acceptedSubmissionFixture;
  if (submissionId === assignedSubmissionFixture.id) return assignedSubmissionFixture;
  const summary = submissionQueueFixture.find((submission) => submission.id === submissionId);
  if (!summary) return null;
  const assigned = summary.assignmentCount > 0;
  const reviewed = summary.completedReviewCount > 0;
  const number = Number.parseInt(submissionId.slice(-2), 10);
  return {
    ...summary,
    abstract: `${summary.title} is a deterministic submitted proposal for the ${summary.category ?? "general"} track. It describes a concrete operating practice, the audience outcome, and a live example reviewers can assess against the current rubric.`,
    speakers: [{
      id: `speaker_fixture_${String(number).padStart(2, "0")}`,
      displayName: `Fixture Speaker ${String(number).padStart(2, "0")}`,
      isPrimary: true,
    }],
    round: activeRoundFixture,
    assignments: assigned
      ? [{
          id: `assignment_fixture_${String(number).padStart(2, "0")}`,
          reviewerUserId: fixtureReviewerId,
          reviewerName: "Ada Rivera",
          version: 1,
        }]
      : [],
    reviews: reviewed
      ? [{
          id: `review_fixture_${String(number).padStart(2, "0")}`,
          reviewerUserId: fixtureReviewerId,
          reviewerName: "Ada Rivera",
          score: 4,
          scores: [
            { criterionKey: "relevance", score: 4 },
            { criterionKey: "specificity", score: 4 },
            { criterionKey: "delivery", score: 4 },
          ],
          comment: "Deterministic completed review fixture.",
          version: 1,
          updatedAt: fixtureClock - number * 60_000,
        }]
      : [],
    aiSuggestions: [],
    acceptance: null,
  };
}

export const emptyReviewFixture = {
  eventId: fixtureEventId,
  eventName: "Fieldcraft 2026",
  timezone: "America/Los_Angeles",
  viewerRole: "admin",
  rounds: [completedRoundFixture, activeRoundFixture, pendingRoundFixture],
  queue: [],
  selected: null,
  pagination: { page: 1, pageSize: 60, total: 0, pageCount: 0 },
  lastUpdatedAt: fixtureClock,
} satisfies ReviewWorkbench;

export const reviewWorkbenchFixture = {
  eventId: fixtureEventId,
  eventName: "Fieldcraft 2026",
  timezone: "America/Los_Angeles",
  viewerRole: "admin",
  rounds: [completedRoundFixture, activeRoundFixture, pendingRoundFixture],
  queue: submissionQueueFixture,
  selected: assignedSubmissionFixture,
  pagination: { page: 1, pageSize: 60, total: 60, pageCount: 1 },
  lastUpdatedAt: fixtureClock,
} satisfies ReviewWorkbench;
