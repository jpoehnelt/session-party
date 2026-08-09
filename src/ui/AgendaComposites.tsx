import type { ReactNode } from "react";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Card } from "./Card";
import { EmptyState } from "./EmptyState";
import { cx } from "./cx";

export interface AgendaConflictItem {
  kind: "room_overlap" | "speaker_overlap";
  itemIds: readonly string[];
  explanation: string;
}

export interface ConflictIndicatorProps {
  conflicts: readonly AgendaConflictItem[];
  compact?: boolean;
  blocking?: boolean;
  className?: string;
}

export function ConflictIndicator({
  conflicts,
  compact = false,
  blocking = true,
  className,
}: ConflictIndicatorProps) {
  if (conflicts.length === 0) {
    return <Badge tone="success" className={className}>No conflicts</Badge>;
  }
  if (compact) {
    return (
      <Badge tone={blocking ? "danger" : "warning"} className={className}>
        {conflicts.length} {conflicts.length === 1 ? "conflict" : "conflicts"}
      </Badge>
    );
  }
  return (
    <section
      role={blocking ? "alert" : "status"}
      className={cx(
        "rounded-control border px-4 py-3",
        blocking ? "border-danger/30 bg-danger-soft" : "border-warning/30 bg-warning-soft",
        className,
      )}
    >
      <h3 className="text-sm font-semibold text-ink">Resolve schedule conflicts</h3>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-secondary">
        {conflicts.map((conflict, index) => (
          <li key={`${conflict.kind}-${conflict.itemIds.join("-")}-${index}`}>{conflict.explanation}</li>
        ))}
      </ul>
    </section>
  );
}

export interface AgendaBoardItem {
  id: string;
  title: string;
  startsAt?: string;
  durationMin?: number;
  track?: string;
  room?: string;
  speakerNames?: readonly string[];
}

export interface AgendaBoardGroup {
  id: string;
  label: string;
  items: readonly AgendaBoardItem[];
}

export interface AgendaBoardProps {
  groups: readonly AgendaBoardGroup[];
  conflicts?: readonly AgendaConflictItem[];
  selectedItemId?: string;
  disabled?: boolean;
  onSelectItem?: (item: AgendaBoardItem) => void;
  renderItemActions?: (item: AgendaBoardItem) => ReactNode;
  empty?: ReactNode;
  className?: string;
}

export function AgendaBoard({
  groups,
  conflicts = [],
  selectedItemId,
  disabled = false,
  onSelectItem,
  renderItemActions,
  empty,
  className,
}: AgendaBoardProps) {
  const hasItems = groups.some((group) => group.items.length > 0);
  if (!hasItems) {
    return <EmptyState title="No sessions scheduled" description="Confirmed sessions will appear here." action={empty} />;
  }
  return (
    <div className={cx("space-y-4", className)}>
      <ConflictIndicator conflicts={conflicts} />
      <div className="grid gap-4 lg:grid-cols-[repeat(auto-fit,minmax(16rem,1fr))]">
        {groups.map((group) => (
          <section key={group.id} aria-labelledby={`agenda-group-${group.id}`}>
            <h2 id={`agenda-group-${group.id}`} className="mb-2 text-sm font-semibold text-ink">{group.label}</h2>
            <div className="space-y-2">
              {group.items.map((item) => (
                <Card
                  key={item.id}
                  className={cx(selectedItemId === item.id && "ring-2 ring-accent/40")}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="font-medium text-ink">{item.title}</h3>
                      <p className="mt-1 text-xs text-ink-faint">
                        {[item.startsAt, item.durationMin ? `${item.durationMin} min` : undefined, item.room, item.track]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      {item.speakerNames && item.speakerNames.length > 0 && (
                        <p className="mt-1 text-sm text-ink-secondary">{item.speakerNames.join(", ")}</p>
                      )}
                    </div>
                    {renderItemActions?.(item)}
                  </div>
                  {onSelectItem && (
                    <Button
                      className="mt-3"
                      size="sm"
                      variant="secondary"
                      disabled={disabled}
                      onClick={() => onSelectItem(item)}
                    >
                      Edit session
                    </Button>
                  )}
                </Card>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
