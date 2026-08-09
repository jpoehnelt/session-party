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
      <div className="flex items-center gap-3 border-2 border-line-strong bg-production-lime px-3 py-2.5 text-sm font-semibold text-ink shadow-[3px_3px_0_#171714]" role="status">
        <Badge tone="success">Clear</Badge>
        <span>No speaker or room overlaps. The board is ready to roll.</span>
      </div>
    );
  }

  const roomCount = conflicts.filter(({ kind }) => kind === "room_overlap").length;
  const speakerCount = conflicts.length - roomCount;

  return (
    <div
      className={`space-y-2 border-2 border-line-strong p-3 text-sm text-ink shadow-[3px_3px_0_#171714] ${
        blocking ? "bg-production-coral" : "bg-production-yellow"
      }`}
      role={compact ? undefined : blocking ? "alert" : "status"}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={blocking ? "danger" : "warning"}>
          {conflicts.length} {conflicts.length === 1 ? "conflict" : "conflicts"}
        </Badge>
        <span className="font-black uppercase tracking-[0.06em]">
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
