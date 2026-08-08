import { cx } from "./cx";

const SIZES = {
  sm: "size-6 text-[10px]",
  md: "size-8 text-xs",
  lg: "size-12 text-base",
} as const;

/** Muted tonal pairs picked deterministically from the name. */
const HUES = [
  "bg-accent-soft text-accent-deep",
  "bg-success-soft text-success",
  "bg-warning-soft text-warning",
  "bg-surface-muted text-ink-secondary",
  "bg-danger-soft text-danger",
] as const;

export interface AvatarProps {
  name: string;
  src?: string;
  size?: keyof typeof SIZES;
  className?: string;
}

export function Avatar({ name, src, size = "md", className }: AvatarProps) {
  if (src) {
    return (
      <img
        src={src}
        alt={name}
        className={cx(
          "shrink-0 rounded-full border border-line object-cover",
          SIZES[size],
          className,
        )}
      />
    );
  }

  const initials =
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0]?.toUpperCase() ?? "")
      .join("") || "?";
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  const hue = HUES[Math.abs(hash) % HUES.length];

  return (
    <span
      role="img"
      aria-label={name}
      className={cx(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold",
        SIZES[size],
        hue,
        className,
      )}
    >
      {initials}
    </span>
  );
}
