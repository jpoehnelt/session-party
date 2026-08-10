import type { ReactNode } from "react";
import { cx } from "./cx";

export interface CardProps {
  title?: ReactNode;
  titleLevel?: 2 | 3;
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function Card({ title, titleLevel = 3, footer, children, className }: CardProps) {
  const Title = titleLevel === 2 ? "h2" : "h3";
  return (
    <section
      className={cx(
        "rounded-card border-2 border-line-strong bg-surface shadow-card",
        className,
      )}
    >
      {title != null && (
        <header className="border-b-2 border-line-strong bg-ink px-5 py-3.5 text-on-accent">
          <Title className="text-xs font-black uppercase tracking-[0.12em] text-on-accent">{title}</Title>
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
