import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "./Button";
import { AppShell, PageHeader } from "./layout";

const meta = {
  title: "UI/Layout",
  component: PageHeader,
  parameters: { layout: "fullscreen" },
  args: { title: "Page title" },
} satisfies Meta<typeof PageHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PageHeading: Story = {
  render: () => (
    <div className="bg-canvas p-8">
      <PageHeader title="Fieldcraft 2026" description="Plan proposals, speakers, and the published agenda in one event workspace." actions={<Button>Publish event</Button>} />
    </div>
  ),
};

export const OperationsShell: Story = {
  render: () => (
    <div className="h-screen">
      <AppShell
        sidebar={<nav aria-label="Event navigation" className="space-y-1 p-4"><a className="block border-2 border-on-accent bg-production-lime px-3 py-2 text-xs font-black uppercase tracking-[0.08em] text-ink" href="#overview">Overview</a><a className="block border-2 border-transparent px-3 py-2 text-xs font-black uppercase tracking-[0.08em] text-white/65" href="#agenda">Agenda</a></nav>}
        topbar={<div className="flex min-h-14 items-center justify-between px-4"><span className="text-sm text-ink-secondary">Fieldcraft 2026</span><Button size="sm">Sign in</Button></div>}
      >
        <div className="p-6"><PageHeader title="Event overview" description="Track the work that moves this event toward publication." /><div className="mt-6 rounded-card border-2 border-line-strong bg-surface p-6 font-bold shadow-card">Organizer workspace</div></div>
      </AppShell>
    </div>
  ),
};
