import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Button } from "./Button";
import { Input } from "./fields";
import { Modal } from "./Modal";
import { Sheet } from "./Sheet";

const meta = {
  title: "UI/Overlays",
  component: Modal,
  args: { open: false, onClose: () => undefined, title: "Dialog" },
  parameters: { layout: "centered" },
} satisfies Meta<typeof Modal>;

export default meta;
type Story = StoryObj<typeof meta>;

function ModalExample({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Create event</Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Create event"
        size={size}
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button>Save event</Button></>}
      >
        <div className="grid gap-4">
          <Input autoFocus label="Event name" placeholder="Fieldcraft 2026" />
          <Input label="Event slug" placeholder="fieldcraft-2026" />
        </div>
      </Modal>
    </>
  );
}

function SheetExample() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Move talk</Button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Move talk"
        size="lg"
        footer={<Button type="submit" form="move-talk-story">Save move</Button>}
      >
        <form id="move-talk-story" className="grid gap-4" onSubmit={(event) => { event.preventDefault(); setOpen(false); }}>
          <Input autoFocus label="Start time" type="time" defaultValue="10:30" />
          <Input label="Room" defaultValue="Main stage" />
        </form>
      </Sheet>
    </>
  );
}

export const ModalControlled: Story = { render: () => <ModalExample /> };
export const ModalLarge: Story = { render: () => <ModalExample size="lg" /> };
export const SheetWithExternalSubmit: Story = { render: () => <SheetExample /> };
