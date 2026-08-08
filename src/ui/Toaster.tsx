import { useSyncExternalStore } from "react";
import { IconButton } from "./Button";
import { cx } from "./cx";
import { XIcon } from "./icons";

export type ToastTone = "neutral" | "success" | "warning" | "danger";

export interface ToastOptions {
  tone?: ToastTone;
  duration?: number;
}

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

let nextId = 0;
let snapshot: ToastItem[] = [];
const listeners = new Set<() => void>();
const EMPTY_SNAPSHOT: ToastItem[] = [];

function emit() {
  for (const listener of listeners) listener();
}

function dismiss(id: number) {
  snapshot = snapshot.filter((item) => item.id !== id);
  emit();
}

/** Publish a toast from anywhere — no provider or context required. */
export function toast(message: string, options: ToastOptions = {}): number {
  const id = ++nextId;
  snapshot = [...snapshot, { id, message, tone: options.tone ?? "neutral" }];
  emit();
  globalThis.setTimeout(() => dismiss(id), options.duration ?? 4_500);
  return id;
}

const TONES: Record<ToastTone, string> = {
  neutral: "border-line-strong bg-surface text-ink",
  success: "border-success/20 bg-success-soft text-success",
  warning: "border-warning/20 bg-warning-soft text-warning",
  danger: "border-danger/20 bg-danger-soft text-danger",
};

export function Toaster() {
  const items = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => EMPTY_SNAPSHOT,
  );

  return (
    <div
      aria-live="polite"
      aria-relevant="additions removals"
      className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex flex-col items-end gap-2 sm:inset-x-auto sm:right-5 sm:w-96"
    >
      {items.map((item) => (
        <div
          key={item.id}
          role={item.tone === "danger" ? "alert" : "status"}
          className={cx(
            "pointer-events-auto flex w-full animate-slide-up items-start gap-3 rounded-control border px-4 py-3 shadow-pop",
            TONES[item.tone],
          )}
        >
          <p className="min-w-0 flex-1 pt-0.5 text-sm leading-snug">{item.message}</p>
          <IconButton
            aria-label="Dismiss notification"
            size="sm"
            variant="ghost"
            onClick={() => dismiss(item.id)}
            className="-mr-2 -mt-1 size-7 text-current"
          >
            <XIcon />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
