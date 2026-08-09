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
        "flex flex-col items-start border-2 border-dashed border-line-strong bg-surface/75 p-7 text-left sm:items-center sm:p-10 sm:text-center",
        className,
      )}
    >
      {icon != null && (
        <div className="mb-4 flex size-11 items-center justify-center rounded-control border-2 border-line-strong bg-production-lime text-ink shadow-[3px_3px_0_#171714] [&>svg]:size-5">
          {icon}
        </div>
      )}
      <h3 className="text-xl font-black tracking-[-0.03em] text-ink">{title}</h3>
      {description && (
        <p className="mt-2 max-w-sm text-sm font-medium leading-relaxed text-ink-faint">{description}</p>
      )}
      {action != null && <div className="mt-5">{action}</div>}
    </div>
  );
}
