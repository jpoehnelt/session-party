import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { Alert, AlertDescription, Button, Card, Checkbox, Input, PageHeader, Textarea, Toaster, toast } from "@/ui";
import { RouteFailure, RouteLoading, useRouteLoad } from "@/features/portal/components/route-state";
import type { ReusableSpeakerProfile, SaveMyProfileInput } from "../schema";
import { getMyProfile, saveMyProfile } from "./api";

export const path = "/speaker/profile";

const emptyProfile = {
  slug: "",
  displayName: "",
  title: null,
  company: null,
  bio: null,
  headshotUrl: null,
  links: [],
  visible: false,
  version: 0,
} as const;

function inputFromForm(profile: ReusableSpeakerProfile | null, form: HTMLFormElement): SaveMyProfileInput {
  const data = new FormData(form);
  const labels = data.getAll("linkLabel").map(String);
  const urls = data.getAll("linkUrl").map(String);
  return {
    expectedVersion: profile?.version ?? 0,
    slug: String(data.get("slug") ?? "").trim(),
    displayName: String(data.get("displayName") ?? "").trim(),
    title: String(data.get("title") ?? "").trim() || null,
    company: String(data.get("company") ?? "").trim() || null,
    bio: String(data.get("bio") ?? "").trim() || null,
    headshotUrl: String(data.get("headshotUrl") ?? "").trim() || null,
    links: urls.flatMap((url, index) => {
      const normalizedUrl = url.trim();
      const label = labels[index]?.trim();
      return normalizedUrl && label ? [{ label, url: normalizedUrl }] : [];
    }),
    visible: data.get("visible") === "on",
  };
}

export default function ReusableProfileRoute() {
  const [state, retry] = useRouteLoad(getMyProfile, "speaker-profile");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkCount, setLinkCount] = useState(1);

  if (state.status === "loading") return <RouteLoading label="Loading reusable speaker profile" />;
  if (state.status === "error") return <RouteFailure message={state.message} onRetry={retry} />;
  const profile = state.data;
  const value = profile ?? emptyProfile;
  const count = Math.max(linkCount, value.links.length, 1);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const saved = await saveMyProfile(inputFromForm(profile, event.currentTarget));
      toast("Reusable speaker profile saved", { tone: "success" });
      setLinkCount(Math.max(saved.links.length, 1));
      retry();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Speaker profile could not be saved";
      setError(message);
      toast(message, { tone: "danger" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Reusable speaker profile"
        description="Keep one speaker-owned profile, then deliberately copy it into each event. Event copies never change behind an organizer's back."
        actions={profile?.visible ? <Link className="inline-flex h-10 items-center border-2 border-line-strong bg-surface px-4 text-sm font-black uppercase tracking-[0.075em] text-ink shadow-button" to={`/speakers/${profile.slug}`}>View public profile</Link> : undefined}
      />
      <Alert tone="neutral">
        <AlertDescription>
          Saving here does not overwrite submitted or approved event profiles. Each event keeps its own reviewed snapshot.
        </AlertDescription>
      </Alert>
      {error && <Alert tone="danger"><AlertDescription>{error}</AlertDescription></Alert>}
      <Card className="max-w-3xl p-6">
        <form className="space-y-6" onSubmit={(event) => void submit(event)}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input name="displayName" label="Display name" required defaultValue={value.displayName} />
            <Input name="slug" label="Public URL name" hint="Lowercase letters, numbers, and hyphens." required defaultValue={value.slug} />
            <Input name="title" label="Title" defaultValue={value.title ?? ""} />
            <Input name="company" label="Company" defaultValue={value.company ?? ""} />
          </div>
          <Textarea name="bio" label="Biography" rows={7} defaultValue={value.bio ?? ""} />
          <Input name="headshotUrl" type="url" label="Headshot URL" hint="HTTPS image URL used on your public profile." defaultValue={value.headshotUrl ?? ""} />
          <fieldset className="space-y-3">
            <legend className="text-sm font-bold">Links</legend>
            {Array.from({ length: count }, (_, index) => (
              <div className="grid gap-3 sm:grid-cols-[12rem_1fr]" key={index}>
                <Input name="linkLabel" aria-label={`Link ${index + 1} label`} placeholder="Website" defaultValue={value.links[index]?.label ?? ""} />
                <Input name="linkUrl" type="url" aria-label={`Link ${index + 1} URL`} placeholder="https://example.com" defaultValue={value.links[index]?.url ?? ""} />
              </div>
            ))}
            <Button type="button" variant="secondary" onClick={() => setLinkCount(count + 1)}>Add another link</Button>
          </fieldset>
          <Checkbox
            name="visible"
            label="Publish my reusable profile"
            description="Makes this profile and only your already-public event appearances available at your public URL."
            defaultChecked={value.visible}
          />
          <Button type="submit" loading={saving}>Save reusable profile</Button>
        </form>
      </Card>
      <Toaster />
    </div>
  );
}
