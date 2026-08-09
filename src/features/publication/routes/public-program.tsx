import { useEffect, useState } from "react";
import { useParams } from "react-router";
import type { PublishedAgenda } from "@/features/agenda/schema";
import { getPublicSpeakerGallery } from "@/features/portal/routes/api";
import type { PublicSpeakerGallery } from "@/features/portal/schema";
import { Button, EmptyState, Skeleton } from "@/ui";
import { getPublicSchedule } from "../api";
import {
  PublicProgram,
  publicSurfaceFromSplat,
} from "../components/PublicProgram";

export const path = "/event/:eventSlug/*";
export const layout = "bare" as const;

type PublicProgramState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "ready";
      readonly agenda: PublishedAgenda;
      readonly gallery: PublicSpeakerGallery;
    };

export default function PublicProgramRoute() {
  const { eventSlug = "", "*": splat } = useParams();
  const [request, setRequest] = useState(0);
  const [state, setState] = useState<PublicProgramState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    void Promise.all([
      getPublicSchedule(eventSlug),
      getPublicSpeakerGallery(eventSlug),
    ]).then(([agenda, gallery]) => {
      if (active) setState({ status: "ready", agenda, gallery });
    }).catch((caught: unknown) => {
      if (active) {
        setState({
          status: "error",
          message: caught instanceof Error ? caught.message : "Could not load the published program",
        });
      }
    });
    return () => { active = false; };
  }, [eventSlug, request]);

  if (state.status === "loading") {
    return (
      <main className="min-h-dvh bg-canvas px-4 py-10 sm:px-6">
        <div className="mx-auto max-w-7xl space-y-5">
          <h1 className="text-2xl font-semibold text-ink">Loading published program</h1>
          <Skeleton className="min-h-96" />
        </div>
      </main>
    );
  }
  if (state.status === "error") {
    return (
      <main className="min-h-dvh bg-canvas px-4 py-10 sm:px-6">
        <div className="mx-auto max-w-3xl">
          <EmptyState
            title="Published program unavailable"
            description={state.message}
            action={<Button type="button" onClick={() => setRequest((value) => value + 1)}>Try again</Button>}
          />
        </div>
      </main>
    );
  }
  return (
    <PublicProgram
      agenda={state.agenda}
      gallery={state.gallery}
      surface={publicSurfaceFromSplat(splat)}
    />
  );
}
