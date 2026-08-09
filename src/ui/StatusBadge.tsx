import type { ReactNode } from "react";
import { Badge, type BadgeTone } from "./Badge";
import { cx } from "./cx";

export type StatusState =
  | "draft"
  | "open"
  | "closed"
  | "pending"
  | "accepted"
  | "declined"
  | "confirmed"
  | "cancelled"
  | "published"
  | "idle"
  | "syncing"
  | "synced"
  | "reconnecting"
  | "offline"
  | "error"
  | "complete";

const STATUS: Record<StatusState, { label: string; tone: BadgeTone }> = {
  draft: { label: "Draft", tone: "neutral" },
  open: { label: "Open", tone: "success" },
  closed: { label: "Closed", tone: "neutral" },
  pending: { label: "Pending", tone: "warning" },
  accepted: { label: "Accepted", tone: "success" },
  declined: { label: "Declined", tone: "danger" },
  confirmed: { label: "Confirmed", tone: "success" },
  cancelled: { label: "Cancelled", tone: "danger" },
  published: { label: "Published", tone: "success" },
  idle: { label: "Ready", tone: "neutral" },
  syncing: { label: "Syncing", tone: "accent" },
  synced: { label: "Synced", tone: "success" },
  reconnecting: { label: "Reconnecting", tone: "warning" },
  offline: { label: "Offline", tone: "danger" },
  error: { label: "Needs attention", tone: "danger" },
  complete: { label: "Complete", tone: "success" },
};

export interface StatusBadgeProps {
  state: StatusState;
  label?: ReactNode;
  description?: string;
  timestamp?: string;
  className?: string;
}

export function StatusBadge({
  state,
  label,
  description,
  timestamp,
  className,
}: StatusBadgeProps) {
  const presentation = STATUS[state];
  const details = [description, timestamp].filter(Boolean).join(" · ");
  return (
    <Badge
      tone={presentation.tone}
      className={cx("gap-1.5", className)}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      <span>{label ?? presentation.label}</span>
      {details && <span className="sr-only"> — {details}</span>}
    </Badge>
  );
}
