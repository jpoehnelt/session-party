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
      <main className="production-grid min-h-dvh bg-canvas px-4 py-6 text-ink sm:px-6 sm:py-8 lg:px-8">
        <div className="mx-auto max-w-7xl space-y-7">
          <header className="flex flex-wrap items-center justify-between gap-4 border-2 border-line-strong bg-ink px-4 py-3 text-on-accent shadow-[5px_5px_0_#7857ff]">
            <div className="flex items-center gap-3">
              <span className="grid size-9 place-items-center border-2 border-on-accent bg-production-lime text-[10px] font-black tracking-[-0.04em] text-ink">SP</span>
              <h1 className="text-sm font-black tracking-[-0.025em]">Loading published program</h1>
            </div>
            <span className="border-2 border-on-accent bg-production-coral px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-ink">Tuning feed</span>
          </header>
          <div className="grid gap-5 md:grid-cols-[1fr_18rem]">
            <Skeleton className="min-h-[32rem] rounded-none" />
            <Skeleton className="min-h-[32rem] rounded-none bg-production-sky/30" />
          </div>
        </div>
      </main>
    );
  }
  if (state.status === "error") {
    return (
      <main className="production-grid min-h-dvh bg-canvas px-4 py-6 text-ink sm:px-6 sm:py-8 lg:px-8">
        <div className="mx-auto max-w-4xl">
          <header className="mb-7 flex flex-wrap items-center justify-between gap-4 border-2 border-line-strong bg-ink px-4 py-3 text-on-accent shadow-[5px_5px_0_#7857ff]">
            <div className="flex items-center gap-3">
              <span className="grid size-9 place-items-center border-2 border-on-accent bg-production-lime text-[10px] font-black tracking-[-0.04em] text-ink">SP</span>
              <p className="text-sm font-black tracking-[-0.025em]">Session Party · Public program</p>
            </div>
            <span className="border-2 border-on-accent bg-production-coral px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-ink">Signal lost</span>
          </header>
          <EmptyState
            className="min-h-80 bg-production-coral/20 shadow-[8px_8px_0_#171714]"
            headingLevel={1}
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
