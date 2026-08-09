import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError, apiFetch } from "@/client/api";
import {
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  PageHeader,
  Skeleton,
  Toaster,
  toast,
} from "@/ui";

interface EventSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  location: string | null;
}

export const path = "/";

export default function EventsHome() {
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const navigate = useNavigate();
  const [loadError, setLoadError] = useState<"unauthenticated" | "failed" | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void apiFetch<EventSummary[]>("/api/v1/events")
      .then((loadedEvents) => {
        setEvents(loadedEvents);
        setLoadError(null);
      })
      .catch((error) => {
        const unauthenticated = error instanceof ApiError && error.status === 401;
        setLoadError(unauthenticated ? "unauthenticated" : "failed");
        if (!unauthenticated) {
          toast(error instanceof Error ? error.message : "Could not load events", { tone: "danger" });
        }
      });
  }, []);

  const create = async () => {
    setSaving(true);
    try {
      const event = await apiFetch<EventSummary>("/api/v1/events", {
        method: "POST",
        body: { name, slug },
      });
      setEvents((current) => [...(current ?? []), event]);
      setOpen(false);
      setName("");
      setSlug("");
      toast("Event created", { tone: "success" });
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not create event", { tone: "danger" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Events"
        description="Plan programs, speakers, and every detail in one place."
        actions={
          events !== null && loadError === null ? (
            <Button onClick={() => setOpen(true)}>Create event</Button>
          ) : undefined
        }
      />
      {loadError === "unauthenticated" ? (
        <EmptyState
          title="Sign in to start planning"
          description="Sign in, then create your first event to begin building the program."
          action={<Button className="min-h-11" onClick={() => navigate("/login")}>Sign in</Button>}
        />
      ) : loadError === "failed" ? (
        <EmptyState
          title="Events could not be loaded"
          description="Refresh the page to try again. Your event data has not been changed."
        />
      ) : events === null ? (
        <Skeleton />
      ) : events.length === 0 ? (
        <EmptyState
          title="Create your first event"
          description="Start with the basics, then invite your team and speakers."
          action={<Button onClick={() => setOpen(true)}>Create event</Button>}
        />
      ) : (
        events.map((event) => (
          <Link
            className="block text-inherit no-underline"
            key={event.id}
            to={`/e/${event.slug}`}
          >
            <Card title={event.name}>
              {event.description || event.location || "Ready to set up"}
            </Card>
          </Link>
        ))
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="Create an event">
        <Input label="Event name" value={name} onChange={(event) => setName(event.target.value)} />
        <Input label="Slug" value={slug} onChange={(event) => setSlug(event.target.value)} />
        <Button disabled={saving || !name || !slug} onClick={() => void create()}>
          {saving ? "Creating…" : "Create event"}
        </Button>
      </Modal>
      <Toaster />
    </>
  );
}

