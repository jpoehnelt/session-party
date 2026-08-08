import { useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./Button";
import { cx } from "./cx";
import { XIcon } from "./icons";
import { useOverlay } from "./overlay";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children?: ReactNode;
  footer?: ReactNode;
  /** Panel width. Defaults to "md" (~32rem). */
  size?: "sm" | "md" | "lg";
}

const SIZES = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl" } as const;

export function Modal({ open, onClose, title, children, footer, size = "md" }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useOverlay(open, onClose, panelRef);
  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div
        className="fixed inset-0 animate-fade-in bg-ink/40"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="flex min-h-full items-start justify-center p-4 pt-[10vh] sm:p-8 sm:pt-[12vh]">
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          tabIndex={-1}
          className={cx(
            "relative w-full animate-slide-up rounded-card border border-line bg-surface shadow-pop outline-none",
            SIZES[size],
          )}
        >
          <header className="flex items-center justify-between gap-4 px-5 pb-3 pt-4">
            <h2 className="text-base font-semibold text-ink">{title}</h2>
            <IconButton aria-label="Close" size="sm" onClick={onClose} className="-mr-1.5">
              <XIcon />
            </IconButton>
          </header>
          <div className="px-5 pb-5">{children}</div>
          {footer != null && (
            <footer className="flex items-center justify-end gap-2 rounded-b-card border-t border-line bg-surface-muted/60 px-5 py-3.5">
              {footer}
            </footer>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
