import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { apiFetch } from "@/client/api";
import { Button, Card, Checkbox, Dropzone, EmptyState, Input, PageHeader, Skeleton, toast } from "@/ui";
import { brandAssetUrl, brandInitials, deriveBrandColors } from "../components/client";
import { BrandAsset, EventBrand, type BrandAssetKind, type EventBrand as EventBrandValue } from "../schema";

export const path = "/e/:eventSlug/appearance";
export const contentWidth = "compact" as const;

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
};

async function uploadEventAsset(file: File, kind: Extract<BrandAssetKind, "event-logo" | "event-banner">, eventId: string) {
  return apiFetch("/api/v1/brand/assets", {
    method: "POST",
    body: {
      kind,
      eventId,
      filename: file.name,
      contentType: file.type || "application/octet-stream",
      contentBase64: toBase64(new Uint8Array(await file.arrayBuffer())),
    },
    schema: BrandAsset,
  });
}

export default function EventAppearancePage() {
  const { eventSlug = "" } = useParams();
  const [brand, setBrand] = useState<EventBrandValue | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<BrandAssetKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    void apiFetch(`/api/v1/events/${encodeURIComponent(eventSlug)}/brand`, { schema: EventBrand })
      .then(setBrand)
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load event appearance"))
      .finally(() => setLoading(false));
  }, [eventSlug]);

  const set = <K extends keyof EventBrandValue>(key: K, value: EventBrandValue[K]) =>
    setBrand((current) => current ? { ...current, [key]: value } : current);

  async function upload(file: File, kind: "event-logo" | "event-banner") {
    if (!brand) return;
    setError(null);
    setUploading(kind);
    try {
      const asset = await uploadEventAsset(file, kind, brand.eventId);
      set(kind === "event-logo" ? "logoAssetId" : "bannerAssetId", asset.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not upload image");
    } finally {
      setUploading(null);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!brand) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await apiFetch(`/api/v1/events/${encodeURIComponent(brand.eventId)}/brand`, {
        method: "PATCH",
        body: {
          expectedVersion: brand.version,
          publicName: brand.publicName,
          inheritInstallationBrand: brand.inheritInstallationBrand,
          logoAssetId: brand.logoAssetId,
          bannerAssetId: brand.bannerAssetId,
          primaryColor: brand.primaryColor,
        },
        schema: EventBrand,
      });
      setBrand(saved);
      toast("Event appearance saved.", { tone: "success" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save event appearance");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div aria-label="Loading event appearance"><Skeleton className="h-16 w-2/3" /><Skeleton className="mt-8 h-80" /></div>;
  if (!brand) return <EmptyState title="Appearance unavailable" description={error ?? "This event could not be loaded."} />;

  const previewColor = brand.inheritInstallationBrand ? brand.effectivePrimaryColor : brand.primaryColor ?? brand.effectivePrimaryColor;
  const previewLogo = brand.inheritInstallationBrand ? brand.effectiveLogoAssetId : brand.logoAssetId ?? brand.effectiveLogoAssetId;
  const colors = deriveBrandColors(previewColor);

  return (
    <form onSubmit={save}>
      <PageHeader title="Event appearance" description={`Give ${brand.publicName} a public identity without changing the installation shell.`} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.8fr)]">
        <div className="space-y-6">
          <Card title="Brand source">
            <Checkbox
              label="Use organization branding"
              description="Enabled by default. Turn this off to override the public event name, logo, banner, and primary color."
              checked={brand.inheritInstallationBrand}
              onChange={(event) => set("inheritInstallationBrand", event.target.checked)}
            />
          </Card>
          <Card title="Public identity">
            <div className="space-y-5">
              <Input label="Public event name" value={brand.publicName} required maxLength={200} onChange={(event) => set("publicName", event.target.value)} />
              {!brand.inheritInstallationBrand && <>
                <Input label="Primary color" type="color" className="h-14 p-1" value={brand.primaryColor ?? brand.effectivePrimaryColor} onChange={(event) => set("primaryColor", event.target.value)} />
                <div className="grid gap-5 sm:grid-cols-2">
                  <div><h2 className="mb-3 text-sm font-black uppercase tracking-[0.08em]">Event logo</h2><Dropzone accept="image/png,image/jpeg,image/webp" multiple={false} disabled={uploading !== null} hint="PNG, JPEG, or WebP · up to 5 MB" onFiles={(files) => files[0] && void upload(files[0], "event-logo")} />{brand.logoAssetId && <Button className="mt-2" variant="ghost" onClick={() => set("logoAssetId", null)}>Use organization logo</Button>}</div>
                  <div><h2 className="mb-3 text-sm font-black uppercase tracking-[0.08em]">Event banner</h2><Dropzone accept="image/png,image/jpeg,image/webp" multiple={false} disabled={uploading !== null} hint="Wide images work best · up to 5 MB" onFiles={(files) => files[0] && void upload(files[0], "event-banner")} />{brand.bannerAssetId && <Button className="mt-2" variant="ghost" onClick={() => set("bannerAssetId", null)}>Remove banner</Button>}</div>
                </div>
              </>}
            </div>
          </Card>
        </div>
        <Card title="Public preview" className="h-fit lg:sticky lg:top-24">
          <div className="overflow-hidden rounded-card border-2 border-line-strong bg-canvas">
            {brand.bannerAssetId && !brand.inheritInstallationBrand ? <img className="aspect-[3/1] w-full object-cover" src={brandAssetUrl(brand.bannerAssetId)!} alt="Event banner preview" /> : null}
            <div className="p-5">
              <div className="flex items-center gap-3">
                {previewLogo ? <img className="max-h-12 max-w-36 object-contain" src={brandAssetUrl(previewLogo)!} alt="" /> : <span className="grid size-12 place-items-center rounded-control border-2 border-line-strong font-black" style={{ background: colors.accent, color: colors.foreground }}>{brandInitials(brand.publicName)}</span>}
                <h2 className="text-2xl font-black tracking-[-0.04em]">{brand.publicName}</h2>
              </div>
              <button className="mt-6 min-h-10 rounded-control border-2 border-line-strong px-4 text-sm font-black uppercase" style={{ background: colors.accent, color: colors.foreground }} type="button">Submit a proposal</button>
            </div>
          </div>
          <p className="mt-4 text-xs font-semibold text-ink-secondary">CFP, speaker portal, public schedule, and embeds resolve this layer at runtime.</p>
        </Card>
      </div>
      {error && <p className="mt-6 rounded-control border-2 border-line-strong bg-danger-soft p-3 text-sm font-bold text-danger" role="alert">{error}</p>}
      <div className="mt-6 flex justify-end"><Button type="submit" loading={saving}>Save appearance</Button></div>
    </form>
  );
}
