import { cva } from "class-variance-authority";
import type { ComponentPropsWithRef } from "react";
import { cx } from "./cx";

export type AlertTone = "neutral" | "success" | "warning" | "danger";

const alertVariants = cva("relative w-full rounded-control border-2 border-line-strong px-4 py-3 text-sm font-medium shadow-[3px_3px_0_#171714]", {
  variants: {
    tone: {
      neutral: "bg-surface text-ink",
      success: "bg-success-soft text-ink",
      warning: "bg-warning-soft text-ink",
      danger: "bg-danger-soft text-danger",
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
  return <h5 className={cx("mb-1 font-black uppercase leading-none tracking-[0.08em]", className)} {...props} />;
}

export type AlertDescriptionProps = ComponentPropsWithRef<"div">;
export function AlertDescription({ className, ...props }: AlertDescriptionProps) {
  return <div className={cx("text-sm leading-relaxed [&_p]:leading-relaxed", className)} {...props} />;
}
