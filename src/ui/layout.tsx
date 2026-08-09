import type { ReactNode } from "react";
import { cx } from "./cx";

export interface AppShellProps {
  sidebar: ReactNode;
  sidebarClassName?: string;
  topbar?: ReactNode;
  contentWidth?: ContentWidth;
  children: ReactNode;
}

export type ContentWidth = "compact" | "standard" | "wide" | "canvas";

const contentWidthClass: Record<ContentWidth, string> = {
  compact: "max-w-6xl",
  standard: "max-w-[90rem]",
  wide: "max-w-[100rem]",
  canvas: "max-w-[110rem]",
};

export function AppShell({ sidebar, sidebarClassName, topbar, contentWidth = "standard", children }: AppShellProps) {
  return (
    <div className="min-h-dvh bg-canvas text-ink lg:grid lg:h-dvh lg:grid-cols-[16.5rem_minmax(0,1fr)] lg:overflow-hidden">
      <aside
        className={cx(
          "border-b-2 border-line-strong bg-ink text-on-accent lg:sticky lg:top-0 lg:h-dvh lg:overflow-y-auto lg:border-b-0 lg:border-r-2",
          sidebarClassName,
        )}
      >
        {sidebar}
      </aside>
      <div className="min-w-0 lg:flex lg:h-dvh lg:flex-col lg:overflow-hidden">
        {topbar != null && (
          <header className="sticky top-0 z-20 shrink-0 border-b-2 border-line-strong bg-canvas/95 px-4 py-2.5 backdrop-blur-sm sm:px-6 lg:px-8">
            {topbar}
          </header>
        )}
        <main id="main-content" tabIndex={-1} className="production-grid min-w-0 flex-1 overflow-y-auto">
          <div className={cx("mx-auto w-full px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10", contentWidthClass[contentWidth])}>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <header
      className={cx(
        "mb-8 flex flex-col gap-5 border-b-2 border-line-strong pb-6 sm:flex-row sm:items-end sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-4xl font-black leading-[0.92] tracking-[-0.055em] text-ink sm:text-5xl">
          {title}
        </h1>
        {description != null && (
          <p className="mt-3 max-w-2xl text-sm font-semibold leading-relaxed text-ink-secondary sm:text-[15px]">
            {description}
          </p>
        )}
      </div>
      {actions != null && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      )}
    </header>
  );
}
