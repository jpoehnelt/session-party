import { Link } from "react-router";

export const path = "/";
export const layout = "bare";

const workflow = [
  {
    number: "01",
    title: "Collect",
    description: "Publish a routed CFP that keeps every proposal structured from day one.",
  },
  {
    number: "02",
    title: "Review",
    description: "Run focused review rounds with clear assignments, rubrics, and decisions.",
  },
  {
    number: "03",
    title: "Onboard",
    description: "Give accepted speakers one calm place for profiles, files, forms, and tasks.",
  },
  {
    number: "04",
    title: "Schedule",
    description: "Build the agenda across tracks and rooms, then publish one trusted revision.",
  },
] as const;

const capabilities = [
  "Conditional proposal forms",
  "Multi-round reviewer workflows",
  "Speaker tasks and file collection",
  "Track and room scheduling",
  "Personalized email and calendar invites",
  "Public speaker and schedule embeds",
] as const;

const primaryLinkClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-control bg-accent px-5 text-sm font-semibold text-on-accent shadow-card transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2";
const secondaryLinkClass =
  "inline-flex min-h-11 items-center justify-center rounded-control border border-line-strong bg-surface px-5 text-sm font-semibold text-ink shadow-xs transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2";

function Brand() {
  return (
    <Link className="inline-flex items-center gap-3 text-ink no-underline" to="/" aria-label="Session Party home">
      <span className="grid size-9 place-items-center rounded-xl bg-ink text-sm font-bold tracking-[-0.04em] text-on-accent shadow-card">
        SP
      </span>
      <span className="text-base font-semibold tracking-[-0.02em]">Session Party</span>
    </Link>
  );
}

function ProductPreview() {
  return (
    <div
      className="relative mx-auto w-full max-w-xl rounded-[1.75rem] border border-white/10 bg-[#22201d] p-2 shadow-[0_30px_80px_rgb(28_27_24/0.28)]"
      aria-label="Session Party organizer workspace preview"
    >
      <div className="overflow-hidden rounded-[1.25rem] border border-line bg-canvas text-ink">
        <div className="flex items-center justify-between border-b border-line bg-surface px-4 py-3 sm:px-5">
          <div className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-danger" />
            <span className="size-2 rounded-full bg-warning" />
            <span className="size-2 rounded-full bg-success" />
          </div>
          <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
            Organizer workspace
          </span>
        </div>

        <div className="grid sm:grid-cols-[9rem_1fr]">
          <div className="hidden border-r border-line bg-surface p-4 sm:block">
            <div className="mb-5 flex items-center gap-2">
              <span className="size-7 rounded-lg bg-accent" />
              <span className="text-xs font-semibold">AI Engineer</span>
            </div>
            {[
              ["Overview", true],
              ["Forms", false],
              ["Review", false],
              ["Speakers", false],
              ["Agenda", false],
            ].map(([label, active]) => (
              <div
                className={`mb-1 rounded-lg px-2.5 py-2 text-[11px] font-medium ${
                  active ? "bg-accent-soft text-accent-deep" : "text-ink-faint"
                }`}
                key={String(label)}
              >
                {label}
              </div>
            ))}
          </div>

          <div className="p-4 sm:p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-accent-deep">
                  September 17 · San Francisco
                </p>
                <h2 className="mt-1 text-lg font-semibold tracking-[-0.03em] sm:text-xl">
                  AI Engineer Sandbox
                </h2>
              </div>
              <span className="rounded-full border border-success/20 bg-success-soft px-2 py-1 text-[10px] font-semibold text-success">
                On track
              </span>
            </div>

            <div className="mt-5 grid grid-cols-3 gap-2">
              {[
                ["60", "Proposals"],
                ["30", "Speakers"],
                ["18", "Talks"],
              ].map(([value, label]) => (
                <div className="rounded-xl border border-line bg-surface px-3 py-3" key={label}>
                  <p className="text-xl font-semibold tracking-[-0.04em]">{value}</p>
                  <p className="mt-0.5 text-[10px] text-ink-faint">{label}</p>
                </div>
              ))}
            </div>

            <div className="mt-3 rounded-xl border border-line bg-surface p-3.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-semibold">Program readiness</span>
                <span className="font-semibold text-success">82%</span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-muted">
                <div className="h-full w-[82%] rounded-full bg-accent" />
              </div>
              <div className="mt-3 space-y-2">
                {[
                  ["Speaker profiles", "30 / 30"],
                  ["Agenda confirmed", "18 / 18"],
                  ["Slides collected", "14 / 18"],
                ].map(([label, value]) => (
                  <div className="flex items-center justify-between text-[10px]" key={label}>
                    <span className="text-ink-secondary">{label}</span>
                    <span className="font-semibold text-ink">{value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LandingPage() {
  return (
    <div className="min-h-dvh overflow-hidden bg-canvas text-ink">
      <header className="relative z-20 border-b border-line/80 bg-canvas/90 backdrop-blur-xl">
        <div className="mx-auto flex h-18 max-w-7xl items-center justify-between px-5 sm:px-8">
          <Brand />
          <nav className="hidden items-center gap-7 md:flex" aria-label="Public navigation">
            <a className="text-sm font-medium text-ink-secondary transition-colors hover:text-ink" href="#workflow">
              Workflow
            </a>
            <a className="text-sm font-medium text-ink-secondary transition-colors hover:text-ink" href="#platform">
              Platform
            </a>
          </nav>
          <div className="flex items-center gap-2">
            <Link className="hidden min-h-10 items-center px-3 text-sm font-semibold text-ink-secondary hover:text-ink sm:inline-flex" to="/login?returnTo=%2Fevents">
              Sign in
            </Link>
            <Link className="inline-flex min-h-10 items-center rounded-control bg-ink px-4 text-sm font-semibold text-on-accent transition-colors hover:bg-accent" to="/events">
              Open workspace
            </Link>
          </div>
        </div>
      </header>

      <main>
        <section className="relative border-b border-line">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_78%_25%,rgb(108_59_244/0.13),transparent_34%),radial-gradient(circle_at_15%_90%,rgb(23_114_68/0.07),transparent_28%)]" />
          <div className="relative mx-auto grid max-w-7xl items-center gap-14 px-5 py-18 sm:px-8 sm:py-24 lg:grid-cols-[minmax(0,0.9fr)_minmax(34rem,1.1fr)] lg:gap-16 lg:py-28">
            <div className="max-w-2xl">
              <p className="inline-flex items-center gap-2 rounded-full border border-accent/15 bg-accent-soft px-3 py-1.5 text-xs font-semibold text-accent-deep">
                <span className="size-1.5 rounded-full bg-accent" />
                Built for speaker-led events
              </p>
              <h1 className="mt-6 text-5xl font-semibold leading-[0.96] tracking-[-0.06em] text-ink sm:text-6xl lg:text-[4.4rem]">
                Your whole program,
                <span className="block text-accent">finally in sync.</span>
              </h1>
              <p className="mt-6 max-w-xl text-base leading-7 text-ink-secondary sm:text-lg sm:leading-8">
                Collect proposals, run reviews, onboard speakers, shape the agenda, and publish—without stitching together forms, spreadsheets, and inbox threads.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Link className={primaryLinkClass} to="/login?returnTo=%2Fevents">
                  Start planning
                  <span aria-hidden="true">→</span>
                </Link>
                <a className={secondaryLinkClass} href="#workflow">
                  See how it works
                </a>
              </div>
              <p className="mt-5 text-xs font-medium text-ink-faint">
                Open source · Cloudflare-native · Built for real production teams
              </p>
            </div>

            <ProductPreview />
          </div>
        </section>

        <section className="bg-surface" id="workflow">
          <div className="mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-28">
            <div className="max-w-2xl">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent-deep">One connected workflow</p>
              <h2 className="mt-4 text-3xl font-semibold tracking-[-0.04em] sm:text-5xl">
                From open call to showtime.
              </h2>
              <p className="mt-4 text-base leading-7 text-ink-secondary">
                Every handoff stays connected, so organizers know what is ready and speakers know exactly what comes next.
              </p>
            </div>

            <ol className="mt-12 grid gap-px overflow-hidden rounded-card border border-line bg-line md:grid-cols-2 lg:grid-cols-4">
              {workflow.map((step) => (
                <li className="min-h-64 bg-canvas p-6 sm:p-7" key={step.number}>
                  <span className="text-xs font-semibold tracking-[0.14em] text-accent-deep">{step.number}</span>
                  <h3 className="mt-14 text-xl font-semibold tracking-[-0.03em]">{step.title}</h3>
                  <p className="mt-3 text-sm leading-6 text-ink-secondary">{step.description}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="border-y border-line bg-canvas" id="platform">
          <div className="mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-28">
            <div className="grid gap-8 lg:grid-cols-[0.78fr_1.22fr] lg:gap-16">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent-deep">Production, not busywork</p>
                <h2 className="mt-4 text-3xl font-semibold tracking-[-0.04em] sm:text-5xl">
                  The operational details are the product.
                </h2>
                <p className="mt-5 max-w-xl text-base leading-7 text-ink-secondary">
                  Session Party gives your team a shared source of truth while keeping the speaker experience simple and the public program polished.
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                {capabilities.map((capability, index) => (
                  <div className="flex min-h-28 items-start gap-4 rounded-card border border-line bg-surface p-5 shadow-card" key={capability}>
                    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-bold text-accent-deep">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <p className="pt-1 text-sm font-semibold leading-6 text-ink">{capability}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="bg-ink text-on-accent">
          <div className="mx-auto flex max-w-7xl flex-col gap-8 px-5 py-18 sm:px-8 sm:py-24 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/55">Ready when your program is</p>
              <h2 className="mt-4 text-3xl font-semibold tracking-[-0.045em] sm:text-5xl">
                Put the whole event team on the same page.
              </h2>
            </div>
            <Link className="inline-flex min-h-12 shrink-0 items-center justify-center rounded-control bg-on-accent px-6 text-sm font-semibold text-ink transition-colors hover:bg-accent-soft" to="/login?returnTo=%2Fevents">
              Start planning
              <span className="ml-2" aria-hidden="true">→</span>
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-line bg-surface">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-5 py-8 text-sm text-ink-faint sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <Brand />
          <p>Conference production, without the spreadsheet sprawl.</p>
        </div>
      </footer>
    </div>
  );
}
