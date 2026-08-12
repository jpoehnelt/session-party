import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assignedSubmissionFixture, reviewWorkbenchFixture } from "../fixtures";
import type { SubmissionReviewDetail } from "../schema";

const mutationMocks = vi.hoisted(() => ({
  acceptSubmissionRequest: vi.fn(),
  advanceReviewRoundRequest: vi.fn(),
  appendReviewCommentRequest: vi.fn(),
  assignReviewerRequest: vi.fn(),
  bulkAssignReviewersRequest: vi.fn(),
  createReviewRoundRequest: vi.fn(),
  exportReviewResultsRequest: vi.fn(),
  recuseAssignmentRequest: vi.fn(),
  removeAssignmentRequest: vi.fn(),
  rejectSubmissionRequest: vi.fn(),
  requestAiSuggestionRequest: vi.fn(),
  revokeAcceptanceRequest: vi.fn(),
  saveScoreRequest: vi.fn(),
  sendReviewRemindersRequest: vi.fn(),
  updateReviewRoundRequest: vi.fn(),
}));

vi.mock("./mutations", () => mutationMocks);

import { ReviewWorkbenchContent } from "./review-workbench";

type DecisionState = Pick<SubmissionReviewDetail, "status" | "version" | "acceptance">;

const workbenchFor = (
  id: string,
  title: string,
  decision: DecisionState = { status: "submitted", version: 3, acceptance: null },
) => {
  const selected = {
    ...assignedSubmissionFixture,
    id,
    title,
    ...decision,
  };
  return {
    ...reviewWorkbenchFixture,
    queue: [selected],
    selected,
    pagination: { page: 1, pageSize: 60, total: 1, pageCount: 1 },
  };
};

const buttonNamed = (name: string): HTMLButtonElement => {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.includes(name));
  if (!button) throw new Error(`Missing button: ${name}`);
  return button;
};

describe("rendered review decision lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    mutationMocks.acceptSubmissionRequest.mockReset();
    mutationMocks.acceptSubmissionRequest.mockRejectedValue(new Error("Response lost after commit"));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("preserves ambiguous retries and rotates accept keys after same-submission state changes", async () => {
    await act(async () => {
      root.render(
        <ReviewWorkbenchContent
          workbench={workbenchFor("submission-a", "Proposal A")}
          onSelectSubmission={() => undefined}
        />,
      );
    });

    await act(async () => buttonNamed("Accept & provision primary speaker").click());
    await vi.waitFor(() => expect(mutationMocks.acceptSubmissionRequest).toHaveBeenCalledTimes(1));
    const proposalAKey = mutationMocks.acceptSubmissionRequest.mock.calls[0]?.[0].idempotencyKey;

    await act(async () => buttonNamed("Accept & provision primary speaker").click());
    await vi.waitFor(() => expect(mutationMocks.acceptSubmissionRequest).toHaveBeenCalledTimes(2));
    expect(mutationMocks.acceptSubmissionRequest.mock.calls[1]?.[0]).toMatchObject({
      submissionId: "submission-a",
      idempotencyKey: proposalAKey,
    });

    await act(async () => {
      root.render(
        <ReviewWorkbenchContent
          workbench={workbenchFor("submission-a", "Proposal A", {
            status: "accepted",
            version: 4,
            acceptance: {
              acceptanceEventId: "acceptance-a-1",
              submissionVersion: 4,
              acceptedAt: 1_700_000_100_000,
              provisioningId: "provisioning-a-1",
              provisioningStatus: "pending",
            },
          })}
          onSelectSubmission={() => undefined}
        />,
      );
    });
    expect(container.textContent).toContain("Undo acceptance");

    await act(async () => {
      root.render(
        <ReviewWorkbenchContent
          workbench={workbenchFor("submission-a", "Proposal A", {
            status: "submitted",
            version: 5,
            acceptance: null,
          })}
          onSelectSubmission={() => undefined}
        />,
      );
    });
    await act(async () => buttonNamed("Accept & provision primary speaker").click());
    await vi.waitFor(() => expect(mutationMocks.acceptSubmissionRequest).toHaveBeenCalledTimes(3));
    const reacceptKey = mutationMocks.acceptSubmissionRequest.mock.calls[2]?.[0].idempotencyKey;
    expect(mutationMocks.acceptSubmissionRequest.mock.calls[2]?.[0]).toMatchObject({
      submissionId: "submission-a",
      expectedVersion: 5,
    });
    expect(reacceptKey).not.toBe(proposalAKey);

    await act(async () => {
      root.render(
        <ReviewWorkbenchContent
          workbench={workbenchFor("submission-b", "Proposal B", {
            status: "submitted",
            version: 5,
            acceptance: null,
          })}
          onSelectSubmission={() => undefined}
        />,
      );
    });
    await act(async () => buttonNamed("Accept & provision primary speaker").click());
    await vi.waitFor(() => expect(mutationMocks.acceptSubmissionRequest).toHaveBeenCalledTimes(4));
    expect(mutationMocks.acceptSubmissionRequest.mock.calls[3]?.[0]).toMatchObject({
      submissionId: "submission-b",
      expectedVersion: 5,
    });
    expect(mutationMocks.acceptSubmissionRequest.mock.calls[3]?.[0].idempotencyKey).not.toBe(reacceptKey);
  });
});
