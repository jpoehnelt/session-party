import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { AgendaBoard } from "./AgendaComposites";
import { Button } from "./Button";
import { EventIdentityHeader } from "./EventIdentityHeader";
import { FormRenderer, type FormRenderField } from "./FormComposites";
import { ScheduleList, SpeakerGallery } from "./PublicComposites";
import { ProgressChecklist, ReadinessThread } from "./Readiness";
import { StatusBadge } from "./StatusBadge";
import { SyncStatusCard } from "./SyncStatusCard";

const meta = {
  title: "UI/Application composites",
  args: { event: { name: "Cloud Summit" } },
  component: EventIdentityHeader,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof EventIdentityHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const EventAndStatuses: Story = {
  render: () => (
    <div className="p-6">
      <EventIdentityHeader
        event={{ name: "Cloud Summit", location: "San Francisco", timezone: "America/Los_Angeles" }}
        status={<StatusBadge state="open" />}
        actions={<Button>Open event</Button>}
      />
    </div>
  ),
};

const fields: readonly FormRenderField[] = [
  { id: "name", type: "text", label: "Speaker name", required: true },
  { id: "abstract", type: "textarea", label: "Session abstract", helpText: "Describe what attendees will learn." },
  { id: "format", type: "select", label: "Format", options: [{ value: "talk", label: "Talk" }, { value: "workshop", label: "Workshop" }] },
  { id: "terms", type: "checkbox", label: "I agree to the speaker terms" },
];

function ControlledForm() {
  const [values, setValues] = useState<Record<string, unknown>>({});
  return (
    <FormRenderer
      fields={fields}
      values={values}
      onValueChange={(id, value) => setValues((current) => ({ ...current, [id]: value }))}
    />
  );
}

export const SubmissionForm: Story = {
  render: () => <div className="mx-auto max-w-2xl p-6"><ControlledForm /></div>,
};

export const ReadinessAndSync: Story = {
  render: () => (
    <div className="grid gap-6 p-6 lg:grid-cols-3">
      <ReadinessThread items={[
        { id: "accepted", label: "Proposal accepted", state: "complete" },
        { id: "slides", label: "Upload slides", state: "pending", description: "Due August 10" },
        { id: "agenda", label: "Confirm agenda", state: "pending" },
      ]} currentId="slides" />
      <ProgressChecklist readOnly items={[
        { id: "bio", label: "Speaker bio", completed: true },
        { id: "headshot", label: "Headshot", completed: false },
      ]} />
      <SyncStatusCard source="Airtable" adapterMode="live" state="synced" lastSyncedAt="2026-08-08T20:00:00Z" />
    </div>
  ),
};

export const Agenda: Story = {
  render: () => (
    <div className="p-6">
      <AgendaBoard
        groups={[{ id: "main", label: "Main stage", items: [{ id: "talk-1", title: "Build in public", startsAt: "9:00 AM", durationMin: 30, speakerNames: ["Ada Rivera"] }] }]}
      />
    </div>
  ),
};

export const PublicSurfaces: Story = {
  render: () => (
    <div className="space-y-8 p-6">
      <SpeakerGallery speakers={[{ id: "speaker-1", displayName: "Ada Rivera", title: "Founder", company: "Northstar", bio: "Builder and event producer." }]} />
      <ScheduleList timezone="America/Los_Angeles" talks={[{ id: "talk-1", title: "Build in public", startsAt: "2026-08-12T16:00:00Z", durationMin: 30, speakerNames: ["Ada Rivera"], room: "Main stage" }]} />
    </div>
  ),
};
