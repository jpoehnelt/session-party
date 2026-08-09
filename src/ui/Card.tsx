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
        "rounded-card border-2 border-line-strong bg-surface shadow-card",
        className,
      )}
    >
      {title != null && (
        <header className="border-b-2 border-line-strong bg-ink px-5 py-3.5 text-on-accent">
          <h3 className="text-xs font-black uppercase tracking-[0.12em] text-on-accent">{title}</h3>
        </header>
      )}
      <div className="px-5 py-4">{children}</div>
      {footer != null && (
        <footer className="rounded-b-card border-t-2 border-line-strong bg-surface-muted px-5 py-3">
          {footer}
        </footer>
      )}
    </section>
  );
}
