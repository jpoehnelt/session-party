import type { ReactNode } from "react";

export const productionCardClass =
  "rounded-none border-2 border-[#171714] bg-[#fffdf7] shadow-[6px_6px_0_#171714] [&>header]:border-[#171714] [&>header]:bg-[#ece8dc] [&>header]:text-[#171714] [&>header_h3]:font-black [&>header_h3]:uppercase [&>header_h3]:tracking-[0.1em] [&>header_h3]:text-[#171714] [&>div]:p-5 sm:[&>div]:p-6";

export const productionFormClass =
  "[&_input]:rounded-none [&_input]:border-[#171714] [&_input]:bg-[#fffdf7] [&_input]:focus:ring-[#7857ff] [&_select]:rounded-none [&_select]:border-[#171714] [&_select]:bg-[#fffdf7] [&_select]:focus:ring-[#7857ff] [&_textarea]:rounded-none [&_textarea]:border-[#171714] [&_textarea]:bg-[#fffdf7] [&_textarea]:focus:ring-[#7857ff] [&_label]:font-bold [&_label]:text-[#171714]";

export const productionTableClass =
  "[&>div]:rounded-none [&>div]:border-2 [&>div]:border-[#171714] [&>div]:bg-[#fffdf7] [&>div]:shadow-[6px_6px_0_#171714] [&_thead_tr]:border-[#171714] [&_thead_tr]:bg-[#171714] [&_th]:py-3 [&_th]:font-black [&_th]:tracking-[0.12em] [&_th]:text-white [&_tbody]:divide-[#171714]/25 [&_td]:py-4 [&_tr]:hover:bg-[#ece8dc]";

export const productionButtonClass =
  "rounded-none border-2 border-[#171714] font-black uppercase tracking-[0.06em] shadow-[3px_3px_0_#171714] transition-transform hover:-translate-y-0.5 focus-visible:ring-[#7857ff]";

interface ProductionHeaderProps {
  readonly eyebrow: string;
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly actions?: ReactNode;
  readonly accent?: "purple" | "lime" | "coral" | "sky";
}

const accentClass = {
  purple: "bg-[#896aff] text-[#171714]",
  lime: "bg-[#caff4a] text-[#171714]",
  coral: "bg-[#ff714f] text-[#171714]",
  sky: "bg-[#8fdcff] text-[#171714]",
} as const;

export function ProductionHeader({
  eyebrow,
  title,
  description,
  actions,
  accent = "purple",
}: ProductionHeaderProps) {
  return (
    <header className="relative overflow-hidden border-[3px] border-[#171714] bg-[#fffdf7] px-5 py-6 shadow-[8px_8px_0_#171714] sm:px-7 sm:py-8">
      <div
        aria-hidden="true"
        className={`absolute right-0 top-0 h-full w-3 sm:w-5 ${accentClass[accent]}`}
      />
      <div className="relative flex flex-col gap-5 pr-3 sm:flex-row sm:items-end sm:justify-between sm:pr-5">
        <div className="min-w-0">
          <p className={`inline-block border-2 border-[#171714] px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.16em] shadow-[3px_3px_0_#171714] ${accentClass[accent]}`}>
            {eyebrow}
          </p>
          <h1 className="mt-5 max-w-4xl text-4xl font-black leading-[0.92] tracking-[-0.055em] text-[#171714] sm:text-5xl">
            {title}
          </h1>
          <p className="mt-4 max-w-3xl text-sm font-semibold leading-6 text-[#4f4a40] sm:text-base">
            {description}
          </p>
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

interface ProductionStatProps {
  readonly label: string;
  readonly value: ReactNode;
  readonly tone?: "paper" | "purple" | "lime" | "coral" | "sky";
}

const statToneClass = {
  paper: "bg-[#fffdf7] text-[#171714]",
  purple: "bg-[#ece8dc] text-[#171714]",
  lime: "bg-[#ece8dc] text-[#171714]",
  coral: "bg-[#ece8dc] text-[#171714]",
  sky: "bg-[#ece8dc] text-[#171714]",
} as const;

export function ProductionStats({ stats }: { readonly stats: readonly ProductionStatProps[] }) {
  return (
    <dl className="grid border-2 border-[#171714] bg-[#171714] shadow-[6px_6px_0_#7857ff] sm:grid-flow-col sm:auto-cols-fr">
      {stats.map((stat, index) => (
        <div
          className={`px-4 py-4 sm:px-5 ${index > 0 ? "border-t-2 border-[#171714] sm:border-l-2 sm:border-t-0" : ""} ${statToneClass[stat.tone ?? "paper"]}`}
          key={stat.label}
        >
          <dt className="text-[10px] font-black uppercase tracking-[0.14em] opacity-65">{stat.label}</dt>
          <dd className="mt-1 text-3xl font-black tracking-[-0.06em]">{stat.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ProductionSectionLabel({ children }: { readonly children: ReactNode }) {
  return (
    <div className="mb-4 flex items-center gap-3">
      <span aria-hidden="true" className="size-3 rotate-45 bg-[#7857ff]" />
      <h2 className="text-xs font-black uppercase tracking-[0.16em] text-[#171714]">{children}</h2>
      <span aria-hidden="true" className="h-0.5 flex-1 bg-[#171714]" />
    </div>
  );
}

export function ProductionBareFrame({ children }: { readonly children: ReactNode }) {
  return (
    <main className="relative min-h-dvh overflow-hidden bg-[#f3efe3] px-4 py-8 text-[#171714] sm:px-6 sm:py-10 lg:px-8">
      <div
        className="pointer-events-none absolute inset-0 opacity-30 [background-image:linear-gradient(#b9b1a1_1px,transparent_1px),linear-gradient(90deg,#b9b1a1_1px,transparent_1px)] [background-size:44px_44px]"
        aria-hidden="true"
      />
      <div className="relative mx-auto max-w-7xl">{children}</div>
    </main>
  );
}
