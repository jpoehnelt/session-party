import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { getPublicSpeakerGallery } from "@/features/portal/routes/api";
import { PublicSpeakerEmbedContent } from "@/features/portal/routes/public-speakers";
import { Button, EmptyState, Skeleton } from "@/ui";
import { getPublicEmbedDefinition, getPublicSchedule, PublicationApiError } from "../api";
import { embedDesignStyle, embedTypographyClass } from "../embed-design";
import { filterPublishedAgenda } from "../embed-content";
import type { EmbedDefinition } from "../schema";
import { ScheduleEmbedContent } from "./schedule-embed";

export const path = "/embed/:eventSlug/:embedId";
export const layout = "bare" as const;

type State =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly definition: EmbedDefinition; readonly content: unknown };

export default function PersistedEmbedRoute() {
  const { eventSlug = "", embedId = "" } = useParams();
  const [request, setRequest] = useState(0);
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    void getPublicEmbedDefinition(eventSlug, embedId).then(async (definition) => {
      let content: unknown;
      if (definition.widget === "schedule") {
        try {
          content = await getPublicSchedule(eventSlug);
        } catch (caught) {
          if (caught instanceof PublicationApiError && caught.status === 404) content = null;
          else throw caught;
        }
      } else {
        content = await getPublicSpeakerGallery(eventSlug);
      }
      return { definition, content };
    }).then(({ definition, content }) => {
      if (active) setState({ status: "ready", definition, content });
    }).catch((caught: unknown) => {
      if (!active) return;
      if (caught instanceof PublicationApiError && caught.status === 404) {
        setState({ status: "unavailable" });
      } else {
        setState({ status: "failed", message: caught instanceof Error ? caught.message : "Could not load this embed" });
      }
    });
    return () => { active = false; };
  }, [embedId, eventSlug, request]);

  if (state.status === "loading") {
    return <main className="min-h-dvh bg-canvas p-6"><Skeleton className="mx-auto min-h-[32rem] max-w-7xl rounded-none" /></main>;
  }
  if (state.status === "unavailable") {
    return <main className="grid min-h-dvh place-items-center bg-canvas p-6"><EmptyState title="Embed unavailable" description="This embed is disabled, missing, or no longer public." /></main>;
  }
  if (state.status === "failed") {
    return <main className="grid min-h-dvh place-items-center bg-canvas p-6"><EmptyState title="Could not load this embed" description={state.message} action={<Button onClick={() => setRequest((value) => value + 1)}>Try again</Button>} /></main>;
  }

  const design = { aesthetic: state.definition.aesthetic, accent: state.definition.accent } as const;
  if (state.definition.widget === "speakerGallery") {
    return (
      <main className={`min-h-dvh bg-canvas px-4 py-6 text-ink sm:px-8 ${embedTypographyClass(design.aesthetic)}`} style={embedDesignStyle(design)}>
        <div className="mx-auto max-w-7xl">
          <PublicSpeakerEmbedContent
            gallery={state.content as Awaited<ReturnType<typeof getPublicSpeakerGallery>>}
            design={design}
            preset={state.definition.preset === "speakerList" ? "speakerList" : "speakerGallery"}
          />
        </div>
      </main>
    );
  }

  if (state.content === null) {
    return <ScheduleEmbedContent agenda={null} error={null} onRetry={() => setRequest((value) => value + 1)} design={design} />;
  }
  const agenda = filterPublishedAgenda(
    state.content as Awaited<ReturnType<typeof getPublicSchedule>>,
    state.definition.track,
    state.definition.trackId,
  );
  return (
    <ScheduleEmbedContent
      agenda={agenda}
      error={null}
      onRetry={() => setRequest((value) => value + 1)}
      design={design}
      includedFields={state.definition.fields}
      preset={state.definition.preset === "sessions" || state.definition.preset === "itinerary" ? state.definition.preset : "agenda"}
    />
  );
}
