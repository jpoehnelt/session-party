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
          <dt className="text-[10px] font-black uppercase tracking-[0.1em] text-ink-faint">Adapter</dt>
          <dd className="mt-1 font-black text-ink">{adapterMode === "live" ? "Live connection" : "Demo adapter"}</dd>
        </div>
        <div>
          <dt className="text-[10px] font-black uppercase tracking-[0.1em] text-ink-faint">Last confirmed</dt>
          <dd className="mt-1 text-ink-secondary">
            {lastSyncedAt ? <time dateTime={lastSyncedAt}>{lastSyncedAt}</time> : "Not synced yet"}
          </dd>
        </div>
      </dl>
      {error && (
        <p role="alert" className="mt-4 rounded-control border-2 border-line-strong bg-danger-soft px-3 py-2 text-sm font-bold text-danger shadow-[3px_3px_0_#171714]">
          {error}
        </p>
      )}
    </Card>
  );
}
