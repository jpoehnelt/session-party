import { useState } from "react";
import { useParams } from "react-router";
import { Avatar, Badge, Button, Checkbox, ReadinessThread, Table, Toaster, toast } from "@/ui";
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
  const readyCount = directory.speakers.filter((item) => item.readiness.state === "ready").length;
  const provisionedCount = directory.speakers.filter((item) => item.provisioningStatus === "provisioned").length;
  const visibleCount = directory.speakers.filter((item) => item.speaker.visible).length;
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
        <div className={productionTableClass}>
          <Table
            rows={[...directory.speakers]}
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
                <p className="font-medium text-ink">{item.submission.title}</p>
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
      </section>
    </div>
  );
}
