import type { ComponentPropsWithRef } from "react";
import { cx } from "./cx";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const BASE =
  "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-control font-medium outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:pointer-events-none disabled:opacity-50";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent shadow-xs hover:bg-accent-hover",
  secondary:
    "border border-line-strong bg-surface text-ink shadow-xs hover:bg-surface-muted",
  ghost: "text-ink-secondary hover:bg-surface-muted hover:text-ink",
  danger: "bg-danger text-on-accent shadow-xs hover:bg-danger-hover",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-10 px-4 text-sm",
};

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
      className={cx(BASE, VARIANTS[variant], SIZES[size], className)}
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

const ICON_SIZES: Record<ButtonSize, string> = {
  sm: "size-8 [&>svg]:size-4",
  md: "size-10 [&>svg]:size-4.5",
};

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
      className={cx(BASE, VARIANTS[variant], ICON_SIZES[size], className)}
    />
  );
}
