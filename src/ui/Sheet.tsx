import { useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./Button";
import { cx } from "./cx";
import { XIcon } from "./icons";
import { useOverlay } from "./overlay";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children?: ReactNode;
  footer?: ReactNode;
  /** Panel width. Defaults to "md" (~28rem). */
  size?: "md" | "lg";
}

const SIZES = { md: "max-w-md", lg: "max-w-xl" } as const;

export function Sheet({ open, onClose, title, children, footer, size = "md" }: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useOverlay(open, onClose, panelRef);
  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50">
      <div
        className="fixed inset-0 animate-fade-in bg-ink/40"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cx(
          "fixed inset-y-0 right-0 flex w-full animate-slide-in-right flex-col bg-surface shadow-sheet outline-none",
          SIZES[size],
        )}
      >
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-line px-5 py-4">
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          <IconButton aria-label="Close" size="sm" onClick={onClose} className="-mr-1.5">
            <XIcon />
          </IconButton>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer != null && (
          <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-surface-muted/60 px-5 py-3.5">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
