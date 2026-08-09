import { useEffect, useState, type FormEvent } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { Schema } from "effect";
import { ApiError, apiFetch } from "@/client/api";
import { loginPathForLocation } from "@/client/return-to";
import { Button, Card, EmptyState, Input, PageHeader, Skeleton, Textarea, Toaster, toast } from "@/ui";
import { EventOutput, UpdateEventInput, type EventOutput as EventMetadata, type UpdateEventInput as EventPatch } from "../schema";

export const path = "/e/:eventSlug/settings";

export type EventLoadError =
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "not-found" }
  | { readonly kind: "failed"; readonly message: string };

interface EventFormValues {
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly location: string;
  readonly timezone: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly accentColor: string;
}

export function fetchEventMetadata(eventSlug: string): Promise<EventMetadata> {
  return apiFetch<EventMetadata>(`/api/v1/events/${encodeURIComponent(eventSlug)}`, { schema: EventOutput });
}

export function updateEventMetadata(eventId: string, patch: EventPatch): Promise<EventMetadata> {
  return apiFetch<EventMetadata>(`/api/v1/events/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    body: patch,
    schema: EventOutput,
  });
}

interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

function wallTimeParts(value: Date, timezone: string): WallTime {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
    second: part("second"),
    millisecond: part("fractionalSecond"),
  };
}

function serializedWallTime(parts: WallTime): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}.${pad(parts.millisecond, 3)}`;
}

export function formatDateTimeForTimezone(value: Date | null, timezone: string): string {
  return value === null ? "" : serializedWallTime(wallTimeParts(value, timezone));
}

export function parseDateTimeInTimezone(value: string, timezone: string, label: string): number | null {
  if (value === "") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
  if (!match) throw new Error(`${label} must be a valid date and time.`);
  const requested: WallTime = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
    millisecond: Number((match[7] ?? "0").padEnd(3, "0")),
  };
  const wallTimeAsUtc = Date.UTC(
    requested.year,
    requested.month - 1,
    requested.day,
    requested.hour,
    requested.minute,
    requested.second,
    requested.millisecond,
  );
  const normalized = new Date(wallTimeAsUtc);
  if (
    normalized.getUTCFullYear() !== requested.year ||
    normalized.getUTCMonth() + 1 !== requested.month ||
    normalized.getUTCDate() !== requested.day ||
    normalized.getUTCHours() !== requested.hour ||
    normalized.getUTCMinutes() !== requested.minute ||
    normalized.getUTCSeconds() !== requested.second
  ) {
    throw new Error(`${label} must be a valid date and time.`);
  }

  let instant = wallTimeAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = new Date(instant);
    const zoned = wallTimeParts(candidate, timezone);
    const candidateWithoutMilliseconds = Math.trunc(candidate.getTime() / 1000) * 1000;
    const offset =
      Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, zoned.second) -
      candidateWithoutMilliseconds;
    instant = wallTimeAsUtc - offset;
  }

  if (serializedWallTime(wallTimeParts(new Date(instant), timezone)) !== serializedWallTime(requested)) {
    throw new Error(`${label} does not exist in ${timezone} because of a timezone transition.`);
  }
  return instant;
}

export function buildEventPatch(values: EventFormValues, originalEvent?: EventMetadata): EventPatch {
  const timezone = values.timezone.trim();
  const dateValue = (value: string, original: Date | null, label: string) => {
    if (
      originalEvent &&
      original &&
      timezone === originalEvent.timezone &&
      value === formatDateTimeForTimezone(original, originalEvent.timezone)
    ) {
      return original.getTime();
    }
    return parseDateTimeInTimezone(value, timezone, label);
  };
  const patch = {
    name: values.name.trim(),
    slug: values.slug,
    description: values.description === "" ? null : values.description,
    location: values.location === "" ? null : values.location,
    timezone,
    startsAt: dateValue(values.startsAt, originalEvent?.startsAt ?? null, "Start"),
    endsAt: dateValue(values.endsAt, originalEvent?.endsAt ?? null, "End"),
    accentColor: values.accentColor === "" ? null : values.accentColor,
  };

  try {
    return Schema.decodeUnknownSync(UpdateEventInput)(patch);
  } catch {
    throw new Error("Enter a name, a valid lowercase slug, and a timezone before saving.");
  }
}

function valuesFromEvent(event: EventMetadata): EventFormValues {
  return {
    name: event.name,
    slug: event.slug,
    description: event.description ?? "",
    location: event.location ?? "",
    timezone: event.timezone,
    startsAt: formatDateTimeForTimezone(event.startsAt, event.timezone),
    endsAt: formatDateTimeForTimezone(event.endsAt, event.timezone),
    accentColor: event.accentColor ?? "",
  };
}

function LoadingRegion() {
  return (
    <>
      <div role="status" aria-live="polite" aria-label="Loading event settings">
        <span className="sr-only">Loading event settings</span>
        <div className="space-y-5">
          <Skeleton className="h-20 motion-reduce:animate-none" />
          <Skeleton className="h-[38rem] motion-reduce:animate-none" />
        </div>
      </div>
      <Toaster />
    </>
  );
}

export interface EventSettingsPageProps {
  /** Seeds server-rendered route states in focused tests; production starts in loading. */
  readonly initialEvent?: EventMetadata | null;
  readonly initialLoadError?: EventLoadError | null;
  readonly initialSaveError?: string | null;
}

export default function EventSettingsPage({
  initialEvent,
  initialLoadError = null,
  initialSaveError = null,
}: EventSettingsPageProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { eventSlug = "" } = useParams();
  const [event, setEvent] = useState<EventMetadata | null | undefined>(initialEvent);
  const [loadError, setLoadError] = useState<EventLoadError | null>(initialLoadError);
  const [request, setRequest] = useState(0);

  useEffect(() => {
    let active = true;
    setEvent(undefined);
    setLoadError(null);
    void fetchEventMetadata(eventSlug)
      .then((loaded) => {
        if (!active) return;
        setEvent(loaded);
      })
      .catch((error) => {
        if (!active) return;
        setEvent(null);
        if (error instanceof ApiError && error.status === 401) {
          setLoadError({ kind: "unauthenticated" });
          return;
        }
        if (error instanceof ApiError && error.status === 404) {
          setLoadError({ kind: "not-found" });
          return;
        }
        const message = error instanceof Error ? error.message : "Could not load event settings";
        setLoadError({ kind: "failed", message });
        toast(message, { tone: "danger" });
      });

    return () => {
      active = false;
    };
  }, [eventSlug, request]);

  if (event === undefined) return <LoadingRegion />;

  if (event === null) {
    if (loadError?.kind === "unauthenticated") {
      return (
        <>
          <EmptyState
            title="Sign in to manage this event"
            description="Sign in to continue to this event's settings."
            action={
              <Button className="min-h-11" onClick={() => navigate(loginPathForLocation(location))}>
                Sign in
              </Button>
            }
          />
          <Toaster />
        </>
      );
    }

    const failed = loadError?.kind === "failed";
    return (
      <>
        <EmptyState
          title={failed ? "Could not load event settings" : "Event not found"}
          description={failed ? loadError.message : "The event may have moved or been removed."}
          action={
            failed ? (
              <Button className="min-h-11" onClick={() => setRequest((current) => current + 1)}>
                Try again
              </Button>
            ) : undefined
          }
        />
        <Toaster />
      </>
    );
  }

  const handleUnauthenticated = () => {
    setEvent(null);
    setLoadError({ kind: "unauthenticated" });
  };

  const handleSaved = (updated: EventMetadata) => {
    setEvent(updated);
    if (updated.slug !== eventSlug) {
      navigate(`/e/${encodeURIComponent(updated.slug)}/settings`, { replace: true });
    }
  };

  return (
    <>
      <PageHeader title="Event settings" description={`Manage persisted metadata for ${event.name}.`} />
      <EventSettingsForm
        key={`${event.id}:${event.version}`}
        event={event}
        initialSaveError={initialSaveError}
        onSaved={handleSaved}
        onUnauthenticated={handleUnauthenticated}
      />
      <Toaster />
    </>
  );
}

export interface EventSettingsFormProps {
  readonly event: EventMetadata;
  readonly initialSaveError?: string | null;
  readonly onSaved?: (event: EventMetadata) => void;
  readonly onUnauthenticated?: () => void;
}

export function EventSettingsForm({
  event,
  initialSaveError = null,
  onSaved,
  onUnauthenticated,
}: EventSettingsFormProps) {
  const [values, setValues] = useState<EventFormValues>(() => valuesFromEvent(event));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(initialSaveError);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const setValue = (field: keyof EventFormValues, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
  };

  const handleSubmit = async (formEvent: FormEvent<HTMLFormElement>) => {
    formEvent.preventDefault();
    setSaveError(null);
    setSavedMessage(null);

    let patch: EventPatch;
    try {
      patch = buildEventPatch(values, event);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Check the event metadata and try again.";
      setSaveError(message);
      return;
    }

    setSaving(true);
    try {
      const updated = await updateEventMetadata(event.id, patch);
      setSavedMessage("Event settings saved.");
      toast("Event settings saved.", { tone: "success" });
      onSaved?.(updated);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401 && onUnauthenticated) {
        onUnauthenticated();
        return;
      }
      const message = error instanceof Error ? error.message : "Could not save event settings";
      setSaveError(message);
      toast(message, { tone: "danger" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Event metadata">
      <form className="space-y-6" onSubmit={handleSubmit} aria-describedby={saveError ? "event-settings-error" : undefined}>
        {saveError ? (
          <div id="event-settings-error" role="alert" className="rounded-control border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
            {saveError}
          </div>
        ) : null}
        {savedMessage ? (
          <p role="status" aria-live="polite" className="text-sm text-success">
            {savedMessage}
          </p>
        ) : null}

        <div className="grid gap-5 md:grid-cols-2">
          <Input label="Event name" value={values.name} required maxLength={200} onChange={(change) => setValue("name", change.target.value)} />
          <Input
            label="Event slug"
            value={values.slug}
            required
            minLength={2}
            maxLength={80}
            pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
            hint="Lowercase letters, numbers, and single hyphens."
            onChange={(change) => setValue("slug", change.target.value)}
          />
        </div>

        <Textarea label="Description" value={values.description} onChange={(change) => setValue("description", change.target.value)} />

        <div className="grid gap-5 md:grid-cols-2">
          <Input label="Location" value={values.location} onChange={(change) => setValue("location", change.target.value)} />
          <Input label="Timezone" value={values.timezone} required placeholder="America/Los_Angeles" onChange={(change) => setValue("timezone", change.target.value)} />
          <Input label="Starts at" type="datetime-local" step="0.001" value={values.startsAt} onChange={(change) => setValue("startsAt", change.target.value)} />
          <Input label="Ends at" type="datetime-local" step="0.001" value={values.endsAt} onChange={(change) => setValue("endsAt", change.target.value)} />
          <Input
            label="Accent color"
            value={values.accentColor}
            placeholder="#2563eb"
            hint="Optional event accent value."
            onChange={(change) => setValue("accentColor", change.target.value)}
          />
        </div>

        <div className="flex justify-end">
          <Button type="submit" loading={saving} className="min-h-11">
            Save settings
          </Button>
        </div>
      </form>
    </Card>
  );
}
