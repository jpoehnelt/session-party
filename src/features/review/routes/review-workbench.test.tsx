import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewWorkbench } from "../schema";
import {
  decisionKeysForSubmission,
  submissionDecisionLifecycleIdentity,
} from "../components/SubmissionReviewPane";
import {
  errorFrom,
  decideQueueInteraction,
  loadReviewWorkbench,
  path,
  reviewSelectionSearch,
  ReviewLoadFailure,
  ReviewWorkbenchContent,
  selectCachedReviewDetail,
  selectVisibleFallback,
  shouldApplyReviewRefresh,
} from "./review-workbench";


const workbench: ReviewWorkbench = {
  eventId: "event_summit",
  eventName: "Summit 2026",
  timezone: "America/Los_Angeles",
  viewerRole: "admin",
  viewerUserId: "user_admin",
  reviewers: [{ userId: "user_reviewer", name: "Grace Reviewer" }],
  reviewerProgress: [],
  rounds: [{
    id: "round_active",
    name: "Main review",
    order: 1,
    status: "active",
    startsAt: null,
    endsAt: null,
    blind: false,
    rubric: { criteria: [{ key: "clarity", label: "Clarity", type: "numeric", weight: 1, required: true, max: 5 }] },
    version: 1,
  }],
  progress: {
    roundId: "round_active",
    roundName: "Main review",
    assignedReviewCount: 2,
    completedReviewCount: 1,
    outstandingReviewCount: 1,
    recusalCount: 1,
    reviewers: [{
      reviewerUserId: "user_reviewer",
      reviewerName: "Grace Reviewer",
      assignedReviewCount: 1,
      completedReviewCount: 0,
      outstandingReviewCount: 1,
      recusalCount: 1,
    }],
    incompleteSubmissions: [{
      submissionId: "submission_authoritative",
      title: "Authoritative proposal",
      assignedReviewCount: 0,
      completedReviewCount: 0,
      outstandingReviewerNames: [],
      recusalCount: 1,
      needsReviewer: true,
    }],
  },
  order: "coverage",
  queue: [{
    id: "submission_authoritative",
    title: "Authoritative proposal",
    category: "Engineering",
    status: "submitted",
    submittedAt: 1_700_000_000_000,
    version: 3,
    reviewState: "unassigned",
    assignedToMe: false,
    assignmentCount: 0,
    completedReviewCount: 0,
    averageScore: null,
  }],
  selected: {
    id: "submission_authoritative",
    title: "Authoritative proposal",
    category: "Engineering",
    status: "submitted",
    submittedAt: 1_700_000_000_000,
    version: 3,
    reviewState: "unassigned",
    assignedToMe: false,
    assignmentCount: 0,
    completedReviewCount: 0,
    averageScore: null,
    abstract: "Returned by the review API.",
    speakers: [{ id: "speaker_ada", displayName: "Ada Rivera", isPrimary: true, role: "Primary presenter" }],
    round: {
      id: "round_active",
      name: "Main review",
      order: 1,
      status: "active",
      startsAt: null,
      endsAt: null,
      blind: false,
      rubric: { criteria: [{ key: "clarity", label: "Clarity", type: "numeric", weight: 1, required: true, max: 5 }] },
      version: 1,
    },
    assignments: [],
    reviews: [],
    comments: [],
    recusals: [],
    recusedByMe: false,
    aiSuggestions: [],
    acceptance: null,
  },
  pagination: { page: 1, pageSize: 60, total: 1, pageCount: 1 },
  lastUpdatedAt: 1_700_000_000_000,
};

afterEach(() => vi.unstubAllGlobals());

describe("review workbench route", () => {
  it("keeps ambiguous retry keys stable and rotates them across proposal and decision state changes", () => {
    const submittedAIdentity = submissionDecisionLifecycleIdentity({
      id: "submission-a",
      version: 3,
      status: "submitted",
      acceptance: null,
    });
    const acceptedAIdentity = submissionDecisionLifecycleIdentity({
      id: "submission-a",
      version: 4,
      status: "accepted",
      acceptance: {
        acceptanceEventId: "acceptance-a-1",
        submissionVersion: 4,
        acceptedAt: 1_700_000_100_000,
        provisioningId: "provisioning-a-1",
        provisioningStatus: "pending",
      },
    });
    const revokedAIdentity = submissionDecisionLifecycleIdentity({
      id: "submission-a",
      version: 5,
      status: "submitted",
      acceptance: null,
    });
    const submittedBIdentity = submissionDecisionLifecycleIdentity({
      id: "submission-b",
      version: 5,
      status: "submitted",
      acceptance: null,
    });
    const proposalA = decisionKeysForSubmission(submittedAIdentity);
    const proposalARetry = decisionKeysForSubmission(submittedAIdentity, proposalA);
    const acceptedA = decisionKeysForSubmission(acceptedAIdentity, proposalARetry);
    const revokedA = decisionKeysForSubmission(revokedAIdentity, acceptedA);
    const proposalB = decisionKeysForSubmission(submittedBIdentity, revokedA);
    const proposalBAmbiguousRetry = decisionKeysForSubmission(submittedBIdentity, proposalB);

    expect(proposalARetry).toBe(proposalA);
    expect(proposalBAmbiguousRetry).toBe(proposalB);
    for (const next of [acceptedA, revokedA, proposalB]) {
      expect(next.acceptance).not.toBe(proposalA.acceptance);
      expect(next.rejection).not.toBe(proposalA.rejection);
      expect(next.revocation).not.toBe(proposalA.revocation);
    }
    expect(revokedA.acceptance).not.toBe(acceptedA.acceptance);
    expect(revokedA.rejection).not.toBe(acceptedA.rejection);
    expect(revokedA.revocation).not.toBe(acceptedA.revocation);
    expect(proposalB.acceptance).not.toBe(revokedA.acceptance);
    expect(proposalB.rejection).not.toBe(revokedA.rejection);
    expect(proposalB.revocation).not.toBe(revokedA.revocation);
  });

  it("exports the review navigation route", () => {
    expect(path).toBe("/e/:eventSlug/review");
  });

  it("preloads proposal detail as queue focus changes without reloading current or pending detail", () => {
    expect(decideQueueInteraction("focus", "submission_other", "submission_authoritative", undefined)).toEqual({
      focusedSubmissionId: "submission_other",
      loadSubmissionId: "submission_other",
    });
    expect(decideQueueInteraction(
      "focus",
      "submission_authoritative",
      "submission_authoritative",
      undefined,
    ).loadSubmissionId).toBeUndefined();
    expect(decideQueueInteraction(
      "open",
      "submission_authoritative",
      "submission_authoritative",
      undefined,
    ).loadSubmissionId).toBeUndefined();
    expect(decideQueueInteraction(
      "open",
      "submission_authoritative",
      "submission_other",
      "submission_authoritative",
    ).loadSubmissionId).toBeUndefined();
  });

  it("loads the first visible fallback exactly once when filters hide the authoritative selection", () => {
    const visibleSubmissionIds = ["submission_fallback", "submission_other"];

    expect(selectVisibleFallback("submission_authoritative", undefined, visibleSubmissionIds)).toBe("submission_fallback");
    expect(selectVisibleFallback("submission_authoritative", "submission_fallback", visibleSubmissionIds)).toBeUndefined();
    expect(selectVisibleFallback("submission_fallback", undefined, visibleSubmissionIds)).toBeUndefined();
  });

  it("keeps selection URLs shareable without discarding other query state", () => {
    expect(reviewSelectionSearch("?status=submitted", "submission_other")).toBe(
      "?status=submitted&selectedSubmissionId=submission_other",
    );
    expect(reviewSelectionSearch("?selectedSubmissionId=old&status=accepted", "submission_new")).toBe(
      "?selectedSubmissionId=submission_new&status=accepted",
    );
  });

  it("applies cached detail against the latest queue summary", () => {
    const cached = {
      ...workbench.selected!,
      title: "Cached title",
      abstract: "Cached authoritative abstract",
      version: 2,
    };
    const latest: ReviewWorkbench = {
      ...workbench,
      queue: workbench.queue.map((submission) => ({
        ...submission,
        title: "Latest queue title",
        version: 4,
        status: "in_review" as const,
      })),
    };

    const selected = selectCachedReviewDetail(latest, cached).selected;
    expect(selected).toMatchObject({
      id: cached.id,
      title: "Latest queue title",
      abstract: "Cached authoritative abstract",
      version: 4,
      status: "in_review",
    });
  });

  it("rejects a mutation refresh after selection moves to another proposal", () => {
    expect(shouldApplyReviewRefresh("submission_authoritative", "submission_authoritative")).toBe(true);
    expect(shouldApplyReviewRefresh("submission_other", "submission_authoritative")).toBe(false);
  });


  it("keeps the queue and filters mounted while selected detail reloads", () => {
    const markup = renderToStaticMarkup(createElement(ReviewWorkbenchContent, {
      workbench,
      isDetailLoading: true,
      onSelectSubmission: () => undefined,
    }));

    expect(markup).toContain("Search proposals");
    expect(markup).toContain("All statuses");
    expect(markup).toContain("Coverage · fewest reviews");
    expect(markup).toContain("Decision · highest score");
    expect(markup).toContain("Authoritative proposal");
    expect(markup).toContain("Loading selected proposal");
    expect(markup).not.toContain("Loading submissions, rounds, and assignments.");
  });
  it("renders a sign-in state without queue data or mutation controls", () => {
    const markup = renderToStaticMarkup(createElement(ReviewLoadFailure, {
      error: { kind: "unauthenticated" },
      onRetry: () => undefined,
      onSignIn: () => undefined,
    }));

    expect(markup).toContain("Sign in to review proposals");
    expect(markup).toContain("Sign in");
    expect(markup).not.toContain("Authoritative proposal");
    expect(markup).not.toContain("Assign reviewer");
    expect(markup).not.toContain("Save my review");
    expect(markup).not.toContain("Fixture snapshot");
  });

  it("resolves the slug before loading and renders authoritative review data", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "event_summit",
        name: "Summit 2026",
        slug: "summit-2026",
        timezone: "America/Los_Angeles",
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify(workbench)));
    vi.stubGlobal("fetch", fetchMock);

    const loaded = await loadReviewWorkbench("summit-2026");
    const markup = renderToStaticMarkup(createElement(ReviewWorkbenchContent, {
      workbench: loaded.workbench,
      onSelectSubmission: () => undefined,
    }));

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/events/summit-2026", expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/events/event_summit/review", expect.any(Object));
    expect(markup).toContain("Authoritative proposal");
    expect(markup).toContain("Returned by the review API.");
    expect(markup).toContain("Review rounds");
    expect(markup).toContain("Create round");
    expect(markup).toContain("Version 3");
    expect(markup).not.toContain("Fixture snapshot");
    expect(markup).not.toContain("reviewWorkbenchFixture");
    expect(markup).toContain("Assign reviewer");
    expect(markup).toContain("review progress");
    expect(markup).toContain("1 / 2");
    expect(markup).toContain("Needs reviewer");
    expect(markup).toContain("Reviewer invitations");
    expect(markup).toContain("Invite reviewer");
    expect(markup).toContain("Request AI suggestion");
    expect(markup).toContain("Accept &amp; provision primary speaker");
    expect(markup).toContain("No email is sent");
    expect(markup).toContain("Save my review");
  });

  it("reuses known event identity for cancellable proposal detail loads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(workbench)));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await loadReviewWorkbench("summit-2026", "submission_authoritative", {
      event: {
        id: "event_summit",
        name: "Summit 2026",
        slug: "summit-2026",
        timezone: "America/Los_Angeles",
      },
      signal: controller.signal,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/events/event_summit/review?selectedSubmissionId=submission_authoritative",
      expect.objectContaining({ method: "GET", signal: controller.signal }),
    );
  });

  it("offers organizers a plain-language undo action without exposing acceptance IDs", () => {
    const acceptedWorkbench: ReviewWorkbench = {
      ...workbench,
      queue: workbench.queue.map((submission) => ({ ...submission, status: "accepted" })),
      selected: workbench.selected && {
        ...workbench.selected,
        status: "accepted",
        version: 4,
        acceptance: {
          acceptanceEventId: "acceptance_internal_1",
          submissionVersion: 4,
          acceptedAt: 1_700_000_100_000,
          provisioningId: "provisioning_internal_1",
          provisioningStatus: "pending",
        },
      },
    };
    const markup = renderToStaticMarkup(createElement(ReviewWorkbenchContent, {
      workbench: acceptedWorkbench,
      onSelectSubmission: () => undefined,
    }));

    expect(markup).toContain("Undo acceptance");
    expect(markup).toContain("Acceptance is recorded in the audit history");
    expect(markup).not.toContain("acceptance_internal_1");
    expect(markup).not.toContain("Durable acceptance");
  });

  it("renders scoring and the private committee conversation for an assigned event reviewer", () => {
    const reviewerWorkbench: ReviewWorkbench = {
      ...workbench,
      viewerRole: "reviewer",
      viewerUserId: "user_reviewer",
      reviewers: [],
      queue: workbench.queue.map((submission) => ({
        ...submission,
        reviewState: "in_progress" as const,
        assignedToMe: true,
        assignmentCount: 1,
        completedReviewCount: 1,
        averageScore: 4,
      })),
      selected: workbench.selected && {
        ...workbench.selected,
        round: workbench.selected.round && {
          ...workbench.selected.round,
          rubric: {
            criteria: [
              { key: "clarity", label: "Clarity", type: "numeric", weight: 1, required: true, max: 5 },
              {
                key: "recommendation",
                label: "Recommendation",
                type: "dropdown",
                weight: 1,
                required: true,
                max: 5,
                options: [
                  { value: "decline", label: "Decline", score: 1 },
                  { value: "exceptional", label: "Strong accept", score: 5 },
                ],
              },
            ],
          },
        },
        reviewState: "in_progress",
        assignedToMe: true,
        assignmentCount: 1,
        completedReviewCount: 1,
        averageScore: 4,
        assignments: [{
          id: "assignment_reviewer",
          reviewerUserId: "user_reviewer",
          reviewerName: "Grace Reviewer",
          status: "assigned",
          recusalReason: null,
          recusedAt: null,
          version: 1,
        }],
        reviews: [{
          id: "review_colleague",
          reviewerUserId: "user_colleague",
          reviewerName: "Colleague Reviewer",
          score: 4,
          scores: [
            { criterionKey: "clarity", score: 4 },
            { criterionKey: "recommendation", score: "exceptional" },
          ],
          comment: "This is a strong opening; I would clarify the audience outcome.",
          version: 1,
          updatedAt: 1_700_000_000_000,
        }],
        comments: [{
          id: "comment_colleague",
          authorUserId: "user_colleague",
          authorName: "Colleague Reviewer",
          body: "Would the speaker add a concrete production example?",
          createdAt: 1_700_000_000_100,
        }],
      },
    };

    const markup = renderToStaticMarkup(createElement(ReviewWorkbenchContent, {
      workbench: reviewerWorkbench,
      onSelectSubmission: () => undefined,
    }));

    expect(markup).toContain("Rubric scorecard");
    expect(markup).toContain("Save my review");
    expect(markup).toContain("Request AI suggestion");
    expect(markup).toContain("Committee thread");
    expect(markup).toContain("Score rationales");
    expect(markup).toContain("Strong accept (5 / 5)");
    expect(markup).not.toContain("exceptional / 5");
    expect(markup).toContain("Colleague Reviewer");
    expect(markup).toContain("This is a strong opening; I would clarify the audience outcome.");
    expect(markup).toContain("Would the speaker add a concrete production example?");
    expect(markup).toContain("Add committee message");
    expect(markup).toContain("Post message");
    expect(markup).toContain("Speakers and API keys cannot author");
    expect(markup).toContain("Recusal reason (optional)");
    expect(markup).toContain("Recuse from this submission");
    expect(markup).toContain("Reviewers can open and score only proposals assigned to them");
    expect(markup).not.toContain("Assign reviewer");
    expect(markup).not.toContain("Accept &amp; provision primary speaker");
    expect(markup).not.toContain("Create round");
  });

  it("treats a malformed event response as a recoverable load error without fetching review", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      name: "Summit 2026",
      slug: "summit-2026",
      timezone: "America/Los_Angeles",
    })));
    vi.stubGlobal("fetch", fetchMock);

    const error = await loadReviewWorkbench("summit-2026").catch((caught: unknown) => caught);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/events/summit-2026", expect.any(Object));
    expect(errorFrom(error)).toMatchObject({ kind: "failed" });
  });
});
