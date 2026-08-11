import { useParams, useSearchParams } from "react-router";
import { Avatar } from "@/ui";
import {
  DEFAULT_EMBED_DESIGN,
  embedDesignFromSearch,
  embedDesignStyle,
  embedTypographyClass,
  type EmbedDesign,
} from "@/features/publication/embed-design";
import type { PublicSpeakerGallery } from "../schema";
import { getPublicSpeakerGallery } from "./api";
import { RouteFailure, RouteLoading, useRouteLoad } from "../components/route-state";
import { ProductionBareFrame, ProductionHeader, ProductionSectionLabel } from "../components/production-ui";
import { publicEventSpeakerPath } from "@/features/publication/links";

export const path = "/embed/:eventSlug/speakers";
export const layout = "bare" as const;

export default function PublicSpeakersRoute() {
  const { eventSlug = "" } = useParams();
  const [searchParams] = useSearchParams();
  const design = embedDesignFromSearch(searchParams);
  const [state, retry] = useRouteLoad(() => getPublicSpeakerGallery(eventSlug), eventSlug);
  return (
    <ProductionBareFrame
      className={embedTypographyClass(design.aesthetic)}
      contentClassName={design.aesthetic === "editorial" ? "max-w-6xl" : ""}
      showGrid={design.aesthetic === "bold"}
      style={embedDesignStyle(design)}
    >
      {state.status === "loading" ? (
        <RouteLoading label="Loading public speakers" />
      ) : state.status === "error" ? (
        <RouteFailure message={state.message} onRetry={retry} />
      ) : (
        <PublicSpeakerEmbedContent gallery={state.data} design={design} />
      )}
    </ProductionBareFrame>
  );
}

export function PublicSpeakerEmbedContent({
  gallery,
  design = DEFAULT_EMBED_DESIGN,
  preset = "speakerGallery",
}: {
  readonly gallery: PublicSpeakerGallery;
  readonly design?: EmbedDesign;
  readonly preset?: "speakerList" | "speakerGallery";
}) {
  return (
    <div
      className={`space-y-10 ${embedTypographyClass(design.aesthetic)}`}
      data-embed-aesthetic={design.aesthetic}
      data-embed-preset={preset}
      style={embedDesignStyle(design)}
    >
      <ProductionHeader
        eyebrow="On stage / Meet the voices"
        title={`${gallery.event.name} speakers`}
        description={gallery.event.description ?? undefined}
        accent="coral"
        treatment={design.aesthetic}
        actions={
          <span className={`bg-accent-soft px-3 py-2 text-[10px] font-black uppercase tracking-[0.12em] ${
            design.aesthetic === "bold" ? "border-2 border-line-strong shadow-[3px_3px_0_#171714]" : design.aesthetic === "minimal" ? "rounded-full" : "border border-line-strong"
          }`}>
            {gallery.speakers.length} announced
          </span>
        }
      />
      <section aria-label={`${gallery.event.name} speaker lineup`}>
        <ProductionSectionLabel>Speaker lineup</ProductionSectionLabel>
        {gallery.speakers.length === 0 ? (
          <div className={`bg-surface p-8 text-center ${
            design.aesthetic === "bold" ? "border-[3px] border-line-strong shadow-[7px_7px_0_#171714]" : design.aesthetic === "minimal" ? "rounded-2xl border border-line shadow-none" : "border-y border-line-strong bg-transparent shadow-none"
          }`}>
            <p className="text-2xl font-black tracking-[-0.04em]">No speakers published</p>
            <p className="mt-2 text-sm font-medium text-ink-faint">Public speakers will appear here after they are ready.</p>
          </div>
        ) : (
          <ul className={preset === "speakerList" ? "grid gap-4" : `grid gap-6 sm:grid-cols-2 ${design.aesthetic === "editorial" ? "lg:grid-cols-2" : "lg:grid-cols-3"}`}>
            {gallery.speakers.map((speaker, index) => (
              <li key={speaker.id}>
                <article className={`group relative h-full overflow-hidden bg-surface p-5 sm:p-6 ${
                  design.aesthetic === "bold"
                    ? "border-[3px] border-line-strong shadow-[7px_7px_0_#171714] transition-transform hover:-translate-y-1"
                    : design.aesthetic === "minimal"
                      ? "rounded-2xl border border-line shadow-none transition-colors hover:border-accent"
                      : "border-y border-line-strong bg-transparent shadow-none"
                }`}>
                  <span
                    className={`absolute right-0 top-0 px-2.5 py-1.5 text-[9px] font-black uppercase tracking-[0.12em] ${
                      design.aesthetic === "bold"
                        ? index % 3 === 0 ? "bg-production-coral text-on-accent" : index % 3 === 1 ? "bg-production-sky" : "bg-production-lime"
                        : design.aesthetic === "minimal" ? "rounded-bl-lg bg-accent-soft text-accent-deep" : "border-b border-l border-line-strong bg-transparent text-accent-deep"
                    }`}
                  >
                    Voice {String(index + 1).padStart(2, "0")}
                  </span>
                  <div className="flex items-start gap-4 pr-12">
                    <div className={`bg-surface-muted p-1 ${
                      design.aesthetic === "bold" ? "border-2 border-line-strong shadow-[3px_3px_0_var(--color-accent)] [&>span]:rounded-none" : design.aesthetic === "minimal" ? "rounded-full [&>span]:rounded-full" : "border border-line-strong [&>span]:rounded-none"
                    }`}>
                      <Avatar name={speaker.displayName} src={speaker.headshotUrl ?? undefined} size="lg" />
                    </div>
                    <div className="min-w-0 pt-1">
                      <h2 className={`text-xl leading-tight text-ink ${design.aesthetic === "editorial" ? "font-serif font-medium tracking-[-0.02em]" : "font-black tracking-[-0.04em]"}`}>
                        <a className="underline decoration-2 underline-offset-4 hover:text-accent-deep" href={publicEventSpeakerPath(gallery.event.slug, speaker)}>{speaker.displayName}</a>
                      </h2>
                      {(speaker.title || speaker.company) && (
                        <p className="mt-1 text-xs font-black uppercase tracking-[0.08em] text-ink-secondary">
                          {[speaker.title, speaker.company].filter(Boolean).join(" at ")}
                        </p>
                      )}
                    </div>
                  </div>
                  {speaker.bio && (
                    <p className={`mt-6 border-line-strong pt-4 text-sm font-medium leading-6 text-ink-secondary ${design.aesthetic === "bold" ? "border-t-2" : "border-t"}`}>{speaker.bio}</p>
                  )}
                  {speaker.links.length > 0 && (
                    <div className="mt-5 flex flex-wrap gap-2">
                      {speaker.links.map((link) => (
                        <a
                          key={`${link.label}-${link.url}`}
                          href={link.url}
                          className={`bg-canvas px-2.5 py-1.5 text-[10px] font-black uppercase tracking-[0.08em] transition-colors hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${
                            design.aesthetic === "bold" ? "border-2 border-line-strong shadow-[2px_2px_0_#171714]" : design.aesthetic === "minimal" ? "rounded-full border border-line shadow-none" : "border-b border-line-strong shadow-none"
                          }`}
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
