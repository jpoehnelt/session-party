import { Link, useParams } from "react-router";
import { Avatar, Badge, Card, EmptyState, PageHeader, ProgressChecklist } from "@/ui";
import { getSpeakerDirectory } from "./api";
import { RouteFailure, RouteLoading, useRouteLoad } from "../components/route-state";
import { organizerAgendaTalkPath } from "@/features/agenda/links";

export const path = "/e/:eventSlug/speakers/:speakerId";

export default function OrganizerSpeakerDetailRoute() {
  const { eventSlug = "", speakerId = "" } = useParams();
  const [state, retry] = useRouteLoad(() => getSpeakerDirectory(eventSlug), `${eventSlug}:${speakerId}`);
  if (state.status === "loading") return <RouteLoading label="Loading event speaker profile" />;
  if (state.status === "error") return <RouteFailure message={state.message} onRetry={retry} />;
  const item = state.data.speakers.find((candidate) => candidate.speaker.id === speakerId);
  if (!item) return <EmptyState title="Speaker not found" description="This speaker is not part of the selected event." action={<Link className="font-bold underline" to={`/e/${eventSlug}/speakers`}>Back to speakers</Link>} />;
  const { speaker } = item;
  return (
    <div className="space-y-8">
      <PageHeader
        title={speaker.displayName}
        description={`Event-specific speaker profile for ${state.data.event.name}. This reviewed snapshot is independent from the speaker's reusable profile.`}
        actions={<Link className="font-bold underline decoration-2 underline-offset-4" to={`/e/${eventSlug}/speakers`}>Back to speakers</Link>}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card className="p-6">
          <div className="flex items-start gap-4">
            <Avatar name={speaker.displayName} src={speaker.headshotUrl ?? undefined} size="lg" />
            <div>
              <div className="flex flex-wrap gap-2">
                <Badge tone={speaker.profileReviewStatus === "approved" ? "success" : speaker.profileReviewStatus === "changes_requested" ? "danger" : "neutral"}>{speaker.profileReviewStatus.replace("_", " ")}</Badge>
                <Badge tone={speaker.visible ? "accent" : "neutral"}>{speaker.visible ? "Public when published" : "Private"}</Badge>
              </div>
              <p className="mt-3 font-bold text-ink-secondary">{[speaker.title, speaker.company].filter(Boolean).join(" at ") || "Professional details pending"}</p>
            </div>
          </div>
          <div className="mt-6 border-t-2 border-line-strong pt-5">
            <h2 className="text-xs font-black uppercase tracking-[0.12em]">Biography</h2>
            <p className="mt-3 whitespace-pre-line text-sm leading-6 text-ink-secondary">{speaker.bio || "Biography pending."}</p>
          </div>
          {speaker.links.length > 0 && <div className="mt-5 flex flex-wrap gap-3">{speaker.links.map((link) => <a className="font-bold text-accent-deep underline" href={link.url} key={`${link.label}-${link.url}`}>{link.label}</a>)}</div>}
          {speaker.profileReviewNote && <p className="mt-5 border-2 border-line-strong bg-warning-soft p-3 text-sm"><strong>Review note:</strong> {speaker.profileReviewNote}</p>}
        </Card>
        <div className="space-y-5">
          <Card title="Readiness">
            <p className="mb-4 text-sm font-medium text-ink-secondary">{item.readiness.tasksDone} of {item.readiness.tasksTotal} tasks complete</p>
            <ProgressChecklist items={item.readiness.missingItems.map((missing) => ({ id: missing.id, label: missing.name, completed: false }))} />
          </Card>
          <Card title="Sessions">
            {item.sessions.length === 0 ? <p className="text-sm text-ink-secondary">No session linked.</p> : <ul className="space-y-3">{item.sessions.map((session) => <li key={session.id}><a className="font-bold underline decoration-2 underline-offset-3 hover:text-accent-deep" href={organizerAgendaTalkPath(eventSlug, session.id)}>{session.title}</a><p className="text-xs text-ink-faint">{session.status}</p></li>)}</ul>}
          </Card>
        </div>
      </div>
    </div>
  );
}
