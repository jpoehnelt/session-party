import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { apiFetch } from "@/client/api";
import { EventOutput } from "@/features/events/schema";
import { Badge, Button, Card, EmptyState, PageHeader, Skeleton } from "@/ui";
import { InstitutionalArchive, type InstitutionalArchive as InstitutionalArchiveValue } from "../schema";

export const path = "/e/:eventSlug/exports";

type ExportState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly archive: InstitutionalArchiveValue };

export const archiveFiles = (archive: InstitutionalArchiveValue) => ({
  [`${archive.event.slug}-archive.json`]: archive,
  [`${archive.event.slug}-speakers.json`]: {
    format: archive.format,
    exportedAt: archive.exportedAt,
    event: archive.event,
    speakers: archive.speakers,
  },
  [`${archive.event.slug}-sessions.json`]: {
    format: archive.format,
    exportedAt: archive.exportedAt,
    event: archive.event,
    sessions: archive.sessions,
  },
  [`${archive.event.slug}-submissions.json`]: {
    format: archive.format,
    exportedAt: archive.exportedAt,
    event: archive.event,
    submissions: archive.submissions,
  },
  [`${archive.event.slug}-decisions.json`]: {
    format: archive.format,
    exportedAt: archive.exportedAt,
    event: archive.event,
    reviews: archive.reviews,
    reviewComments: archive.reviewComments,
    decisions: archive.decisions,
  },
  [`${archive.event.slug}-onboarding.json`]: {
    format: archive.format,
    exportedAt: archive.exportedAt,
    event: archive.event,
    tasks: archive.tasks,
    taskCompletions: archive.taskCompletions,
    speakerContacts: archive.speakerContacts,
  },
});

const downloadJson = (filename: string, value: unknown) => {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

export default function ExportsRoute() {
  const { eventSlug = "" } = useParams();
  const [request, setRequest] = useState(0);
  const [state, setState] = useState<ExportState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    void apiFetch(`/api/v1/events/${encodeURIComponent(eventSlug)}`, { schema: EventOutput })
      .then((event) => apiFetch(`/api/v1/events/${encodeURIComponent(event.id)}/exports/archive`, {
        schema: InstitutionalArchive,
      }))
      .then((archive) => { if (active) setState({ status: "ready", archive }); })
      .catch((error: unknown) => {
        if (active) setState({
          status: "error",
          message: error instanceof Error ? error.message : "The event archive could not be prepared",
        });
      });
    return () => { active = false; };
  }, [eventSlug, request]);

  if (state.status === "loading") return <Skeleton className="min-h-72" />;
  if (state.status === "error") {
    return (
      <EmptyState
        title="Archive unavailable"
        description={state.message}
        action={<Button onClick={() => setRequest((value) => value + 1)}>Try again</Button>}
      />
    );
  }

  const files = archiveFiles(state.archive);
  const counts = [
    ["Speakers", state.archive.speakers.length],
    ["Submissions", state.archive.submissions.length],
    ["Sessions", state.archive.sessions.length],
    ["Decisions", state.archive.decisions.length],
  ] as const;

  return (
    <div className="space-y-7">
      <PageHeader
        title="Institutional archive"
        description="Keep stable event history outside Session Party. Exports retain IDs, submission-time speaker context, committee decisions, and onboarding evidence."
        actions={<Badge tone="accent">{state.archive.format}</Badge>}
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {counts.map(([label, count]) => (
          <Card key={label} title={label}>
            <p className="text-3xl font-semibold tracking-tight text-ink">{count}</p>
          </Card>
        ))}
      </div>
      <Card title="Download durable data">
        <p className="mb-5 max-w-3xl text-sm leading-relaxed text-ink-secondary">
          The complete archive is the recovery copy. Focused files are convenient projections of the same versioned record, so their identifiers join without fuzzy matching.
        </p>
        <div className="flex flex-wrap gap-3">
          {Object.entries(files).map(([filename, value], index) => (
            <Button
              key={filename}
              variant={index === 0 ? "primary" : "secondary"}
              onClick={() => downloadJson(filename, value)}
            >
              {index === 0 ? "Download complete archive" : `Download ${filename.split("-").at(-1)}`}
            </Button>
          ))}
        </div>
      </Card>
      <Card title="Calendar continuity">
        <p className="text-sm leading-relaxed text-ink-secondary">
          Published schedule and speaker invite calendar files use talk IDs as stable UIDs. Republishing a moved session updates its sequence without creating a different calendar identity.
        </p>
      </Card>
    </div>
  );
}
