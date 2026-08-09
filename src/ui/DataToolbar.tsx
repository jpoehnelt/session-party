import type { ReactNode } from "react";
import { cx } from "./cx";

export interface FilterBarProps {
  children: ReactNode;
  label?: string;
  actions?: ReactNode;
  className?: string;
}

export function FilterBar({
  children,
  label = "Filters",
  actions,
  className,
}: FilterBarProps) {
  return (
    <section
      aria-label={label}
      className={cx(
        "flex flex-col gap-3 rounded-card border border-line bg-surface p-4 sm:flex-row sm:items-end sm:justify-between",
        className,
      )}
    >
      <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {children}
      </div>
      {actions != null && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </section>
  );
}

export interface DataToolbarProps {
  children?: ReactNode;
  selectionCount?: number;
  primaryActions?: ReactNode;
  secondaryActions?: ReactNode;
  className?: string;
}

export function DataToolbar({
  children,
  selectionCount = 0,
  primaryActions,
  secondaryActions,
  className,
}: DataToolbarProps) {
  return (
    <div
      role="toolbar"
      aria-label="Data actions"
      className={cx(
        "flex min-h-12 flex-col gap-3 rounded-control border border-line bg-surface px-3 py-2 sm:flex-row sm:items-center",
        className,
      )}
    >
      <div className="min-w-0 flex-1 text-sm text-ink-secondary">
        {selectionCount > 0 ? `${selectionCount} selected` : children}
      </div>
      {secondaryActions != null && (
        <div className="flex flex-wrap items-center gap-2">{secondaryActions}</div>
      )}
      {selectionCount > 0 && primaryActions != null && (
        <div className="flex flex-wrap items-center gap-2">{primaryActions}</div>
      )}
    </div>
  );
}
