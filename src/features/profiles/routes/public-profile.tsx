import { Link, useParams } from "react-router";
import { Avatar, EmptyState } from "@/ui";
import { RouteFailure, RouteLoading, useRouteLoad } from "@/features/portal/components/route-state";
import type { PublicProfileAppearance } from "../schema";
import { getPublicProfile } from "./api";

export const path = "/speakers/:speakerSlug";
export const layout = "bare" as const;

function eventDate(appearance: PublicProfileAppearance): string | null {
  if (appearance.startsAt === null) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "long",
    timeZone: appearance.timezone,
  }).format(new Date(appearance.startsAt));
}

export default function PublicProfileRoute() {
  const { speakerSlug = "" } = useParams();
  const [state, retry] = useRouteLoad(() => getPublicProfile(speakerSlug), speakerSlug);
  if (state.status === "loading") return <main className="mx-auto max-w-5xl p-6"><RouteLoading label="Loading speaker profile" /></main>;
  if (state.status === "error") return <main className="mx-auto max-w-5xl p-6"><RouteFailure message={state.message} onRetry={retry} /></main>;
  const { profile, appearances } = state.data;
  return (
    <main className="min-h-screen bg-canvas px-5 py-8 text-ink sm:px-8 sm:py-14">
      <div className="mx-auto max-w-5xl space-y-12">
        <header className="grid gap-7 border-b-2 border-line-strong pb-10 sm:grid-cols-[auto_1fr] sm:items-center">
          <Avatar name={profile.displayName} src={profile.headshotUrl ?? undefined} size="lg" />
          <div>
            <p className="text-xs font-black uppercase tracking-[0.16em] text-accent-deep">Speaker profile</p>
            <h1 className="mt-2 text-4xl font-black tracking-[-0.05em] sm:text-6xl">{profile.displayName}</h1>
            {(profile.title || profile.company) && <p className="mt-3 text-base font-bold text-ink-secondary">{[profile.title, profile.company].filter(Boolean).join(" at ")}</p>}
            {profile.bio && <p className="mt-6 max-w-3xl whitespace-pre-line text-base leading-7 text-ink-secondary">{profile.bio}</p>}
            {profile.links.length > 0 && <div className="mt-6 flex flex-wrap gap-3">{profile.links.map((link) => <a className="inline-flex h-10 items-center border-2 border-line-strong bg-surface px-4 text-sm font-black uppercase tracking-[0.075em] text-ink shadow-button" key={`${link.label}-${link.url}`} href={link.url}>{link.label}</a>)}</div>}
          </div>
        </header>
        <section aria-labelledby="appearances-heading" className="space-y-6">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.16em] text-accent-deep">Published work</p>
            <h2 id="appearances-heading" className="mt-2 text-3xl font-black tracking-[-0.04em]">Events and talks</h2>
          </div>
          {appearances.length === 0 ? (
            <EmptyState title="No public appearances yet" description="Published events and talks will appear here after the event makes them public." />
          ) : (
            <ol className="grid gap-5">
              {appearances.map((appearance) => (
                <li className="border-2 border-line-strong bg-surface p-6 shadow-card" key={appearance.eventId}>
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <h3 className="text-2xl font-black tracking-[-0.035em]">{appearance.eventName}</h3>
                      <p className="mt-1 text-sm font-medium text-ink-secondary">{[eventDate(appearance), appearance.location].filter(Boolean).join(" · ")}</p>
                    </div>
                    <Link className="inline-flex h-10 items-center border-2 border-line-strong bg-surface px-4 text-sm font-black uppercase tracking-[0.075em] text-ink shadow-button" to={`/embed/${appearance.eventSlug}/speakers`}>Event speakers</Link>
                  </div>
                  {appearance.talks.length > 0 && (
                    <ul className="mt-5 grid gap-3 border-t border-line pt-5">
                      {appearance.talks.map((talk) => (
                        <li key={talk.id}>
                          <p className="font-bold">{talk.title}</p>
                          <p className="mt-1 text-xs font-medium uppercase tracking-[0.08em] text-ink-faint">{[talk.track, talk.room].filter(Boolean).join(" · ")}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </main>
  );
}
