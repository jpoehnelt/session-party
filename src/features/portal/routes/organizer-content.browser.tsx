import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentAsset, ContentLibrary } from "../schema";
import { OrganizerContentLibrary } from "./organizer-content";

const library: ContentLibrary = {
  event: {
    id: "content-event",
    slug: "content-event",
    name: "Content Event",
    description: null,
    location: "Main Hall",
    timezone: "America/Los_Angeles",
    startsAt: Date.UTC(2027, 4, 12),
    endsAt: Date.UTC(2027, 4, 14),
    bannerAssetId: null,
    accentColor: null,
  },
  assets: [{
    id: "river-current",
    eventId: "content-event",
    filename: "slides.pdf",
    contentType: "application/pdf",
    size: 4096,
    purpose: "slides",
    version: 2,
    speakerId: "river",
    speakerName: "River Okafor",
    speakerVersion: 3,
    sessionTitles: ["The calm show call"],
    versionCount: 2,
    current: true,
    supersedesAssetId: "river-history",
    restoredFromAssetId: null,
    uploadedAt: Date.UTC(2027, 3, 2, 16),
    comments: [],
  }, {
    id: "jamie-current",
    eventId: "content-event",
    filename: "diagram.png",
    contentType: "image/png",
    size: 2048,
    purpose: "document",
    version: 1,
    speakerId: "jamie",
    speakerName: "Jamie Chen",
    speakerVersion: 2,
    sessionTitles: ["Cache Invalidation Without Folklore"],
    versionCount: 1,
    current: true,
    supersedesAssetId: null,
    restoredFromAssetId: null,
    uploadedAt: Date.UTC(2027, 3, 1, 16),
    comments: [],
  }, {
    id: "river-history",
    eventId: "content-event",
    filename: "slides-draft.pdf",
    contentType: "application/pdf",
    size: 1024,
    purpose: "slides",
    version: 1,
    speakerId: "river",
    speakerName: "River Okafor",
    speakerVersion: 3,
    sessionTitles: ["The calm show call"],
    versionCount: 2,
    current: false,
    supersedesAssetId: null,
    restoredFromAssetId: null,
    uploadedAt: Date.UTC(2027, 2, 20, 16),
    comments: [],
  }],
};

const byButton = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")]
  .find((button) => button.textContent?.includes(name));

const fieldNamed = <T extends HTMLInputElement | HTMLSelectElement>(name: string): T => {
  const label = [...document.querySelectorAll<HTMLLabelElement>("label")]
    .find((candidate) => candidate.textContent?.includes(name));
  const field = label?.htmlFor ? document.getElementById(label.htmlFor) as T | null : null;
  if (!field) throw new Error(`Missing field: ${name}`);
  return field;
};

describe("organizer content library rendered interactions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("shows session and version metadata and confirms a latest-only multi-file ZIP", async () => {
    const onDownloadZip = vi.fn(async (_assets: readonly ContentAsset[]) => undefined);
    await act(async () => root.render(
      <OrganizerContentLibrary
        library={library}
        onComment={() => undefined}
        onRestore={() => undefined}
        onDownload={() => undefined}
        onDownloadZip={onDownloadZip}
      />,
    ));

    expect(container.textContent).toContain("The calm show call");
    expect(container.textContent).toContain("Cache Invalidation Without Folklore");
    expect(container.textContent).toContain("v2 of 2");
    expect(container.textContent).toContain(new Date(library.assets[0]!.uploadedAt).toLocaleString());

    await act(async () => userEvent.selectOptions(fieldNamed<HTMLSelectElement>("Versions"), "history"));
    expect(fieldNamed<HTMLInputElement>("Select slides-draft.pdf").disabled).toBe(true);

    await act(async () => userEvent.click(byButton("Select current results")!));
    expect(container.textContent).toContain("2 files selected");
    await act(async () => userEvent.click(byButton("Download selected ZIP")!));
    await vi.waitFor(() => expect(onDownloadZip).toHaveBeenCalledOnce());
    expect(onDownloadZip.mock.calls[0]?.[0].map((asset) => asset.id)).toEqual(["river-current", "jamie-current"]);
    expect(container.textContent).toContain("ZIP download started for 2 latest files.");
  });

  it("preserves rejected comments, resets accepted comments, and reports ZIP failure", async () => {
    const onComment = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const onDownloadZip = vi.fn(async () => false);
    await act(async () => root.render(
      <OrganizerContentLibrary
        library={{ ...library, assets: [library.assets[0]!] }}
        onComment={onComment}
        onRestore={() => undefined}
        onDownload={() => undefined}
        onDownloadZip={onDownloadZip}
      />,
    ));

    await act(async () => userEvent.click(document.querySelector("summary")!));
    const comment = fieldNamed<HTMLInputElement>("Add comment");
    await act(async () => userEvent.fill(comment, "Retain this rejected review"));
    await act(async () => userEvent.click(byButton("Comment")!));
    await vi.waitFor(() => expect(onComment).toHaveBeenCalledTimes(1));
    expect(comment.value).toBe("Retain this rejected review");

    await act(async () => userEvent.click(byButton("Comment")!));
    await vi.waitFor(() => expect(onComment).toHaveBeenCalledTimes(2));
    expect(comment.value).toBe("");

    await act(async () => userEvent.click(byButton("Select current results")!));
    await act(async () => userEvent.click(byButton("Download selected ZIP")!));
    await vi.waitFor(() => expect(onDownloadZip).toHaveBeenCalledOnce());
    expect(container.textContent).toContain("ZIP generation failed. Try again.");
    expect(container.textContent).not.toContain("ZIP download started");
  });
});
