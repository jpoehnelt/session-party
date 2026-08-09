import type { Meta, StoryObj } from "@storybook/react-vite";
import { Avatar } from "./Avatar";
import { Card } from "./Card";
import { Dropzone } from "./Dropzone";
import { Table, type TableColumn } from "./Table";

const meta = {
  title: "UI/Data display",
  component: Card,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

interface SessionRow {
  id: string;
  title: string;
  room: string;
  status: string;
}

const columns: TableColumn<SessionRow>[] = [
  { key: "title", header: "Session" },
  { key: "room", header: "Room" },
  { key: "status", header: "Status" },
];

export const CardAndAvatars: Story = {
  render: () => (
    <Card className="w-[min(34rem,calc(100vw-2rem))]" title="Speaker team" footer={<span className="text-sm text-ink-secondary">2 speakers confirmed</span>}>
      <div className="flex items-center gap-4">
        <Avatar name="Ada Rivera" size="lg" />
        <Avatar name="Grace Kim" size="md" />
        <div><p className="font-medium text-ink">Effect at scale</p><p className="text-sm text-ink-secondary">Main stage · 10:30 AM</p></div>
      </div>
    </Card>
  ),
};

export const ScheduleTable: Story = {
  render: () => (
    <div className="w-[min(44rem,calc(100vw-2rem))] overflow-hidden rounded-card border border-line bg-surface">
      <Table columns={columns} rows={[{ id: "1", title: "Effect at scale", room: "Main stage", status: "Confirmed" }, { id: "2", title: "Durable workflows", room: "Studio", status: "Draft" }]} rowKey={(row) => row.id} />
    </div>
  ),
};

export const EmptyTable: Story = {
  render: () => <div className="w-[min(44rem,calc(100vw-2rem))] overflow-hidden rounded-card border border-line bg-surface"><Table columns={columns} rows={[]} empty="No sessions are scheduled." /></div>,
};

export const FileDropzone: Story = {
  render: () => <div className="w-[min(34rem,calc(100vw-2rem))]"><Dropzone accept="image/png,image/jpeg" hint="PNG or JPEG, up to 10 MB" onFiles={() => undefined} /></div>,
};
