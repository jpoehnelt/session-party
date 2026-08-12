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
  releaseDecisionsRequest: vi.fn(),
  requestAiSuggestionRequest: vi.fn(),
  revokeAcceptanceRequest: vi.fn(),
  saveScoreRequest: vi.fn(),
  sendReviewRemindersRequest: vi.fn(),
  stageDecisionRequest: vi.fn(),
  updateReviewRoundRequest: vi.fn(),
}));

vi.mock("./mutations", () => mutationMocks);

import { ReviewWorkbenchContent } from "./review-workbench";

type DecisionState = Pick<SubmissionReviewDetail, "status" | "version" | "acceptance" | "pendingDecision">;

const workbenchFor = (
  id: string,
  title: string,
  decision: DecisionState = { status: "submitted", version: 3, acceptance: null, pendingDecision: null },
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
    mutationMocks.stageDecisionRequest.mockReset();
    mutationMocks.stageDecisionRequest.mockRejectedValue(new Error("Response lost after commit"));
    mutationMocks.releaseDecisionsRequest.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("preserves ambiguous retries and rotates staged-decision keys after proposal changes", async () => {
    await act(async () => {
      root.render(
        <ReviewWorkbenchContent
          workbench={workbenchFor("submission-a", "Proposal A")}
          onSelectSubmission={() => undefined}
        />,
      );
    });

    await act(async () => buttonNamed("Stage acceptance").click());
    await vi.waitFor(() => expect(mutationMocks.stageDecisionRequest).toHaveBeenCalledTimes(1));
    const proposalAKey = mutationMocks.stageDecisionRequest.mock.calls[0]?.[0].idempotencyKey;

    await act(async () => buttonNamed("Stage acceptance").click());
    await vi.waitFor(() => expect(mutationMocks.stageDecisionRequest).toHaveBeenCalledTimes(2));
    expect(mutationMocks.stageDecisionRequest.mock.calls[1]?.[0]).toMatchObject({
      submissionId: "submission-a",
      decision: "accepted",
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
            pendingDecision: null,
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
            pendingDecision: null,
          })}
          onSelectSubmission={() => undefined}
        />,
      );
    });
    await act(async () => buttonNamed("Stage acceptance").click());
    await vi.waitFor(() => expect(mutationMocks.stageDecisionRequest).toHaveBeenCalledTimes(3));
    const reacceptKey = mutationMocks.stageDecisionRequest.mock.calls[2]?.[0].idempotencyKey;
    expect(mutationMocks.stageDecisionRequest.mock.calls[2]?.[0]).toMatchObject({
      submissionId: "submission-a",
      decision: "accepted",
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
            pendingDecision: null,
          })}
          onSelectSubmission={() => undefined}
        />,
      );
    });
    await act(async () => buttonNamed("Stage acceptance").click());
    await vi.waitFor(() => expect(mutationMocks.stageDecisionRequest).toHaveBeenCalledTimes(4));
    expect(mutationMocks.stageDecisionRequest.mock.calls[3]?.[0]).toMatchObject({
      submissionId: "submission-b",
      decision: "accepted",
      expectedVersion: 5,
    });
    expect(mutationMocks.stageDecisionRequest.mock.calls[3]?.[0].idempotencyKey).not.toBe(reacceptKey);
  });

  it("requires explicit organizer confirmation before releasing the selected staged queue", async () => {
    const staged = workbenchFor("submission-a", "Proposal A", {
      status: "submitted",
      version: 4,
      acceptance: null,
      pendingDecision: "accepted",
    });
    const rejected = {
      ...staged.selected!,
      id: "submission-b",
      title: "Proposal B",
      status: "in_review" as const,
      version: 7,
      pendingDecision: "rejected" as const,
    };
    const workbench = {
      ...staged,
      queue: [staged.selected!, rejected],
      pagination: { page: 1, pageSize: 60, total: 2, pageCount: 1 },
    };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const onMutationCommitted = vi.fn(async () => undefined);
    mutationMocks.releaseDecisionsRequest.mockResolvedValue({
      releaseId: "decision-release-1",
      releasedCount: 2,
      acceptedCount: 1,
      rejectedCount: 1,
      submissionIds: ["submission-a", "submission-b"],
      idempotent: false,
    });

    await act(async () => {
      root.render(
        <ReviewWorkbenchContent
          workbench={workbench}
          onSelectSubmission={() => undefined}
          onMutationCommitted={onMutationCommitted}
        />,
      );
    });
    expect(container.textContent).toContain("2 private decisions");
    await act(async () => buttonNamed("Select all staged").click());
    expect(mutationMocks.releaseDecisionsRequest).not.toHaveBeenCalled();
    await act(async () => buttonNamed("Release 2 decisions").click());
    await vi.waitFor(() => expect(mutationMocks.releaseDecisionsRequest).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("1 accepted · 1 rejected"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("No email is sent automatically"));
    expect(mutationMocks.releaseDecisionsRequest).toHaveBeenCalledWith(expect.objectContaining({
      eventId: workbench.eventId,
      decisions: [
        { submissionId: "submission-a", expectedVersion: 4, expectedDecision: "accepted" },
        { submissionId: "submission-b", expectedVersion: 7, expectedDecision: "rejected" },
      ],
      idempotencyKey: expect.stringMatching(/^review-release-/),
    }));
    await vi.waitFor(() => expect(onMutationCommitted).toHaveBeenCalledTimes(1));
    expect(container.textContent).toContain("No email was sent");
    confirm.mockRestore();

    await act(async () => {
      root.render(
        <ReviewWorkbenchContent
          workbench={{ ...workbench, viewerRole: "reviewer" }}
          onSelectSubmission={() => undefined}
        />,
      );
    });
    expect(container.textContent).not.toContain("Staged decisions in this queue");
    expect(container.textContent).not.toContain("private decisions");
  });
});
