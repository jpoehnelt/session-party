import { AlertDialog as Primitive } from "radix-ui";
import type { ComponentPropsWithRef } from "react";
import { cx } from "./cx";

export const AlertDialog = Primitive.Root;
export const AlertDialogTrigger = Primitive.Trigger;
export const AlertDialogPortal = Primitive.Portal;

export type AlertDialogOverlayProps = ComponentPropsWithRef<typeof Primitive.Overlay>;
export function AlertDialogOverlay({ className, ...props }: AlertDialogOverlayProps) {
  return <Primitive.Overlay className={cx("fixed inset-0 z-50 animate-fade-in bg-ink/40", className)} {...props} />;
}

export type AlertDialogContentProps = ComponentPropsWithRef<typeof Primitive.Content>;
export function AlertDialogContent({ className, ...props }: AlertDialogContentProps) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <Primitive.Content
        className={cx("fixed left-1/2 top-1/2 z-50 grid w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 rounded-card border border-line bg-surface p-6 shadow-pop outline-none", className)}
        {...props}
      />
    </AlertDialogPortal>
  );
}

export type AlertDialogHeaderProps = ComponentPropsWithRef<"div">;
export function AlertDialogHeader({ className, ...props }: AlertDialogHeaderProps) {
  return <div className={cx("flex flex-col gap-2 text-center sm:text-left", className)} {...props} />;
}

export type AlertDialogFooterProps = ComponentPropsWithRef<"div">;
export function AlertDialogFooter({ className, ...props }: AlertDialogFooterProps) {
  return <div className={cx("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />;
}

export type AlertDialogTitleProps = ComponentPropsWithRef<typeof Primitive.Title>;
export function AlertDialogTitle({ className, ...props }: AlertDialogTitleProps) {
  return <Primitive.Title className={cx("text-lg font-semibold text-ink", className)} {...props} />;
}

export type AlertDialogDescriptionProps = ComponentPropsWithRef<typeof Primitive.Description>;
export function AlertDialogDescription({ className, ...props }: AlertDialogDescriptionProps) {
  return <Primitive.Description className={cx("text-sm leading-relaxed text-ink-secondary", className)} {...props} />;
}

export type AlertDialogActionProps = ComponentPropsWithRef<typeof Primitive.Action>;
export function AlertDialogAction({ className, ...props }: AlertDialogActionProps) {
  return <Primitive.Action className={cx("inline-flex h-10 items-center justify-center rounded-control bg-danger px-4 text-sm font-medium text-on-accent outline-none hover:bg-danger-hover focus-visible:ring-2 focus-visible:ring-danger/40 focus-visible:ring-offset-2", className)} {...props} />;
}

export type AlertDialogCancelProps = ComponentPropsWithRef<typeof Primitive.Cancel>;
export function AlertDialogCancel({ className, ...props }: AlertDialogCancelProps) {
  return <Primitive.Cancel className={cx("inline-flex h-10 items-center justify-center rounded-control border border-line-strong bg-surface px-4 text-sm font-medium text-ink outline-none hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2", className)} {...props} />;
}
