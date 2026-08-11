import { Dialog } from "radix-ui";
import { useRef, type ReactNode } from "react";
import { IconButton } from "./Button";
import { cx } from "./cx";
import { XIcon } from "./icons";

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
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  if (open && !wasOpenRef.current && typeof document !== "undefined") {
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  }
  wasOpenRef.current = open;

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 animate-fade-in bg-ink/40 motion-reduce:animate-none" />
        <div className="pointer-events-none fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pt-[10vh] sm:p-8 sm:pt-[12vh]">
          <Dialog.Content
            aria-modal="true"
            aria-describedby={undefined}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const returnFocus = returnFocusRef.current;
              requestAnimationFrame(() => returnFocus?.focus());
            }}
            className={cx(
              "pointer-events-auto relative w-full animate-slide-up rounded-card border-2 border-line-strong bg-surface shadow-pop outline-none motion-reduce:animate-none",
              SIZES[size],
            )}
          >
            <header className="flex items-center justify-between gap-4 border-b-2 border-line-strong bg-ink px-5 py-3 text-on-accent">
              <Dialog.Title className="text-sm font-black uppercase tracking-[0.1em] text-on-accent">{title}</Dialog.Title>
              <Dialog.Close asChild>
                <IconButton aria-label="Close" size="sm" className="-mr-1.5 min-h-11 min-w-11 text-on-accent hover:bg-white/10 hover:text-on-accent">
                  <XIcon />
                </IconButton>
              </Dialog.Close>
            </header>
            <div className="px-5 py-5">{children}</div>
            {footer != null && (
              <footer className="flex items-center justify-end gap-2 rounded-b-card border-t-2 border-line-strong bg-surface-muted px-5 py-3.5">
                {footer}
              </footer>
            )}
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
