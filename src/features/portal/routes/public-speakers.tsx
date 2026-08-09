import { useParams } from "react-router";
import { Avatar } from "@/ui";
import type { PublicSpeakerGallery } from "../schema";
import { getPublicSpeakerGallery } from "./api";
import { RouteFailure, RouteLoading, useRouteLoad } from "../components/route-state";
import { ProductionBareFrame, ProductionHeader, ProductionSectionLabel } from "../components/production-ui";

export const path = "/embed/:eventSlug/speakers";
export const layout = "bare" as const;

export default function PublicSpeakersRoute() {
  const { eventSlug = "" } = useParams();
  const [state, retry] = useRouteLoad(() => getPublicSpeakerGallery(eventSlug), eventSlug);
  return (
    <ProductionBareFrame>
      {state.status === "loading" ? (
        <RouteLoading label="Loading public speakers" />
      ) : state.status === "error" ? (
        <RouteFailure message={state.message} onRetry={retry} />
      ) : (
        <PublicSpeakerEmbedContent gallery={state.data} />
      )}
    </ProductionBareFrame>
  );
}

export function PublicSpeakerEmbedContent({ gallery }: { readonly gallery: PublicSpeakerGallery }) {
  return (
    <div className="space-y-10">
      <ProductionHeader
        eyebrow="On stage / Meet the voices"
        title={`${gallery.event.name} speakers`}
        description={gallery.event.description ?? undefined}
        accent="coral"
        actions={
          <span className="border-2 border-[#171714] bg-[#caff4a] px-3 py-2 text-[10px] font-black uppercase tracking-[0.12em] shadow-[3px_3px_0_#171714]">
            {gallery.speakers.length} announced
          </span>
        }
      />
      <section aria-label={`${gallery.event.name} speaker lineup`}>
        <ProductionSectionLabel>Speaker lineup</ProductionSectionLabel>
        {gallery.speakers.length === 0 ? (
          <div className="border-[3px] border-[#171714] bg-[#fffdf7] p-8 text-center shadow-[7px_7px_0_#171714]">
            <p className="text-2xl font-black tracking-[-0.04em]">No speakers published</p>
            <p className="mt-2 text-sm font-medium text-[#665f52]">Public speakers will appear here after they are ready.</p>
          </div>
        ) : (
          <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {gallery.speakers.map((speaker, index) => (
              <li key={speaker.id}>
                <article className="group relative h-full overflow-hidden border-[3px] border-[#171714] bg-[#fffdf7] p-5 shadow-[7px_7px_0_#171714] transition-transform hover:-translate-y-1 sm:p-6">
                  <span
                    className={`absolute right-0 top-0 px-2.5 py-1.5 text-[9px] font-black uppercase tracking-[0.12em] ${index % 3 === 0 ? "bg-[#ff714f]" : index % 3 === 1 ? "bg-[#8fdcff]" : "bg-[#caff4a]"}`}
                  >
                    Voice {String(index + 1).padStart(2, "0")}
                  </span>
                  <div className="flex items-start gap-4 pr-12">
                    <div className="border-2 border-[#171714] bg-[#ece8dc] p-1 shadow-[3px_3px_0_#7857ff] [&>span]:rounded-none">
                      <Avatar name={speaker.displayName} src={speaker.headshotUrl ?? undefined} size="lg" />
                    </div>
                    <div className="min-w-0 pt-1">
                      <h2 className="text-xl font-black leading-tight tracking-[-0.04em] text-[#171714]">{speaker.displayName}</h2>
                      {(speaker.title || speaker.company) && (
                        <p className="mt-1 text-xs font-black uppercase tracking-[0.08em] text-[#665f52]">
                          {[speaker.title, speaker.company].filter(Boolean).join(" at ")}
                        </p>
                      )}
                    </div>
                  </div>
                  {speaker.bio && (
                    <p className="mt-6 border-t-2 border-[#171714] pt-4 text-sm font-medium leading-6 text-[#4f4a40]">{speaker.bio}</p>
                  )}
                  {speaker.links.length > 0 && (
                    <div className="mt-5 flex flex-wrap gap-2">
                      {speaker.links.map((link) => (
                        <a
                          key={`${link.label}-${link.url}`}
                          href={link.url}
                          className="border-2 border-[#171714] bg-[#f3efe3] px-2.5 py-1.5 text-[10px] font-black uppercase tracking-[0.08em] shadow-[2px_2px_0_#171714] transition-colors hover:bg-[#caff4a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7857ff] focus-visible:ring-offset-2"
                        >
                          {link.label}
                        </a>
                      ))}
                    </div>
                  )}
                </article>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
