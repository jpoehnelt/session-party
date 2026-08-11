import { useEffect, useMemo, useState } from "react";
import { copyText } from "@/client/clipboard";
import type { PublishedAgenda } from "@/features/agenda/schema";
import { Button, Card, Checkbox, EmptyState, Input, Select, Skeleton } from "@/ui";
import {
  createEmbedDefinition,
  listEmbedDefinitions,
  updateEmbedDefinition,
} from "../api";
import { DEFAULT_EMBED_DESIGN, normalizeEmbedAccent, type EmbedAesthetic } from "../embed-design";
import { SCHEDULE_EMBED_FIELDS } from "../embed-content";
import { publishedScheduleIcsPath, publishedScheduleJsonPath } from "../feeds";
import type { EmbedDefinition, EmbedPreset, EmbedWidget } from "../schema";

const PRESETS: Readonly<Record<EmbedWidget, readonly { readonly value: EmbedPreset; readonly label: string; readonly fields: readonly string[] }[]>> = {
  schedule: [
    { value: "sessions", label: "Sessions", fields: ["title", "speakers", "description", "track"] },
    { value: "agenda", label: "Agenda", fields: ["title", "time", "room", "track", "speakers"] },
    { value: "itinerary", label: "Schedule itinerary", fields: ["title", "time", "room"] },
  ],
  speakerGallery: [
    { value: "speakerList", label: "Speaker list", fields: [] },
    { value: "speakerGallery", label: "Speaker gallery", fields: [] },
  ],
};

export function stableEmbedPath(definition: Pick<EmbedDefinition, "eventSlug" | "id">): string {
  return `/embed/${encodeURIComponent(definition.eventSlug)}/${encodeURIComponent(definition.id)}`;
}
export function stableEmbedCode(definition: Pick<EmbedDefinition, "eventSlug" | "id" | "name">, origin: string): string {
  return `<iframe title="${definition.name.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}" src="${origin}${stableEmbedPath(definition)}" style="width:100%;min-height:720px;border:0" loading="lazy"></iframe>`;
}

export function EmbedManager({ agenda }: { readonly agenda: PublishedAgenda }) {
  const [definitions, setDefinitions] = useState<readonly EmbedDefinition[] | undefined>();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("Main schedule");
  const [widget, setWidget] = useState<EmbedWidget>("schedule");
  const [preset, setPreset] = useState<EmbedPreset>("agenda");
  const [aesthetic, setAesthetic] = useState<EmbedAesthetic>(DEFAULT_EMBED_DESIGN.aesthetic);
  const [accent, setAccent] = useState(DEFAULT_EMBED_DESIGN.accent);
  const [trackId, setTrackId] = useState("");
  const [fields, setFields] = useState<ReadonlySet<string>>(new Set(PRESETS.schedule[1]!.fields));
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const origin = typeof window === "undefined" ? "https://sessionparty.com" : window.location.origin;

  useEffect(() => {
    let active = true;
    void listEmbedDefinitions(agenda.eventId).then((items) => {
      if (active) setDefinitions(items);
    }).catch((error: unknown) => {
      if (active) {
        setDefinitions([]);
        setStatus(error instanceof Error ? error.message : "Could not load embeds");
      }
    });
    return () => { active = false; };
  }, [agenda.eventId]);

  const selected = useMemo(() => definitions?.find(({ id }) => id === editingId) ?? null, [definitions, editingId]);
  const tracks = [...new Map(agenda.talks.flatMap((talk) =>
    talk.trackId && talk.track ? [[talk.trackId, { id: talk.trackId, name: talk.track }] as const] : []
  )).values()].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));

  const chooseWidget = (next: EmbedWidget) => {
    const nextPreset = PRESETS[next][0]!;
    setWidget(next);
    setPreset(nextPreset.value);
    setFields(new Set(nextPreset.fields));
    setTrackId("");
  };
  const choosePreset = (next: EmbedPreset) => {
    setPreset(next);
    const option = PRESETS[widget].find(({ value }) => value === next);
    if (option) setFields(new Set(option.fields));
  };
  const reset = () => {
    setEditingId(null);
    setName("Main schedule");
    setWidget("schedule");
    setPreset("agenda");
    setAesthetic(DEFAULT_EMBED_DESIGN.aesthetic);
    setAccent(DEFAULT_EMBED_DESIGN.accent);
    setTrackId("");
    setFields(new Set(PRESETS.schedule[1]!.fields));
  };
  const edit = (definition: EmbedDefinition) => {
    setEditingId(definition.id);
    setName(definition.name);
    setWidget(definition.widget);
    setPreset(definition.preset);
    setAesthetic(definition.aesthetic);
    setAccent(definition.accent);
    setTrackId(definition.trackId ?? tracks.find(({ name }) => name === definition.track)?.id ?? "");
    setFields(new Set(definition.fields));
    setStatus(`Editing “${definition.name}”.`);
  };
  const save = async () => {
    setSaving(true);
    setStatus("");
    try {
      const configuration = {
        eventId: agenda.eventId,
        name,
        widget,
        preset,
        aesthetic,
        accent: normalizeEmbedAccent(accent),
        trackId: widget === "schedule" ? trackId || null : null,
        track: widget === "schedule" ? tracks.find(({ id }) => id === trackId)?.name ?? null : null,
        fields: widget === "schedule" ? [...fields] as (typeof SCHEDULE_EMBED_FIELDS)[number][] : [],
        enabled: selected?.enabled ?? true,
      } as const;
      const saved = selected
        ? await updateEmbedDefinition({ ...configuration, embedId: selected.id, expectedVersion: selected.version })
        : await createEmbedDefinition(configuration);
      setDefinitions((current = []) => [saved, ...current.filter(({ id }) => id !== saved.id)]);
      setEditingId(saved.id);
      setStatus(`${selected ? "Updated" : "Created"} “${saved.name}”. Its embed URL is stable.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save embed");
    } finally {
      setSaving(false);
    }
  };
  const toggle = async (definition: EmbedDefinition) => {
    try {
      const saved = await updateEmbedDefinition({
        eventId: definition.eventId,
        embedId: definition.id,
        expectedVersion: definition.version,
        name: definition.name,
        widget: definition.widget,
        preset: definition.preset,
        aesthetic: definition.aesthetic,
        accent: definition.accent,
        trackId: definition.trackId,
        track: definition.track,
        fields: [...definition.fields],
        enabled: !definition.enabled,
      });
      setDefinitions((current = []) => current.map((item) => item.id === saved.id ? saved : item));
      setStatus(saved.enabled ? `Enabled “${saved.name}”.` : `Disabled “${saved.name}”; its public URL is now unavailable.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not update embed");
    }
  };

  return (
    <section className="space-y-6" aria-labelledby="embed-manager-title">
      <div>
        <p className="text-[10px] font-black uppercase tracking-[0.16em] text-accent-deep">Live event data</p>
        <h2 id="embed-manager-title" className="mt-1 text-3xl font-black tracking-[-0.045em]">Embed &amp; share</h2>
        <p className="mt-2 max-w-3xl text-sm font-medium leading-6 text-ink-secondary">Create one of two embeddable widgets. Presets change its presentation; saved URLs remain stable when you edit their configuration.</p>
      </div>

      <Card title={selected ? `Edit ${selected.name}` : "Create an embed"} titleLevel={3}>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Input label="Embed name" value={name} onChange={(event) => setName(event.currentTarget.value)} />
          <Select label="Widget" value={widget} onChange={(event) => chooseWidget(event.currentTarget.value as EmbedWidget)}>
            <option value="schedule">Schedule widget</option>
            <option value="speakerGallery">Speaker gallery widget</option>
          </Select>
          <Select label="Preset" value={preset} onChange={(event) => choosePreset(event.currentTarget.value as EmbedPreset)}>
            {PRESETS[widget].map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </Select>
          <Select label="Design aesthetic" value={aesthetic} onChange={(event) => setAesthetic(event.currentTarget.value as EmbedAesthetic)}>
            <option value="bold">Bold &amp; energetic</option><option value="minimal">Clean &amp; minimal</option><option value="editorial">Editorial</option>
          </Select>
          <Input label="Brand color" type="color" value={accent} onChange={(event) => setAccent(event.currentTarget.value)} />
          {widget === "schedule" ? <Select label="Track filter" value={trackId} onChange={(event) => setTrackId(event.currentTarget.value)}>
            <option value="">All tracks</option>{tracks.map((track) => <option key={track.id} value={track.id}>{track.name}</option>)}
          </Select> : null}
        </div>
        {widget === "schedule" ? <fieldset className="mt-5 border-2 border-line-strong bg-surface-muted p-4">
          <legend className="px-2 text-[10px] font-black uppercase tracking-[0.14em] text-accent-deep">Included fields</legend>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{SCHEDULE_EMBED_FIELDS.map((field) => <Checkbox key={field} label={field[0]!.toUpperCase() + field.slice(1)} checked={fields.has(field)} onChange={() => setFields((current) => { const next = new Set(current); if (next.has(field)) next.delete(field); else next.add(field); return next; })} />)}</div>
        </fieldset> : null}
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button onClick={() => void save()} loading={saving}>{selected ? "Update embed" : "Create embed"}</Button>
          {selected ? <Button variant="secondary" onClick={reset}>Create another</Button> : null}
          <span className="text-xs font-bold text-ink-secondary" role="status" aria-live="polite">{status}</span>
        </div>
      </Card>

      <Card title={`Saved embeds (${definitions?.length ?? 0})`} titleLevel={3}>
        {definitions === undefined ? <Skeleton className="min-h-40 rounded-none" /> : definitions.length === 0 ? <EmptyState title="No saved embeds" description="Create a schedule or speaker gallery embed to get stable code." /> : <ul className="space-y-4">{definitions.map((definition) => {
          const code = stableEmbedCode(definition, origin);
          return <li key={definition.id} className="border-2 border-line-strong bg-surface-muted p-4">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-black">{definition.name}</p><p className="text-xs text-ink-secondary">{definition.widget === "schedule" ? "Schedule widget" : "Speaker gallery widget"} · {definition.preset} · v{definition.version} · {definition.enabled ? "Enabled" : "Disabled"}</p></div><div className="flex gap-2"><Button size="sm" variant="secondary" onClick={() => edit(definition)}>Edit</Button><Button size="sm" variant={definition.enabled ? "danger" : "secondary"} onClick={() => void toggle(definition)}>{definition.enabled ? "Disable" : "Enable"}</Button></div></div>
            <textarea className="mt-3 min-h-28 w-full border-2 border-line-strong bg-ink p-3 font-mono text-xs text-production-lime" readOnly aria-label={`${definition.name} embed code`} value={code} />
            <div className="mt-3 flex flex-wrap gap-3"><Button size="sm" disabled={!definition.enabled} onClick={() => void copyText(code).then(() => setStatus(`Copied “${definition.name}”.`))}>Copy embed code</Button><a className="inline-flex border-2 border-line-strong bg-production-lime px-3 py-2 text-[10px] font-black uppercase tracking-[0.1em] text-ink" href={stableEmbedPath(definition)}>Preview</a></div>
          </li>;
        })}</ul>}
        <p className="mt-4 text-xs font-medium leading-5 text-ink-secondary">Embed code uses a documented 720px minimum height and responsive 100% width. The iframe is lazy-loaded; host pages may adjust the height for their layout.</p>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Public links" titleLevel={3}><p className="mb-3 text-sm text-ink-secondary">Share full public pages without embedding them.</p><div className="flex flex-wrap gap-2"><Button size="sm" variant="secondary" onClick={() => void copyText(`${origin}/event/${agenda.eventSlug}/schedule`)}>Copy schedule page</Button><Button size="sm" variant="secondary" onClick={() => void copyText(`${origin}/event/${agenda.eventSlug}/gallery`)}>Copy speaker page</Button></div></Card>
        <Card title="Feeds & integrations" titleLevel={3}><p className="mb-3 text-sm text-ink-secondary">Use JSON for integrations and iCalendar for calendar subscriptions. These are feeds, not widgets.</p><div className="flex flex-wrap gap-2"><Button size="sm" variant="secondary" onClick={() => void copyText(`${origin}${publishedScheduleJsonPath(agenda.eventSlug)}`)}>Copy JSON feed</Button><Button size="sm" variant="secondary" onClick={() => void copyText(`${origin}${publishedScheduleIcsPath(agenda.eventSlug)}`)}>Copy iCalendar feed</Button></div></Card>
      </div>
    </section>
  );
}
