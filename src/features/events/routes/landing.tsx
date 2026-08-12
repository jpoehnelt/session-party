import { Link } from "react-router";
import { clientRoutes } from "contracts/routes";
import { brandAssetUrl, brandInitials, useBrand } from "@/features/branding/components/client";

export const path = "/";
export const layout = "bare";

const workflow = [
  {
    number: "01",
    eyebrow: "Open the doors",
    title: "Collect",
    description: "Launch a routed CFP that keeps every proposal tidy from the first keystroke.",
    detail: "60 proposals",
    className: "bg-[#caff4a] lg:col-span-5",
  },
  {
    number: "02",
    eyebrow: "Make the call",
    title: "Review",
    description: "Give reviewers clear assignments, useful rubrics, and one place to land decisions.",
    detail: "3 rounds · 12 reviewers",
    className: "bg-[#896aff] text-[#171714] lg:col-span-7",
  },
  {
    number: "03",
    eyebrow: "Get everyone ready",
    title: "Onboard",
    description: "Turn acceptance into a calm checklist for bios, headshots, slides, forms, and deadlines.",
    detail: "30 speakers ready",
    className: "bg-[#ff714f] lg:col-span-7",
  },
  {
    number: "04",
    eyebrow: "Cue the room",
    title: "Schedule",
    description: "Resolve conflicts, lock the run of show, and publish one version everyone can trust.",
    detail: "18 talks · 2 tracks",
    className: "bg-[#8fdcff] lg:col-span-5",
  },
] as const;

const capabilities = [
  ["01", "Conditional proposal forms", "ROUTED"],
  ["02", "Multi-round reviewer workflows", "DECIDED"],
  ["03", "Speaker tasks and file collection", "30 / 30"],
  ["04", "Track and room scheduling", "NO CLASHES"],
  ["05", "Personalized email + calendar invites", "QUEUED"],
  ["06", "Public speaker and schedule embeds", "LIVE"],
] as const;

const demoDestinations = [
  {
    label: "Published program",
    detail: "23 live sessions",
    to: "/event/ai-engineer-sandbox",
  },
  {
    label: "Speaker gallery",
    detail: "30 public profiles",
    to: "/embed/ai-engineer-sandbox/speakers",
  },
  {
    label: "Readiness cockpit",
    detail: "Organizer demo",
    to: "/login?returnTo=%2Fe%2Fai-engineer-sandbox%2Fdashboard",
  },
  {
    label: "Review room",
    detail: "Reviewer demo",
    to: "/login?returnTo=%2Fe%2Fai-engineer-sandbox%2Freview",
  },
  {
    label: "Accelevents import",
    detail: "Integration evidence",
    to: "/login?returnTo=%2Fe%2Fai-engineer-sandbox%2Fintegrations",
  },
  {
    label: "Speaker portal resources",
    detail: "Guide + video embed",
    to: `/login?returnTo=${encodeURIComponent(clientRoutes.portal("ai-engineer-sandbox"))}`,
  },
] as const;

const primaryLinkClass =
  "inline-flex min-h-12 items-center justify-center gap-3 border-2 border-[#171714] bg-[#171714] px-6 text-sm font-black uppercase tracking-[0.08em] text-white shadow-[6px_6px_0_#7857ff] transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7857ff] focus-visible:ring-offset-4";

function Brand({ inverse = false }: { inverse?: boolean }) {
  const { brand } = useBrand();
  return (
    <Link
      className={`inline-flex items-center gap-3 no-underline ${inverse ? "text-white" : "text-[#171714]"}`}
      to="/"
      aria-label={`${brand.name} home`}
    >
      {brand.logoAssetId ? <img className="max-h-11 max-w-40 object-contain" src={brandAssetUrl(brand.logoAssetId)!} alt="" /> : <span
        className={`grid size-10 place-items-center border-2 text-xs font-black tracking-[-0.04em] shadow-[3px_3px_0_#7857ff] ${
          inverse ? "border-white bg-white text-[#171714]" : "border-[#171714] bg-[#caff4a] text-[#171714]"
        }`}
      >
        {brandInitials(brand.name)}
      </span>}
      <span className="text-base font-black tracking-[-0.03em]">{brand.name}</span>
    </Link>
  );
}

function ProductPreview() {
  const navItems = ["Overview", "Forms", "Review", "Speakers", "Agenda"] as const;
  const cues = [
    ["09:00", "CFP closes", "bg-[#896aff] text-[#171714]"],
    ["13:00", "Review lock", "bg-[#ff714f] text-[#171714]"],
    ["17:30", "Speaker brief", "bg-[#caff4a] text-[#171714]"],
  ] as const;

  return (
    <div className="relative mx-auto w-full max-w-2xl py-8 lg:py-12" aria-label="Session Party organizer workspace preview">
      <div className="absolute inset-x-8 top-4 h-[88%] rotate-3 bg-[#7857ff]" aria-hidden="true" />
      <div className="absolute -right-1 top-0 z-20 rotate-6 border-2 border-[#171714] bg-[#caff4a] px-4 py-2 text-xs font-black uppercase tracking-[0.14em] shadow-[4px_4px_0_#171714] sm:-right-5 sm:px-5">
        T–39 days
      </div>

      <div className="relative z-10 border-[3px] border-[#171714] bg-[#fffdf7] shadow-[10px_10px_0_#171714]">
        <div className="flex items-center justify-between border-b-2 border-[#171714] bg-[#171714] px-4 py-3 text-white sm:px-5">
          <div className="flex items-center gap-2" aria-hidden="true">
            <span className="size-2.5 bg-[#ff714f]" />
            <span className="size-2.5 bg-[#ffd34e]" />
            <span className="size-2.5 bg-[#caff4a]" />
          </div>
          <span className="text-[10px] font-black uppercase tracking-[0.2em] text-white/70">Organizer control room</span>
        </div>

        <div className="grid sm:grid-cols-[8.75rem_1fr]">
          <aside className="hidden border-r-2 border-[#171714] bg-[#ece8dc] p-4 sm:block">
            <div className="mb-5 border-b-2 border-[#171714] pb-4">
              <span className="block text-[9px] font-black uppercase tracking-[0.16em] text-[#665f52]">Now producing</span>
              <span className="mt-1 block text-xs font-black leading-tight">AI Engineer<br />Sandbox</span>
            </div>
            {navItems.map((label, index) => (
              <div
                className={`mb-1.5 px-2.5 py-2 text-[11px] font-bold ${
                  index === 0 ? "bg-[#896aff] text-[#171714] shadow-[3px_3px_0_#171714]" : "text-[#665f52]"
                }`}
                key={label}
              >
                {String(index + 1).padStart(2, "0")} / {label}
              </div>
            ))}
          </aside>

          <div className="p-4 sm:p-5">
            <div className="flex items-start justify-between gap-4 border-b-2 border-[#171714] pb-4">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#3e268f]">Sep 17 · San Francisco</p>
                <h2 className="mt-1 text-xl font-black tracking-[-0.045em] sm:text-2xl">AI Engineer Sandbox</h2>
              </div>
              <div className="bg-[#caff4a] px-2.5 py-1.5 text-[10px] font-black uppercase tracking-[0.12em]">On track</div>
            </div>

            <div className="grid grid-cols-3 border-x-2 border-b-2 border-[#171714]">
              {[
                ["60", "Proposals", "bg-[#fffdf7]"],
                ["30", "Speakers", "bg-[#8fdcff]"],
                ["18", "Talks", "bg-[#ff714f]"],
              ].map(([value, label, color], index) => (
                <div className={`px-3 py-3 ${color} ${index > 0 ? "border-l-2 border-[#171714]" : ""}`} key={label}>
                  <p className="text-2xl font-black tracking-[-0.05em]">{value}</p>
                  <p className="mt-0.5 text-[9px] font-bold uppercase tracking-[0.08em]">{label}</p>
                </div>
              ))}
            </div>

            <div className="mt-4 grid gap-4 md:grid-cols-[1fr_6.5rem]">
              <div>
                <div className="mb-2 flex items-end justify-between">
                  <p className="text-[10px] font-black uppercase tracking-[0.14em]">Today&apos;s cues</p>
                  <p className="text-[9px] font-bold text-[#665f52]">3 MOVING</p>
                </div>
                <div className="border-2 border-[#171714]">
                  {cues.map(([time, label, color], index) => (
                    <div className={`grid grid-cols-[3.6rem_1fr] text-[10px] font-bold ${index > 0 ? "border-t-2 border-[#171714]" : ""}`} key={time}>
                      <span className="border-r-2 border-[#171714] px-2 py-2.5 font-black">{time}</span>
                      <span className={`${color} px-2.5 py-2.5`}>{label}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="border-2 border-[#171714] bg-[#171714] p-3 text-white">
                <div className="flex h-full flex-col justify-between">
                  <span className="text-[9px] font-black uppercase tracking-[0.12em] text-white/55">Readiness</span>
                  <span className="text-3xl font-black tracking-[-0.06em] text-[#caff4a]">82%</span>
                  <div className="h-1.5 bg-white/20">
                    <div className="h-full w-[82%] bg-[#caff4a]" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="absolute -bottom-1 left-3 z-20 -rotate-3 border-2 border-[#171714] bg-[#fffdf7] px-4 py-2 text-[10px] font-black uppercase tracking-[0.12em] shadow-[4px_4px_0_#171714] sm:left-12">
        ✓ 30 speakers ready
      </div>
    </div>
  );
}

function WorkflowCard({ step }: { step: (typeof workflow)[number] }) {
  return (
    <li
      className={`group relative flex min-h-72 flex-col justify-between overflow-hidden border-[3px] border-[#171714] p-6 shadow-[8px_8px_0_#171714] transition-transform hover:-translate-y-1 sm:p-8 lg:min-h-80 ${step.className}`}
    >
      <div className="flex items-start justify-between gap-5">
        <p className="text-xs font-black uppercase tracking-[0.14em]">{step.eyebrow}</p>
        <span className="text-6xl font-black leading-none tracking-[-0.08em] sm:text-7xl">{step.number}</span>
      </div>
      <div>
        <p className="mb-3 inline-block border-2 border-current px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.12em]">{step.detail}</p>
        <h3 className="text-4xl font-black tracking-[-0.055em] sm:text-5xl">{step.title}</h3>
        <p className="mt-3 max-w-xl text-sm font-semibold leading-6 sm:text-base">{step.description}</p>
      </div>
    </li>
  );
}

export default function LandingPage() {
  return (
    <div className="min-h-dvh overflow-hidden bg-[#f3efe3] text-[#171714]">
      <header className="relative z-30 border-b-2 border-[#171714] bg-[#f3efe3]">
        <div className="mx-auto flex h-20 max-w-[90rem] items-center justify-between px-5 sm:px-8 lg:px-10">
          <Brand />
          <nav className="hidden items-center gap-8 md:flex" aria-label="Public navigation">
            <a className="text-xs font-black uppercase tracking-[0.12em] underline-offset-4 hover:underline" href="#workflow">Workflow</a>
            <a className="text-xs font-black uppercase tracking-[0.12em] underline-offset-4 hover:underline" href="#platform">Platform</a>
          </nav>
          <div className="flex items-center gap-2 sm:gap-3">
            <Link className="hidden min-h-10 items-center px-2 text-xs font-black uppercase tracking-[0.1em] underline-offset-4 hover:underline sm:inline-flex" to="/login?returnTo=%2Fevents">
              Sign in
            </Link>
            <Link className="inline-flex min-h-11 items-center border-2 border-[#171714] bg-[#caff4a] px-3.5 text-xs font-black uppercase tracking-[0.08em] shadow-[4px_4px_0_#171714] transition-transform hover:-translate-y-0.5 sm:px-5" to="/events">
              Open workspace
            </Link>
          </div>
        </div>
      </header>

      <main>
        <section className="relative border-b-2 border-[#171714]">
          <div className="pointer-events-none absolute inset-0 opacity-35 [background-image:linear-gradient(#b9b1a1_1px,transparent_1px),linear-gradient(90deg,#b9b1a1_1px,transparent_1px)] [background-size:44px_44px]" />
          <div className="relative mx-auto grid max-w-[90rem] items-center gap-12 px-5 py-16 sm:px-8 sm:py-20 lg:grid-cols-[minmax(0,0.88fr)_minmax(34rem,1.12fr)] lg:gap-16 lg:px-10 lg:py-24">
            <div className="max-w-3xl">
              <p className="inline-block -rotate-1 border-2 border-[#171714] bg-[#ff714f] px-3 py-2 text-[11px] font-black uppercase tracking-[0.14em] shadow-[4px_4px_0_#171714]">
                The control room for speaker-led events
              </p>
              <h1 className="mt-8 text-[clamp(3rem,7vw,7.25rem)] font-black leading-[0.82] tracking-[-0.075em]">
                Your whole
                <span className="block">program,</span>
                <span className="relative mt-2 inline-block bg-[#896aff] px-2 pb-2 text-[#171714] shadow-[8px_8px_0_#171714]">ready on cue.</span>
              </h1>
              <p className="mt-8 max-w-xl text-lg font-semibold leading-8 text-[#4f4a40]">
                Proposals, reviews, speakers, schedules, and every deadline in between—moving toward the same show.
              </p>
              <div className="mt-9 flex flex-col items-start gap-5 sm:flex-row sm:items-center">
                <Link className={primaryLinkClass} to="/login?returnTo=%2Fevents">
                  Start producing <span aria-hidden="true">→</span>
                </Link>
                <a className="text-sm font-black uppercase tracking-[0.08em] underline decoration-2 underline-offset-4 hover:text-[#3e268f]" href="#workflow">
                  Follow the workflow ↓
                </a>
              </div>
              <div className="mt-8 flex flex-wrap gap-x-5 gap-y-2 text-[10px] font-black uppercase tracking-[0.12em] text-[#665f52]">
                <span>Open source</span>
                <span aria-hidden="true">◆</span>
                <span>Cloudflare-native</span>
                <span aria-hidden="true">◆</span>
                <span>Built for production teams</span>
              </div>
            </div>

            <ProductPreview />
          </div>
        </section>

        <section className="border-b-2 border-[#171714] bg-[#ffd34e]" aria-labelledby="live-demo-heading">
          <div className="mx-auto max-w-[90rem] px-5 py-8 sm:px-8 lg:px-10">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#3e268f]">Hackathon walkthrough</p>
                <h2 id="live-demo-heading" className="mt-1 text-3xl font-black tracking-[-0.045em]">Explore the live demo.</h2>
              </div>
              <p className="max-w-xl text-sm font-bold leading-6 text-[#4f4a40]">Jump straight to judging evidence. Signed-in links open the role picker, then return to the selected workflow.</p>
            </div>
            <nav className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Live demo workflows">
              {demoDestinations.map(({ label, detail, to }, index) => (
                <Link
                  className="group flex min-h-20 items-center justify-between gap-4 border-2 border-[#171714] bg-[#fffdf7] px-4 py-3 shadow-[4px_4px_0_#171714] transition-transform hover:-translate-y-0.5"
                  key={label}
                  to={to}
                >
                  <span>
                    <span className="block text-[9px] font-black uppercase tracking-[0.14em] text-[#665f52]">Demo {String(index + 1).padStart(2, "0")}</span>
                    <span className="mt-1 block text-sm font-black">{label}</span>
                    <span className="mt-0.5 block text-[10px] font-bold uppercase tracking-[0.08em] text-[#665f52]">{detail}</span>
                  </span>
                  <span className="text-xl font-black transition-transform group-hover:translate-x-1" aria-hidden="true">→</span>
                </Link>
              ))}
            </nav>
          </div>
        </section>

        <div className="border-b-2 border-[#171714] bg-[#171714] py-4 text-white" aria-hidden="true">
          <div className="mx-auto flex max-w-[90rem] flex-wrap items-center justify-center gap-x-6 gap-y-2 px-5 text-[11px] font-black uppercase tracking-[0.18em] sm:justify-between sm:px-8 lg:px-10">
            {['Call for papers', 'Review', 'Speaker prep', 'Run of show', 'Publish'].map((label, index) => (
              <span className="flex items-center gap-6" key={label}>
                {label}
                {index < 4 ? <span className={`size-2.5 rotate-45 ${index % 2 === 0 ? 'bg-[#caff4a]' : 'bg-[#ff714f]'}`} /> : null}
              </span>
            ))}
          </div>
        </div>

        <section id="workflow">
          <div className="mx-auto max-w-[90rem] px-5 py-20 sm:px-8 sm:py-28 lg:px-10">
            <div className="grid items-end gap-8 lg:grid-cols-[1fr_0.7fr]">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.18em] text-[#3e268f]">One connected workflow</p>
                <h2 className="mt-4 max-w-4xl text-5xl font-black leading-[0.93] tracking-[-0.065em] sm:text-7xl">
                  From open call<br />to showtime.
                </h2>
              </div>
              <p className="max-w-xl border-l-[3px] border-[#171714] pl-5 text-base font-semibold leading-7 text-[#4f4a40] sm:text-lg">
                Every handoff stays visible. Organizers know what is ready, speakers know what comes next, and nobody has to ask which spreadsheet is current.
              </p>
            </div>

            <ol className="mt-14 grid gap-6 lg:grid-cols-12 lg:gap-8">
              {workflow.map((step) => <WorkflowCard key={step.number} step={step} />)}
            </ol>
          </div>
        </section>

        <section className="border-y-2 border-[#171714] bg-[#171714] text-white" id="platform">
          <div className="mx-auto grid max-w-[90rem] gap-14 px-5 py-20 sm:px-8 sm:py-28 lg:grid-cols-[0.82fr_1.18fr] lg:gap-20 lg:px-10">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.18em] text-[#ff714f]">Production, not busywork</p>
              <h2 className="mt-5 text-5xl font-black leading-[0.93] tracking-[-0.065em] sm:text-7xl">
                The details <span className="text-[#caff4a]">are</span> the show.
              </h2>
              <p className="mt-7 max-w-xl text-base font-semibold leading-7 text-white/65 sm:text-lg">
                Session Party keeps the operational work in one live system—without making the speaker experience feel like one.
              </p>
              <div className="mt-10 grid grid-cols-3 border-2 border-white">
                {[["82%", "Ready"], ["18", "Talks"], ["0", "Conflicts"]].map(([value, label], index) => (
                  <div className={`p-3 sm:p-5 ${index > 0 ? "border-l-2 border-white" : ""}`} key={label}>
                    <p className="text-3xl font-black tracking-[-0.06em] text-[#caff4a] sm:text-5xl">{value}</p>
                    <p className="mt-2 text-[9px] font-black uppercase tracking-[0.12em] text-white/55 sm:text-[10px]">{label}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="border-[3px] border-white bg-[#f3efe3] p-4 text-[#171714] shadow-[10px_10px_0_#7857ff] sm:p-6">
              <div className="flex items-center justify-between border-b-[3px] border-[#171714] pb-4">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#665f52]">Live production board</p>
                  <h3 className="mt-1 text-2xl font-black tracking-[-0.04em]">Everything talking to everything.</h3>
                </div>
                <span className="hidden bg-[#caff4a] px-3 py-2 text-[10px] font-black uppercase tracking-[0.12em] sm:block">All systems go</span>
              </div>
              <ol>
                {capabilities.map(([number, capability, status], index) => (
                  <li className={`grid grid-cols-[2.25rem_1fr] items-center gap-3 py-4 sm:grid-cols-[2.5rem_1fr_auto] sm:gap-5 ${index > 0 ? "border-t-2 border-[#171714]" : ""}`} key={capability}>
                    <span className="grid size-9 place-items-center bg-[#ece8dc] text-xs font-black text-[#171714]">{number}</span>
                    <span className="text-sm font-black sm:text-base">{capability}</span>
                    <span className="col-start-2 text-[9px] font-black uppercase tracking-[0.12em] text-[#665f52] sm:col-start-auto sm:text-right">{status}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        <section className="relative overflow-hidden border-b-2 border-[#171714] bg-[#caff4a]">
          <div className="pointer-events-none absolute -right-10 top-8 rotate-12 text-[12rem] font-black leading-none tracking-[-0.1em] text-[#171714]/8 sm:text-[20rem]" aria-hidden="true">GO</div>
          <div className="relative mx-auto flex max-w-[90rem] flex-col gap-10 px-5 py-20 sm:px-8 sm:py-24 lg:flex-row lg:items-end lg:justify-between lg:px-10">
            <div className="max-w-5xl">
              <p className="text-xs font-black uppercase tracking-[0.18em]">Ready when your program is</p>
              <h2 className="mt-4 text-5xl font-black leading-[0.9] tracking-[-0.07em] sm:text-7xl lg:text-8xl">
                Get everyone<br />ready for showtime.
              </h2>
            </div>
            <Link className="inline-flex min-h-14 shrink-0 items-center justify-center border-[3px] border-[#171714] bg-[#896aff] px-7 text-sm font-black uppercase tracking-[0.1em] text-[#171714] shadow-[7px_7px_0_#171714] transition-transform hover:-translate-y-1" to="/login?returnTo=%2Fevents">
              Start producing <span className="ml-3" aria-hidden="true">→</span>
            </Link>
          </div>
        </section>
      </main>

      <footer className="bg-[#f3efe3]">
        <div className="mx-auto flex max-w-[90rem] flex-col gap-5 px-5 py-9 text-sm font-semibold text-[#665f52] sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-10">
          <Brand />
          <p>Conference production, without the spreadsheet sprawl.</p>
        </div>
      </footer>
    </div>
  );
}
