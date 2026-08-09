import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Checkbox, Input, Select, Textarea } from "./fields";

const meta = {
  title: "UI/Form controls",
  component: Input,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

function ControlledFields() {
  const [name, setName] = useState("Ada Rivera");
  const [track, setTrack] = useState("systems");
  const [featured, setFeatured] = useState(true);
  return (
    <form className="grid w-[min(32rem,calc(100vw-2rem))] gap-4" onSubmit={(event) => event.preventDefault()}>
      <Input label="Speaker name" value={name} onChange={(event) => setName(event.target.value)} hint="Shown on the public agenda." />
      <Textarea label="Biography" defaultValue="Engineering leader and distributed systems speaker." />
      <Select label="Track" value={track} onChange={(event) => setTrack(event.target.value)}>
        <option value="systems">AI systems</option>
        <option value="tools">Developer tools</option>
        <option value="research">Research</option>
      </Select>
      <Checkbox label="Featured speaker" description="Highlight this speaker in the public gallery." checked={featured} onChange={(event) => setFeatured(event.target.checked)} />
    </form>
  );
}

export const Controlled: Story = { render: () => <ControlledFields /> };

export const ValidationAndDisabled: Story = {
  render: () => (
    <div className="grid w-[min(32rem,calc(100vw-2rem))] gap-4">
      <Input label="Email address" value="not-an-email" readOnly error="Enter a valid email address." />
      <Textarea label="Abstract" disabled value="This proposal is locked while review is in progress." readOnly />
      <Select label="Review round" disabled defaultValue="round-1"><option value="round-1">Round one</option></Select>
      <Checkbox label="Required agreement" required description="This native control remains form-compatible." />
    </div>
  ),
};

export const MultipleNativeSelect: Story = {
  render: () => (
    <Select label="Speaker topics" multiple defaultValue={["ai", "effect"]} className="min-h-28 w-72">
      <option value="ai">AI</option>
      <option value="effect">Effect</option>
      <option value="workers">Cloudflare Workers</option>
    </Select>
  ),
};
