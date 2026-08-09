import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { EmptyState } from "./EmptyState";
import { Skeleton } from "./Skeleton";
import { Spinner } from "./Spinner";
import { Tabs } from "./Tabs";
import { toast, Toaster } from "./Toaster";

const meta = {
  title: "UI/Feedback and navigation",
  component: Badge,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BadgeTones: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <Badge>Neutral</Badge><Badge tone="accent">Accent</Badge><Badge tone="success">Published</Badge>
      <Badge tone="warning">Needs review</Badge><Badge tone="danger">Conflict</Badge>
    </div>
  ),
};

function ControlledTabs() {
  const [active, setActive] = useState("board");
  const tabs = [
    { id: "board", label: "Board", panelId: "feedback-board" },
    { id: "list", label: "List", panelId: "feedback-list" },
    { id: "published", label: "Published", panelId: "feedback-published" },
  ];
  return (
    <div className="w-[min(38rem,calc(100vw-2rem))] space-y-4">
      <Tabs tabs={tabs} active={active} onChange={setActive} />
      <section
        id={`feedback-${active}`}
        role="tabpanel"
        tabIndex={0}
        aria-labelledby={`feedback-${active}-tab`}
        className="rounded-card border border-line bg-surface p-4 text-sm text-ink-secondary"
      >
        The {active} view is selected. Arrow keys move between tabs.
      </section>
    </div>
  );
}

export const KeyboardTabs: Story = { render: () => <ControlledTabs /> };

export const ToastTones: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" onClick={() => toast("Draft saved")}>Neutral</Button>
      <Button variant="secondary" onClick={() => toast("Agenda published", { tone: "success" })}>Success</Button>
      <Button variant="secondary" onClick={() => toast("Three speaker tasks remain", { tone: "warning" })}>Warning</Button>
      <Button variant="secondary" onClick={() => toast("The schedule has a room conflict", { tone: "danger" })}>Danger</Button>
      <Toaster />
    </div>
  ),
};

export const EmptyAndLoading: Story = {
  render: () => (
    <div className="grid w-[min(32rem,calc(100vw-2rem))] gap-6">
      <EmptyState title="No proposals yet" description="Publish a call for proposals to start collecting submissions." action={<Button>Publish CFP</Button>} />
      <div className="space-y-3" aria-label="Loading event"><Skeleton className="h-6 w-48" /><Skeleton className="h-20 w-full" /><span className="flex items-center gap-2 text-sm text-ink-secondary"><Spinner />Refreshing event</span></div>
    </div>
  ),
};
