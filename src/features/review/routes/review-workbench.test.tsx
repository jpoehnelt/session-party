import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { describe, expect, it } from "vitest";
import {
  acceptedSubmissionFixture,
  assignedSubmissionFixture,
  emptyReviewFixture,
  fixtureReviewerId,
  reviewWorkbenchFixture,
} from "../fixtures";
import ReviewWorkbenchRoute from "./review-workbench";

describe("review workbench route", () => {
  it("renders organizer evidence read-only and distinguishes a truly empty round", () => {
    const organizerMarkup = renderToStaticMarkup(createElement(ReviewWorkbenchRoute));
    expect(organizerMarkup).toContain("Ada Rivera · read-only evidence");
    expect(organizerMarkup).not.toContain("Save my review");
    expect(organizerMarkup).not.toContain(">Round</label>");

    const reviewerMarkup = renderToStaticMarkup(createElement(ReviewWorkbenchRoute, {
      snapshot: { ...reviewWorkbenchFixture, viewerRole: "reviewer" },
    }));
    expect(reviewerMarkup).toContain("Save my review");

    const emptyMarkup = renderToStaticMarkup(createElement(ReviewWorkbenchRoute, {
      snapshot: emptyReviewFixture,
    }));
    expect(emptyMarkup).toContain("No submissions in this round");
    expect(emptyMarkup).not.toContain("Clear filters");

    expect(organizerMarkup).toContain('aria-labelledby="proposal-heading-submission_05"');
    expect(organizerMarkup).toContain('id="proposal-heading-submission_05"');
    expect(organizerMarkup).not.toContain(`<option value="${fixtureReviewerId}"`);
    expect(organizerMarkup).not.toContain('<option value="user_reviewer_dev"');
    expect(reviewerMarkup).toContain("min-h-11 min-w-11");

    const completedSelectionMarkup = renderToStaticMarkup(createElement(ReviewWorkbenchRoute, {
      snapshot: { ...reviewWorkbenchFixture, selected: acceptedSubmissionFixture },
    }));
    expect(completedSelectionMarkup.split("Blind screen · complete")).toHaveLength(3);

    const noAvailableMarkup = renderToStaticMarkup(createElement(ReviewWorkbenchRoute, {
      snapshot: {
        ...reviewWorkbenchFixture,
        selected: {
          ...assignedSubmissionFixture,
          assignments: [
            ...assignedSubmissionFixture.assignments,
            { id: "assignment_mina_01", reviewerUserId: "user_reviewer_mina", reviewerName: "Mina Okafor", version: 1 },
          ],
        },
      },
    }));
    expect(noAvailableMarkup).toContain("All available reviewers are already assigned to this proposal.");
    expect(noAvailableMarkup).toContain("No available reviewers");

    const loadingMarkup = renderToStaticMarkup(createElement(ReviewWorkbenchRoute, { state: "loading" }));
    expect(loadingMarkup.match(/motion-reduce:animate-none/g)).toHaveLength(4);
  });
});
