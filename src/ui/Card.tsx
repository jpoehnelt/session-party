import type { ReactNode } from "react";
import { cx } from "./cx";

export interface CardProps {
  title?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function Card({ title, footer, children, className }: CardProps) {
  return (
    <section
      className={cx(
        "rounded-card border border-line bg-surface shadow-card",
        className,
      )}
    >
      {title != null && (
        <header className="border-b border-line px-5 py-4">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
        </header>
      )}
      <div className="px-5 py-4">{children}</div>
      {footer != null && (
        <footer className="rounded-b-card border-t border-line bg-surface-muted/60 px-5 py-3">
          {footer}
        </footer>
      )}
    </section>
  );
}
