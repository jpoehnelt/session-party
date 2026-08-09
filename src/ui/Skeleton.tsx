import { cx } from "./cx";

export interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cx("animate-pulse rounded-control border-2 border-line-strong bg-surface-muted shadow-[3px_3px_0_#171714]", className)}
    />
  );
}
