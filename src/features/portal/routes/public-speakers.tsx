import { useParams } from "react-router";
import { PageHeader, SpeakerGallery } from "@/ui";
import type { PublicSpeakerGallery } from "../schema";
import { getPublicSpeakerGallery } from "./api";
import { RouteFailure, RouteLoading, useRouteLoad } from "../components/route-state";

export const path = "/embed/:eventSlug/speakers";
export const layout = "bare" as const;

export default function PublicSpeakersRoute() {
  const { eventSlug = "" } = useParams();
  const [state, retry] = useRouteLoad(() => getPublicSpeakerGallery(eventSlug), eventSlug);
  return (
    <main className="min-h-dvh bg-canvas px-4 py-8 text-ink sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        {state.status === "loading" ? (
          <RouteLoading label="Loading public speakers" />
        ) : state.status === "error" ? (
          <RouteFailure message={state.message} onRetry={retry} />
        ) : (
          <PublicSpeakerEmbedContent gallery={state.data} />
        )}
      </div>
    </main>
  );
}

export function PublicSpeakerEmbedContent({ gallery }: { readonly gallery: PublicSpeakerGallery }) {
  return (
    <div className="space-y-7">
      <PageHeader
        title={`${gallery.event.name} speakers`}
        description={gallery.event.description ?? undefined}
      />
      <SpeakerGallery
        speakers={gallery.speakers.map((speaker) => ({
          id: speaker.id,
          displayName: speaker.displayName,
          title: speaker.title ?? undefined,
          company: speaker.company ?? undefined,
          bio: speaker.bio ?? undefined,
          headshotUrl: speaker.headshotUrl ?? undefined,
          links: speaker.links,
        }))}
      />
    </div>
  );
}
