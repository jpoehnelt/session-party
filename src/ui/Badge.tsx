import { cva } from "class-variance-authority";
import type { ReactNode } from "react";
import { cx } from "./cx";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

const badgeVariants = cva(
  "inline-flex items-center gap-1 whitespace-nowrap rounded-control border-2 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em]",
  {
    variants: {
      tone: {
        neutral: "border-line-strong bg-surface-muted text-ink-secondary",
        accent: "border-line-strong bg-accent text-ink",
        success: "border-line-strong bg-success-soft text-ink",
        warning: "border-line-strong bg-warning-soft text-ink",
        danger: "border-line-strong bg-danger-soft text-danger",
      },
    },
    defaultVariants: {
      tone: "neutral",
    },
  },
);

export interface BadgeProps {
  tone?: BadgeTone;
  children?: ReactNode;
  className?: string;
}

export function Badge({ tone = "neutral", children, className }: BadgeProps) {
  return <span className={cx(badgeVariants({ tone }), className)}>{children}</span>;
}
