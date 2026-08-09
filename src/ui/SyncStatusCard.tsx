import type { ReactNode } from "react";
import { Card } from "./Card";
import { StatusBadge, type StatusState } from "./StatusBadge";

export type SyncAdapterMode = "fake" | "live";
export type SyncState = "idle" | "syncing" | "synced" | "error" | "offline";

export interface SyncStatusCardProps {
  source: string;
  adapterMode: SyncAdapterMode;
  state: SyncState;
  lastSyncedAt?: string;
  error?: string;
  action?: ReactNode;
}

const STATE: Record<SyncState, StatusState> = {
  idle: "idle",
  syncing: "syncing",
  synced: "synced",
  error: "error",
  offline: "offline",
};

export function SyncStatusCard({
  source,
  adapterMode,
  state,
  lastSyncedAt,
  error,
  action,
}: SyncStatusCardProps) {
  return (
    <Card
      title={(
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>{source}</span>
          <StatusBadge state={STATE[state]} />
        </div>
      )}
      footer={action}
    >
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-faint">Adapter</dt>
          <dd className="mt-1 font-medium text-ink">{adapterMode === "live" ? "Live connection" : "Demo adapter"}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-faint">Last confirmed</dt>
          <dd className="mt-1 text-ink-secondary">
            {lastSyncedAt ? <time dateTime={lastSyncedAt}>{lastSyncedAt}</time> : "Not synced yet"}
          </dd>
        </div>
      </dl>
      {error && (
        <p role="alert" className="mt-4 rounded-control border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
    </Card>
  );
}
