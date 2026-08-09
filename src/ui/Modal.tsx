import { Dialog } from "radix-ui";
import type { ReactNode } from "react";
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
  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 animate-fade-in bg-ink/40 motion-reduce:animate-none" />
        <div className="pointer-events-none fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pt-[10vh] sm:p-8 sm:pt-[12vh]">
          <Dialog.Content
            aria-describedby={undefined}
            className={cx(
              "pointer-events-auto relative w-full animate-slide-up rounded-card border border-line bg-surface shadow-pop outline-none motion-reduce:animate-none",
              SIZES[size],
            )}
          >
            <header className="flex items-center justify-between gap-4 px-5 pb-3 pt-4">
              <Dialog.Title className="text-base font-semibold text-ink">{title}</Dialog.Title>
              <Dialog.Close asChild>
                <IconButton aria-label="Close" size="sm" className="-mr-1.5 min-h-11 min-w-11">
                  <XIcon />
                </IconButton>
              </Dialog.Close>
            </header>
            <div className="px-5 pb-5">{children}</div>
            {footer != null && (
              <footer className="flex items-center justify-end gap-2 rounded-b-card border-t border-line bg-surface-muted/60 px-5 py-3.5">
                {footer}
              </footer>
            )}
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
