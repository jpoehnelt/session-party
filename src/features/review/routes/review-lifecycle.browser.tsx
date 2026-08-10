import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assignedSubmissionFixture, reviewWorkbenchFixture } from "../fixtures";

const mutationMocks = vi.hoisted(() => ({
  acceptSubmissionRequest: vi.fn(),
  advanceReviewRoundRequest: vi.fn(),
  appendReviewCommentRequest: vi.fn(),
  assignReviewerRequest: vi.fn(),
  createReviewRoundRequest: vi.fn(),
  rejectSubmissionRequest: vi.fn(),
  requestAiSuggestionRequest: vi.fn(),
  revokeAcceptanceRequest: vi.fn(),
  saveScoreRequest: vi.fn(),
}));

vi.mock("./mutations", () => mutationMocks);

import { ReviewWorkbenchContent } from "./review-workbench";

const workbenchFor = (id: string, title: string) => {
  const selected = {
    ...assignedSubmissionFixture,
    id,
    title,
    status: "submitted" as const,
    version: 3,
    acceptance: null,
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

  it("reuses an ambiguous accept key for one proposal and resets it after a rendered proposal switch", async () => {
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
          workbench={workbenchFor("submission-b", "Proposal B")}
          onSelectSubmission={() => undefined}
        />,
      );
    });
    await act(async () => buttonNamed("Accept & provision primary speaker").click());
    await vi.waitFor(() => expect(mutationMocks.acceptSubmissionRequest).toHaveBeenCalledTimes(3));

    expect(mutationMocks.acceptSubmissionRequest.mock.calls[2]?.[0]).toMatchObject({
      submissionId: "submission-b",
    });
    expect(mutationMocks.acceptSubmissionRequest.mock.calls[2]?.[0].idempotencyKey).not.toBe(proposalAKey);
  });
});
