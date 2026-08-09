import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewWorkbench } from "../schema";
import {
  errorFrom,
  decideQueueInteraction,
  loadReviewWorkbench,
  path,
  ReviewLoadFailure,
  ReviewWorkbenchContent,
  selectVisibleFallback,
} from "./review-workbench";


const workbench: ReviewWorkbench = {
  eventId: "event_summit",
  eventName: "Summit 2026",
  timezone: "America/Los_Angeles",
  viewerRole: "admin",
  viewerUserId: "user_admin",
  reviewers: [{ userId: "user_reviewer", name: "Grace Reviewer" }],
  rounds: [{
    id: "round_active",
    name: "Main review",
    order: 1,
    status: "active",
    rubric: { criteria: [{ key: "clarity", label: "Clarity", max: 5 }] },
    version: 1,
  }],
  queue: [{
    id: "submission_authoritative",
    title: "Authoritative proposal",
    category: "Engineering",
    status: "submitted",
    submittedAt: 1_700_000_000_000,
    version: 3,
    reviewState: "unassigned",
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
    assignmentCount: 0,
    completedReviewCount: 0,
    averageScore: null,
    abstract: "Returned by the review API.",
    speakers: [{ id: "speaker_ada", displayName: "Ada Rivera", isPrimary: true }],
    round: {
      id: "round_active",
      name: "Main review",
      order: 1,
      status: "active",
      rubric: { criteria: [{ key: "clarity", label: "Clarity", max: 5 }] },
      version: 1,
    },
    assignments: [],
    reviews: [],
    aiSuggestions: [],
    acceptance: null,
  },
  pagination: { page: 1, pageSize: 60, total: 1, pageCount: 1 },
  lastUpdatedAt: 1_700_000_000_000,
};

afterEach(() => vi.unstubAllGlobals());

describe("review workbench route", () => {
  it("exports the review navigation route", () => {
    expect(path).toBe("/e/:eventSlug/review");
  });

  it("keeps queue focus local and does not reload the current authoritative submission", () => {
    expect(decideQueueInteraction("focus", "submission_other", "submission_authoritative", undefined)).toEqual({
      focusedSubmissionId: "submission_other",
      loadSubmissionId: undefined,
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


  it("keeps the queue and filters mounted while selected detail reloads", () => {
    const markup = renderToStaticMarkup(createElement(ReviewWorkbenchContent, {
      workbench,
      isDetailLoading: true,
      onSelectSubmission: () => undefined,
    }));

    expect(markup).toContain("Search proposals");
    expect(markup).toContain("All statuses");
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
    expect(markup).toContain("version 1");
    expect(markup).not.toContain("Fixture snapshot");
    expect(markup).not.toContain("reviewWorkbenchFixture");
    expect(markup).toContain("Assign reviewer");
    expect(markup).toContain("Request AI suggestion");
    expect(markup).toContain("Accept &amp; provision primary speaker");
    expect(markup).not.toContain("Save my review");
  });

  it("renders human scoring only for the assigned signed-in reviewer", () => {
    const reviewerWorkbench: ReviewWorkbench = {
      ...workbench,
      viewerRole: "reviewer",
      viewerUserId: "user_reviewer",
      reviewers: [],
      selected: workbench.selected && {
        ...workbench.selected,
        reviewState: "assigned",
        assignmentCount: 1,
        assignments: [{
          id: "assignment_reviewer",
          reviewerUserId: "user_reviewer",
          reviewerName: "Grace Reviewer",
          version: 1,
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
