import { Dialog } from "radix-ui";
import type { ReactNode } from "react";
import { IconButton } from "./Button";
import { cx } from "./cx";
import { XIcon } from "./icons";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  id?: string;
  children?: ReactNode;
  footer?: ReactNode;
  /** Panel width. Defaults to "md" (~28rem). */
  size?: "md" | "lg";
}

const SIZES = { md: "max-w-md", lg: "max-w-xl" } as const;

export function Sheet({ open, onClose, title, id, children, footer, size = "md" }: SheetProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 animate-fade-in bg-ink/40 motion-reduce:animate-none" />
        <Dialog.Content
          aria-modal="true"
          id={id}
          aria-describedby={undefined}
          className={cx(
            "fixed inset-y-0 right-0 z-50 flex w-full animate-slide-in-right flex-col border-l-2 border-line-strong bg-surface shadow-sheet outline-none motion-reduce:animate-none",
            SIZES[size],
          )}
        >
          <header className="flex shrink-0 items-center justify-between gap-4 border-b-2 border-line-strong bg-ink px-5 py-4 text-on-accent">
            <Dialog.Title className="text-sm font-black uppercase tracking-[0.1em] text-on-accent">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <IconButton aria-label="Close" size="sm" className="-mr-1.5 min-h-11 min-w-11 text-on-accent hover:bg-white/10 hover:text-on-accent">
                <XIcon />
              </IconButton>
            </Dialog.Close>
          </header>
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer != null && (
            <footer className="flex shrink-0 items-center justify-end gap-2 border-t-2 border-line-strong bg-surface-muted px-5 py-3.5">
              {footer}
            </footer>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
