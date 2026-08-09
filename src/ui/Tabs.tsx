import { type KeyboardEvent, useRef } from "react";
import { Tabs as RadixTabs } from "radix-ui";
import { cx } from "./cx";

export interface TabItem {
  id: string;
  label: string;
  /** DOM id of the consumer-rendered visible tab panel. */
  panelId?: string;
}

export interface TabsProps {
  tabs: TabItem[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
}

export function Tabs({ tabs, active, onChange, className }: TabsProps) {
  const triggerRefs = useRef(new Map<string, HTMLButtonElement>());

  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number;
    switch (event.key) {
      case "ArrowRight":
        nextIndex = (index + 1) % tabs.length;
        break;
      case "ArrowLeft":
        nextIndex = (index - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = tabs.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    const nextTab = tabs[nextIndex];
    if (!nextTab) return;
    onChange(nextTab.id);
    triggerRefs.current.get(nextTab.id)?.focus();
  };

  return (
    <RadixTabs.Root value={active} onValueChange={onChange}>
      <RadixTabs.List className={cx("flex gap-1 border-b border-line", className)}>
        {tabs.map((tab, index) => (
          <RadixTabs.Trigger
            key={tab.id}
            value={tab.id}
            id={tab.panelId ? `${tab.panelId}-tab` : undefined}
            aria-controls={tab.panelId}
            tabIndex={tab.id === active ? 0 : -1}
            ref={(node) => {
              if (node) triggerRefs.current.set(tab.id, node);
              else triggerRefs.current.delete(tab.id);
            }}
            onKeyDown={(event) => moveFocus(event, index)}
            className={cx(
              "-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium text-ink-faint outline-none transition-colors motion-reduce:transition-none hover:text-ink-secondary focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset data-[state=active]:border-accent data-[state=active]:text-ink",
              "border-transparent",
            )}
          >
            {tab.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {tabs.filter((tab) => tab.panelId == null).map((tab) => (
        <RadixTabs.Content key={tab.id} value={tab.id} className="sr-only">
          {tab.label} view selected
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  );
}
