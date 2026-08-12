import { useId } from "react";
import { Checkbox } from "./fields";
import { StatusBadge, type StatusState } from "./StatusBadge";
import { cx } from "./cx";

export interface ReadinessStep {
  id: string;
  label: string;
  state: Extract<StatusState, "pending" | "complete" | "error">;
  description?: string;
  timestamp?: string;
}

export interface ReadinessThreadProps {
  items: readonly ReadinessStep[];
  currentId?: string;
  compact?: boolean;
  className?: string;
}

export function ReadinessThread({
  items,
  currentId,
  compact = false,
  className,
}: ReadinessThreadProps) {
  return (
    <ol className={cx("space-y-0", className)} aria-label="Speaker readiness">
      {items.map((item, index) => (
        <li
          key={item.id}
          aria-current={item.id === currentId ? "step" : undefined}
          className="relative grid grid-cols-[1.25rem_minmax(0,1fr)] gap-3 pb-4 last:pb-0"
        >
          {index < items.length - 1 && (
            <span aria-hidden="true" className="absolute left-[0.6rem] top-5 h-[calc(100%-0.25rem)] w-0.5 bg-line-strong" />
          )}
          <span
            aria-hidden="true"
            className={cx(
              "relative z-10 mt-1 size-5 rounded-control border-2 bg-surface",
              item.state === "complete" && "border-success bg-success",
              item.state === "error" && "border-danger bg-danger",
              item.state === "pending" && "border-line-strong",
            )}
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-black text-ink">{item.label}</span>
              <StatusBadge state={item.state} timestamp={item.timestamp} />
            </div>
            {!compact && item.description && (
              <p className="mt-1 text-sm text-ink-secondary">{item.description}</p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

export interface ProgressChecklistItem {
  id: string;
  label: string;
  description?: string;
  completed: boolean;
  disabled?: boolean;
}

export interface ProgressChecklistProps {
  items: readonly ProgressChecklistItem[];
  onToggle?: (id: string, completed: boolean) => void;
  readOnly?: boolean;
  showProgress?: boolean;
  className?: string;
}

export function ProgressChecklist({
  items,
  onToggle,
  readOnly = false,
  showProgress = true,
  className,
}: ProgressChecklistProps) {
  const headingId = useId();
  const completed = items.filter((item) => item.completed).length;
  return (
    <section className={cx("space-y-3", className)} aria-labelledby={headingId}>
      <div className="flex items-center justify-between gap-3">
        <h3 id={headingId} className="text-xs font-black uppercase tracking-[0.1em] text-ink">Tasks</h3>
        {showProgress && (
          <span className="border-2 border-line-strong bg-production-lime px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.08em] text-ink">{completed} of {items.length} complete</span>
        )}
      </div>
      <div className="space-y-3">
        {items.map((item) => (
          <Checkbox
            key={item.id}
            label={item.label}
            description={item.description}
            checked={item.completed}
            disabled={readOnly || item.disabled || onToggle == null}
            onChange={(event) => onToggle?.(item.id, event.currentTarget.checked)}
          />
        ))}
      </div>
    </section>
  );
}
