import type { Meta, StoryObj } from "@storybook/react-vite";
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { Button, IconButton } from "./Button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "./DropdownMenu";
import { Label } from "./Label";
import { Popover, PopoverContent, PopoverTrigger } from "./Popover";
import { ScrollArea } from "./ScrollArea";
import { Separator } from "./Separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./Tooltip";

const meta = {
  title: "UI/Menus and disclosure",
  component: DropdownMenu,
  parameters: { layout: "centered" },
} satisfies Meta<typeof DropdownMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

function MenuExample() {
  const [visible, setVisible] = useState(true);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><IconButton aria-label="Open session actions" variant="secondary"><MoreHorizontal /></IconButton></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Session actions</DropdownMenuLabel>
        <DropdownMenuGroup><DropdownMenuItem>Edit session<DropdownMenuShortcut>⌘E</DropdownMenuShortcut></DropdownMenuItem><DropdownMenuItem>Duplicate</DropdownMenuItem></DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={visible} onCheckedChange={(next) => setVisible(Boolean(next))}>Visible publicly</DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-danger focus:text-danger">Cancel session</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const KeyboardMenu: Story = { render: () => <MenuExample /> };

export const PopoverEditor: Story = {
  render: () => (
    <Popover>
      <PopoverTrigger asChild><Button variant="secondary">Edit timezone</Button></PopoverTrigger>
      <PopoverContent align="start" className="space-y-3">
        <div><p className="font-semibold">Event timezone</p><p className="text-sm text-ink-secondary">All agenda times use this zone.</p></div>
        <Separator />
        <Label htmlFor="timezone-story">IANA timezone</Label>
        <input id="timezone-story" className="h-10 w-full rounded-control border border-line-strong bg-surface px-3 text-sm outline-none focus:ring-2 focus:ring-accent/30" defaultValue="America/Los_Angeles" />
      </PopoverContent>
    </Popover>
  ),
};

export const TooltipAndScrollArea: Story = {
  render: () => (
    <TooltipProvider>
      <div className="grid gap-4">
        <Tooltip><TooltipTrigger asChild><Button variant="ghost">Publication status</Button></TooltipTrigger><TooltipContent>Only confirmed talks appear on the public schedule.</TooltipContent></Tooltip>
        <ScrollArea className="h-40 w-72 rounded-control border border-line bg-surface p-3">
          <div className="space-y-3">{Array.from({ length: 12 }, (_, index) => <div key={index}><p className="text-sm font-medium">Activity {index + 1}</p><p className="text-xs text-ink-faint">Organizer updated the event workspace.</p>{index < 11 && <Separator className="mt-3" />}</div>)}</div>
        </ScrollArea>
      </div>
    </TooltipProvider>
  ),
};
