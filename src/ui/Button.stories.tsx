import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, IconButton } from "./Button";
import { XIcon } from "./icons";

const meta = {
  title: "UI/Button",
  component: Button,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Variants: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Button>Primary</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="danger">Danger</Button>
    </div>
  ),
};

export const SizesAndStates: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Button size="sm">Small</Button>
      <Button size="md">Medium</Button>
      <Button loading>Publishing</Button>
      <Button disabled>Disabled</Button>
      <IconButton aria-label="Close panel" size="sm"><XIcon /></IconButton>
      <IconButton aria-label="Close panel" variant="secondary"><XIcon /></IconButton>
    </div>
  ),
};

export const NativeFormAssociation: Story = {
  render: () => (
    <div className="space-y-3">
      <form id="story-form" onSubmit={(event) => event.preventDefault()}>
        <label className="text-sm font-medium text-ink" htmlFor="story-name">Session name</label>
        <input id="story-name" className="mt-1 block rounded-control border border-line-strong px-3 py-2" />
      </form>
      <Button type="submit" form="story-form">Save session</Button>
    </div>
  ),
};
