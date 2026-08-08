/**
 * FROZEN CONTRACT — integrator-only after spine-v1.
 * Path conventions. Slices mount under these; codegen wires them.
 *
 * REST (Hono):
 *   /api/v1/events/:eventId/<slice>/...   — event-scoped (auth: member unless noted)
 *   /api/v1/<slice>/...                   — global (events list, auth, uploads)
 *   Public, no-auth surfaces: /api/v1/public/...  (submit form, embeds)
 *
 * Client routes (React, file-based from features/<slice>/routes/):
 *   /                                      — events home
 *   /e/:eventSlug/<surface>                — organizer app (agenda, review, ...)
 *   /e/:eventSlug/portal/...               — speaker portal
 *   /submit/:eventSlug/:formId             — public CFP page
 *   /embed/:eventSlug/(speakers|schedule)  — embeddable, chrome-less
 *
 * Realtime: PartySocket party "event-room", room = eventId, path /parties/event-room/:eventId
 */

export const API = "/api/v1";
export const PARTY = "event-room";

export const clientRoutes = {
  home: "/",
  event: (slug: string) => `/e/${slug}`,
  portal: (slug: string) => `/e/${slug}/portal`,
  submit: (slug: string, formId: string) => `/submit/${slug}/${formId}`,
  embedSpeakers: (slug: string) => `/embed/${slug}/speakers`,
  embedSchedule: (slug: string) => `/embed/${slug}/schedule`,
} as const;
