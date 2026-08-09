import type { ReactNode } from "react";
import { cx } from "./cx";

export interface AppShellProps {
  sidebar: ReactNode;
  sidebarClassName?: string;
  topbar?: ReactNode;
  children: ReactNode;
}

export function AppShell({ sidebar, sidebarClassName, topbar, children }: AppShellProps) {
  return (
    <div className="min-h-dvh bg-canvas text-ink lg:grid lg:h-dvh lg:grid-cols-[15rem_minmax(0,1fr)] lg:overflow-hidden">
      <aside
        className={cx(
          "border-b border-line bg-surface lg:sticky lg:top-0 lg:h-dvh lg:overflow-y-auto lg:border-b-0 lg:border-r",
          sidebarClassName,
        )}
      >
        {sidebar}
      </aside>
      <div className="min-w-0 lg:flex lg:h-dvh lg:flex-col lg:overflow-hidden">
        {topbar != null && (
          <header className="sticky top-0 z-20 shrink-0 border-b border-line bg-canvas/95 px-4 py-3 backdrop-blur-sm sm:px-6 lg:px-8">
            {topbar}
          </header>
        )}
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10">
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
        "mb-7 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-[-0.025em] text-ink sm:text-3xl">
          {title}
        </h1>
        {description != null && (
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-secondary sm:text-[15px]">
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
