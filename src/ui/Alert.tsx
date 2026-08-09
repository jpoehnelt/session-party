import { cva } from "class-variance-authority";
import type { ComponentPropsWithRef } from "react";
import { cx } from "./cx";

export type AlertTone = "neutral" | "success" | "warning" | "danger";

const alertVariants = cva("relative w-full rounded-control border px-4 py-3 text-sm", {
  variants: {
    tone: {
      neutral: "border-line-strong bg-surface text-ink",
      success: "border-success/20 bg-success-soft text-success",
      warning: "border-warning/20 bg-warning-soft text-warning",
      danger: "border-danger/20 bg-danger-soft text-danger",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export interface AlertProps extends ComponentPropsWithRef<"div"> {
  tone?: AlertTone;
}

export function Alert({ tone = "neutral", className, role = "alert", ...props }: AlertProps) {
  return <div role={role} className={cx(alertVariants({ tone }), className)} {...props} />;
}

export type AlertTitleProps = ComponentPropsWithRef<"h5">;
export function AlertTitle({ className, ...props }: AlertTitleProps) {
  return <h5 className={cx("mb-1 font-semibold leading-none tracking-tight", className)} {...props} />;
}

export type AlertDescriptionProps = ComponentPropsWithRef<"div">;
export function AlertDescription({ className, ...props }: AlertDescriptionProps) {
  return <div className={cx("text-sm leading-relaxed [&_p]:leading-relaxed", className)} {...props} />;
}
