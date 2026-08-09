import { Toast } from "radix-ui";
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
  duration: number;
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
  snapshot = [
    ...snapshot,
    {
      id,
      message,
      tone: options.tone ?? "neutral",
      duration: options.duration ?? 4_500,
    },
  ];
  emit();
  return id;
}

const TONES: Record<ToastTone, string> = {
  neutral: "border-line-strong bg-surface text-ink",
  success: "border-line-strong bg-success-soft text-ink",
  warning: "border-line-strong bg-warning-soft text-ink",
  danger: "border-line-strong bg-danger-soft text-danger",
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
    <Toast.Provider swipeDirection="right">
      {items.map((item) => (
        <Toast.Root
          key={item.id}
          open
          duration={item.duration}
          role={item.tone === "danger" ? "alert" : "status"}
          onOpenChange={(nextOpen) => { if (!nextOpen) dismiss(item.id); }}
          className={cx(
            "pointer-events-auto flex w-full animate-slide-up items-start gap-3 rounded-control border-2 px-4 py-3 font-bold shadow-pop motion-reduce:animate-none",
            TONES[item.tone],
          )}
        >
          <Toast.Title asChild>
            <p className="min-w-0 flex-1 pt-0.5 text-sm font-normal leading-snug">{item.message}</p>
          </Toast.Title>
          <Toast.Close asChild>
            <IconButton
              aria-label="Dismiss notification"
              size="sm"
              variant="ghost"
              className="-mr-2 -mt-1 size-7 text-current"
            >
              <XIcon />
            </IconButton>
          </Toast.Close>
        </Toast.Root>
      ))}
      <Toast.Viewport
        aria-label="Notifications"
        className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex max-h-screen flex-col items-end gap-2 outline-none sm:inset-x-auto sm:right-5 sm:w-96"
      />
    </Toast.Provider>
  );
}
