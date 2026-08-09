import { cva } from "class-variance-authority";
import type { ComponentPropsWithRef } from "react";
import { cx } from "./cx";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const buttonVariants = cva(
  "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-control border-2 font-black uppercase tracking-[0.075em] outline-none transition-transform duration-150 hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-3 focus-visible:ring-offset-canvas disabled:pointer-events-none disabled:translate-y-0 disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "border-line-strong bg-accent text-on-accent shadow-button hover:bg-accent-hover",
        secondary: "border-line-strong bg-surface text-ink shadow-button hover:bg-production-sky",
        ghost: "border-transparent text-ink-secondary hover:bg-surface-muted hover:text-ink",
        danger: "border-line-strong bg-production-coral text-ink shadow-button hover:bg-danger-soft",
      },
      size: {
        sm: "h-8 px-3 text-[13px]",
        md: "h-10 px-4 text-sm",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

const iconButtonVariants = cva(
  "inline-flex select-none items-center justify-center whitespace-nowrap rounded-control border-2 font-black outline-none transition-transform duration-150 hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:pointer-events-none disabled:translate-y-0 disabled:opacity-50",
  {
    variants: {
      variant: {
        secondary: "border-line-strong bg-surface text-ink shadow-button hover:bg-production-sky",
        ghost: "border-transparent text-ink-secondary hover:bg-surface-muted hover:text-ink",
      },
      size: {
        sm: "size-8 [&>svg]:size-4",
        md: "size-10 [&>svg]:size-4.5",
      },
    },
    defaultVariants: {
      variant: "ghost",
      size: "md",
    },
  },
);

export interface ButtonProps extends ComponentPropsWithRef<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  disabled,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      data-loading={loading || undefined}
      className={cx(buttonVariants({ variant, size }), className)}
    >
      {loading && <Spinner size="sm" className="-ml-0.5" />}
      {children}
    </button>
  );
}

export interface IconButtonProps extends ComponentPropsWithRef<"button"> {
  /** Required — an icon-only control is meaningless to screen readers without it. */
  "aria-label": string;
  variant?: Extract<ButtonVariant, "secondary" | "ghost">;
  size?: ButtonSize;
}

export function IconButton({
  variant = "ghost",
  size = "md",
  className,
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={cx(iconButtonVariants({ variant, size }), className)}
    />
  );
}
