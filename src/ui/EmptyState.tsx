import type { ReactNode } from "react";
import { cx } from "./cx";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cx(
        "flex flex-col items-start py-10 text-left sm:items-center sm:text-center",
        className,
      )}
    >
      {icon != null && (
        <div className="mb-4 flex size-10 items-center justify-center rounded-control border border-line bg-surface-muted text-ink-faint [&>svg]:size-5">
          {icon}
        </div>
      )}
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      {description && (
        <p className="mt-1 max-w-sm text-sm leading-relaxed text-ink-faint">{description}</p>
      )}
      {action != null && <div className="mt-5">{action}</div>}
    </div>
  );
}
