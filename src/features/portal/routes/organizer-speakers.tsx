import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { Avatar, Badge, Button, Checkbox, Input, ReadinessThread, Select, Table, Toaster, toast } from "@/ui";
import type { SpeakerDirectory, SpeakerDirectoryItem } from "../schema";
import { getSpeakerDirectory, provisionSpeaker, updateSpeakerPublication } from "./api";
import { RouteFailure, RouteLoading, useRouteLoad } from "../components/route-state";
import {
  ProductionHeader,
  ProductionSectionLabel,
  ProductionStats,
  productionButtonClass,
  productionTableClass,
} from "../components/production-ui";

export const path = "/e/:eventSlug/speakers";

const SPEAKERS_PER_PAGE = 25;

type SpeakerDirectoryFilter = "all" | "needs_attention" | "ready" | "unprovisioned" | "hidden";

export function filterSpeakerDirectory(
  speakers: readonly SpeakerDirectoryItem[],
  query: string,
  filter: SpeakerDirectoryFilter,
): readonly SpeakerDirectoryItem[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return speakers.filter((item) => {
    const matchesFilter = filter === "all"
      || (filter === "needs_attention" && item.readiness.state !== "ready")
      || (filter === "ready" && item.readiness.state === "ready")
      || (filter === "unprovisioned" && item.provisioningStatus !== "provisioned")
      || (filter === "hidden" && !item.speaker.visible);
    if (!matchesFilter) return false;
    if (!normalizedQuery) return true;
    return [
      item.speaker.displayName,
      item.speaker.title,
      item.speaker.company,
      item.submission?.title,
      item.submission?.category,
    ].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery));
  });
}

export default function OrganizerSpeakersRoute() {
  const { eventSlug = "" } = useParams();
  const [state, retry] = useRouteLoad(() => getSpeakerDirectory(eventSlug), eventSlug);
  const [busySpeakerId, setBusySpeakerId] = useState<string | null>(null);

  if (state.status === "loading") return <RouteLoading label="Loading speaker directory" />;
  if (state.status === "error") return <RouteFailure message={state.message} onRetry={retry} />;

  async function mutate(speakerId: string, action: () => Promise<unknown>, success: string) {
    setBusySpeakerId(speakerId);
    try {
      await action();
      toast(success, { tone: "success" });
      retry();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Speaker could not be updated", { tone: "danger" });
    } finally {
      setBusySpeakerId(null);
    }
  }

  return (
    <>
      <OrganizerSpeakersContent
        directory={state.data}
        busySpeakerId={busySpeakerId}
        onProvision={(item) =>
          mutate(
            item.speaker.id,
            () => provisionSpeaker(state.data.event.id, {
              eventId: state.data.event.id,
              speakerId: item.speaker.id,
              provisioningId: item.provisioningId,
              expectedVersion: item.provisioningVersion,
            }),
            "Speaker provisioned",
          )
        }
        onVisibility={(item, visible) =>
          mutate(
            item.speaker.id,
            () => updateSpeakerPublication(state.data.event.id, {
              eventId: state.data.event.id,
              speakerId: item.speaker.id,
              expectedVersion: item.speaker.version,
              visible,
            }),
            visible ? "Speaker published" : "Speaker hidden",
          )
        }
      />
      <Toaster />
    </>
  );
}

export function OrganizerSpeakersContent({
  directory,
  busySpeakerId = null,
  onProvision,
  onVisibility,
}: {
  readonly directory: SpeakerDirectory;
  readonly busySpeakerId?: string | null;
  readonly onProvision: (speaker: SpeakerDirectoryItem) => void;
  readonly onVisibility: (speaker: SpeakerDirectoryItem, visible: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SpeakerDirectoryFilter>("all");
  const [page, setPage] = useState(1);
  const readyCount = directory.speakers.filter((item) => item.readiness.state === "ready").length;
  const provisionedCount = directory.speakers.filter((item) => item.provisioningStatus === "provisioned").length;
  const visibleCount = directory.speakers.filter((item) => item.speaker.visible).length;
  const filteredSpeakers = useMemo(
    () => filterSpeakerDirectory(directory.speakers, query, filter),
    [directory.speakers, filter, query],
  );
  const pageCount = Math.max(1, Math.ceil(filteredSpeakers.length / SPEAKERS_PER_PAGE));
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * SPEAKERS_PER_PAGE;
  const visibleSpeakers = filteredSpeakers.slice(pageStart, pageStart + SPEAKERS_PER_PAGE);
  return (
    <div className="space-y-8">
      <ProductionHeader
        eyebrow="Organizer control room / Cast"
        title="Speakers"
        description={`Production directory for ${directory.event.name}. Readiness is derived from completed event tasks.`}
        accent="coral"
        actions={
          <span className="border-2 border-[#171714] bg-[#ff714f] px-3 py-2 text-[10px] font-black uppercase tracking-[0.12em] shadow-[3px_3px_0_#171714]">
            {directory.speakers.length} speakers on call
          </span>
        }
      />
      <ProductionStats
        stats={[
          { label: "Accepted", value: directory.speakers.length, tone: "paper" },
          { label: "Provisioned", value: provisionedCount, tone: "sky" },
          { label: "Ready", value: readyCount, tone: "lime" },
          { label: "Public", value: visibleCount, tone: "purple" },
        ]}
      />
      <section aria-label="Speaker production directory">
        <ProductionSectionLabel>Speaker production directory</ProductionSectionLabel>
        <div className="mb-4 grid gap-3 border-2 border-[#171714] bg-[#fffdf7] p-4 shadow-[4px_4px_0_#171714] sm:grid-cols-[minmax(0,1fr)_16rem]">
          <Input
            type="search"
            label="Search speakers"
            placeholder="Name, company, session, or category"
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setPage(1);
            }}
          />
          <Select
            label="Show"
            value={filter}
            onChange={(event) => {
              setFilter(event.currentTarget.value as SpeakerDirectoryFilter);
              setPage(1);
            }}
          >
            <option value="all">All speakers</option>
            <option value="needs_attention">Needs attention</option>
            <option value="ready">Ready</option>
            <option value="unprovisioned">Not provisioned</option>
            <option value="hidden">Hidden from gallery</option>
          </Select>
        </div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 text-xs font-bold text-[#4f4a40]">
          <p role="status">
            {filteredSpeakers.length === 0
              ? "No matching speakers"
              : `${pageStart + 1}–${Math.min(pageStart + SPEAKERS_PER_PAGE, filteredSpeakers.length)} of ${filteredSpeakers.length} matching speakers`}
          </p>
          {filteredSpeakers.length !== directory.speakers.length ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setQuery("");
                setFilter("all");
                setPage(1);
              }}
            >
              Clear filters
            </Button>
          ) : null}
        </div>
        <div className={productionTableClass}>
          <Table
            rows={[...visibleSpeakers]}
            rowKey={(item) => item.speaker.id}
            empty="Accepted speakers will appear after provisioning begins."
            columns={[
          {
            key: "speaker",
            header: "Speaker",
            render: (item) => (
              <div className="flex min-w-48 items-center gap-3">
                <Avatar name={item.speaker.displayName} size="md" />
                <div className="min-w-0">
                  <p className="truncate font-semibold text-ink">{item.speaker.displayName}</p>
                  <p className="truncate text-xs text-ink-faint">
                    {[item.speaker.title, item.speaker.company].filter(Boolean).join(" · ") || "Profile pending"}
                  </p>
                </div>
              </div>
            ),
          },
          {
            key: "session",
            header: "Accepted session",
            render: (item) => item.submission ? (
              <div className="max-w-64">
                <Link
                  className="font-black text-ink underline decoration-2 underline-offset-4 hover:text-accent-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  to={`/e/${encodeURIComponent(directory.event.slug)}/review?selectedSubmissionId=${encodeURIComponent(item.submission.id)}`}
                >
                  {item.submission.title}
                </Link>
                {item.submission.category && <p className="text-xs text-ink-faint">{item.submission.category}</p>}
              </div>
            ) : <span className="text-ink-faint">Not linked</span>,
          },
          {
            key: "readiness",
            header: "Readiness",
            render: (item) => (
              <div className="min-w-52">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <Badge tone={item.readiness.state === "ready" ? "success" : item.readiness.state === "in_progress" ? "accent" : "warning"}>
                    {item.readiness.state.replace("_", " ")}
                  </Badge>
                  <span className="text-xs text-ink-faint">{item.readiness.tasksDone}/{item.readiness.tasksTotal}</span>
                </div>
                <ReadinessThread
                  compact
                  currentId={item.readiness.nextTaskId ?? undefined}
                  className="[&_li>span]:rounded-none [&_li>span]:border-[#171714]"
                  items={item.readiness.outstandingTaskIds.map((id, index) => ({
                    id,
                    label: `Outstanding task ${index + 1}`,
                    state: "pending" as const,
                  }))}
                />
              </div>
            ),
          },
          {
            key: "publication",
            header: "Public gallery",
            render: (item) => (
              <Checkbox
                label={item.speaker.visible ? "Visible" : "Hidden"}
                checked={item.speaker.visible}
                disabled={busySpeakerId === item.speaker.id || item.provisioningStatus !== "provisioned"}
                onChange={(event) => onVisibility(item, event.currentTarget.checked)}
              />
            ),
          },
          {
            key: "action",
            header: "Provisioning",
            render: (item) => item.provisioningStatus === "provisioned" ? (
              <Badge tone="success">Provisioned</Badge>
            ) : item.provisioningStatus === "failed" ? (
              <Badge tone="danger">Failed</Badge>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                className={productionButtonClass}
                loading={busySpeakerId === item.speaker.id}
                onClick={() => onProvision(item)}
              >
                Provision
              </Button>
            ),
          },
            ]}
          />
        </div>
        {pageCount > 1 ? (
          <nav className="mt-5 flex items-center justify-between gap-4" aria-label="Speaker directory pages">
            <Button
              variant="secondary"
              className={productionButtonClass}
              disabled={currentPage === 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              Previous
            </Button>
            <p className="text-xs font-black uppercase tracking-[0.12em] text-[#171714]">
              Page {currentPage} of {pageCount}
            </p>
            <Button
              variant="secondary"
              className={productionButtonClass}
              disabled={currentPage === pageCount}
              onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
            >
              Next
            </Button>
          </nav>
        ) : null}
      </section>
    </div>
  );
}
