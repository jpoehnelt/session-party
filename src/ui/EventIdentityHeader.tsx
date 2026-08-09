import type { ReactNode } from "react";
import { Avatar } from "./Avatar";
import { PageHeader } from "./layout";

export interface EventIdentity {
  name: string;
  slug?: string;
  timezone?: string;
  location?: string;
  coverUrl?: string;
}

export interface EventIdentityHeaderProps {
  event: EventIdentity;
  description?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function EventIdentityHeader({
  event,
  description,
  status,
  actions,
  className,
}: EventIdentityHeaderProps) {
  const metadata = [event.location, event.timezone].filter(Boolean).join(" · ");
  return (
    <PageHeader
      className={className}
      title={(
        <span className="flex items-center gap-3">
          <Avatar name={event.name} src={event.coverUrl} size="lg" />
          <span className="min-w-0 truncate">{event.name}</span>
          {status}
        </span>
      )}
      description={description ?? (metadata || undefined)}
      actions={actions}
    />
  );
}
