import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Combobox } from "./Combobox";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from "./Command";

const meta = {
  title: "UI/Command and combobox",
  component: Command,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Command>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CommandPalette: Story = {
  render: () => (
    <Command className="w-[min(34rem,calc(100vw-2rem))] border border-line shadow-card">
      <CommandInput aria-label="Search event actions" placeholder="Search event actions…" />
      <CommandList>
        <CommandEmpty>No actions found.</CommandEmpty>
        <CommandGroup heading="Navigate"><CommandItem>Open submissions<CommandShortcut>G S</CommandShortcut></CommandItem><CommandItem>Open agenda<CommandShortcut>G A</CommandShortcut></CommandItem></CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Create"><CommandItem>Create form</CommandItem><CommandItem>Add session</CommandItem></CommandGroup>
      </CommandList>
    </Command>
  ),
};

function ControlledCombobox() {
  const [value, setValue] = useState("");
  return <Combobox aria-label="Session room" value={value} onValueChange={setValue} placeholder="Choose a room" searchPlaceholder="Search rooms…" options={[{ value: "main", label: "Main stage" }, { value: "studio", label: "Studio" }, { value: "workshop", label: "Workshop room" }, { value: "closed", label: "Closed room", disabled: true }]} />;
}

export const SearchableCombobox: Story = { render: () => <ControlledCombobox /> };
