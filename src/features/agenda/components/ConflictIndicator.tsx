import { Badge } from "@/ui";
import type { AgendaConflict } from "../schema";

export interface ConflictIndicatorProps {
  readonly conflicts: readonly AgendaConflict[];
  readonly compact?: boolean;
  readonly blocking?: boolean;
}

export function ConflictIndicator({
  conflicts,
  compact = false,
  blocking = true,
}: ConflictIndicatorProps) {
  if (conflicts.length === 0) {
    return compact ? null : (
      <div className="flex items-center gap-2 text-sm text-ink-secondary" role="status">
        <Badge tone="success">Clear</Badge>
        <span>No speaker or room overlaps.</span>
      </div>
    );
  }

  const roomCount = conflicts.filter(({ kind }) => kind === "room_overlap").length;
  const speakerCount = conflicts.length - roomCount;

  return (
    <div
      className="space-y-2 rounded-control border border-warning/30 bg-warning-soft p-3 text-sm text-ink"
      role={compact ? undefined : blocking ? "alert" : "status"}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={blocking ? "danger" : "warning"}>
          {conflicts.length} {conflicts.length === 1 ? "conflict" : "conflicts"}
        </Badge>
        <span className="font-medium">
          {[
            roomCount > 0 ? `${roomCount} room` : null,
            speakerCount > 0 ? `${speakerCount} speaker` : null,
          ].filter(Boolean).join(" · ")}
        </span>
      </div>
      {!compact && (
        <ul className="list-disc space-y-1 pl-5">
          {conflicts.map((conflict) => (
            <li key={`${conflict.kind}:${conflict.talkIds.join(":")}:${conflict.roomId ?? conflict.speakerId ?? ""}`}>
              {conflict.explanation}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
