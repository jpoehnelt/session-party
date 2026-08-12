import { useEffect, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { ApiError, apiFetch } from "@/client/api";
import { loginPathForLocation } from "@/client/return-to";
import { Button, Card, Dropzone, EmptyState, Input, Select, Spinner } from "@/ui";
import { applyBrandTheme, brandAssetUrl, deriveBrandColors, useBrand } from "../components/client";
import {
  BrandAsset,
  InstallationBrandAdmin,
  type BrandAssetKind,
  type InstallationBrandAdmin as BrandAdmin,
} from "../schema";

export const path = "/setup";
export const layout = "bare" as const;

const steps = [
  "Organization",
  "Assets",
  "Color",
  "Typography",
  "Appearance",
  "Email",
  "Preview",
  "Finish",
] as const;

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
};

async function uploadAsset(file: File, kind: BrandAssetKind) {
  return apiFetch("/api/v1/brand/assets", {
    method: "POST",
    body: {
      kind,
      filename: file.name,
      contentType: file.type || "application/octet-stream",
      contentBase64: toBase64(new Uint8Array(await file.arrayBuffer())),
    },
    schema: BrandAsset,
  });
}

function BrandPreview({ brand }: { readonly brand: BrandAdmin }) {
  const colors = deriveBrandColors(brand.primaryColor);
  return (
    <div className="overflow-hidden rounded-card border-2 border-line-strong bg-canvas shadow-card">
      <div className="flex items-center gap-3 bg-ink px-5 py-4 text-on-ink">
        {brand.logoAssetId ? (
          <img className="max-h-10 max-w-32 object-contain" src={brandAssetUrl(brand.logoAssetId)!} alt="" />
        ) : (
          <span className="grid size-10 place-items-center rounded-control border-2 border-on-accent bg-accent text-xs font-black text-on-accent">
            {brand.name.slice(0, 2).toUpperCase() || "SP"}
          </span>
        )}
        <strong>{brand.name || "Your organization"}</strong>
      </div>
      <div className="grid gap-5 p-6 sm:grid-cols-[1fr_auto] sm:items-end">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.14em] text-accent-deep">Live preview</p>
          <h2 className="mt-2 text-3xl font-black tracking-[-0.05em]">A consistent home for every event.</h2>
          <p className="mt-3 max-w-lg text-sm text-ink-secondary">The selected color drives buttons, focus states, links, and readable foreground colors automatically.</p>
        </div>
        <Button>Primary action</Button>
      </div>
      <div className="flex flex-wrap gap-3 border-t-2 border-line bg-surface px-6 py-4 text-xs font-bold">
        <span>Accent {colors.accent}</span>
        <span>Contrast {colors.contrast.toFixed(1)}:1</span>
        <span>Radius {brand.radius}</span>
      </div>
    </div>
  );
}

export default function SetupPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { brand: currentBrand, setBrand } = useBrand();
  const [brand, setDraft] = useState<BrandAdmin | null>(null);
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<BrandAssetKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void apiFetch("/api/v1/brand/manage", { schema: InstallationBrandAdmin })
      .then(setDraft)
      .catch((cause) => {
        if (cause instanceof ApiError && cause.status === 401) {
          navigate(loginPathForLocation(location), { replace: true });
          return;
        }
        setError(cause instanceof Error ? cause.message : "Could not load brand settings");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (brand) applyBrandTheme(brand);
    return () => applyBrandTheme(currentBrand);
  }, [brand?.primaryColor, brand?.font, brand?.appearance, brand?.radius]);

  const set = <K extends keyof BrandAdmin>(key: K, value: BrandAdmin[K]) =>
    setDraft((current) => current ? { ...current, [key]: value } : current);

  async function upload(file: File, kind: BrandAssetKind) {
    setError(null);
    setUploading(kind);
    try {
      const asset = await uploadAsset(file, kind);
      set(kind === "installation-logo" ? "logoAssetId" : "faviconAssetId", asset.id);
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
      const saved = await apiFetch("/api/v1/brand", {
        method: "PATCH",
        body: {
          expectedVersion: brand.version,
          name: brand.name,
          logoAssetId: brand.logoAssetId,
          faviconAssetId: brand.faviconAssetId,
          primaryColor: brand.primaryColor,
          font: brand.font,
          appearance: brand.appearance,
          radius: brand.radius,
          senderName: brand.senderName,
          senderEmail: brand.senderEmail,
          replyToEmail: brand.replyToEmail,
        },
        schema: InstallationBrandAdmin,
      });
      setBrand(saved);
      navigate("/events", { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save brand settings");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <main className="grid min-h-dvh place-items-center bg-canvas"><div role="status" aria-label="Loading setup"><Spinner /></div></main>;
  if (!brand) return (
    <main className="grid min-h-dvh place-items-center bg-canvas p-6">
      <EmptyState title="Setup is unavailable" description={error ?? "Brand settings could not be loaded."} action={<Button onClick={() => navigate("/events")}>Return to events</Button>} />
    </main>
  );

  const atLastStep = step === steps.length - 1;
  return (
    <main className="min-h-dvh bg-canvas px-4 py-8 sm:px-6 lg:py-12">
      <form className="mx-auto max-w-5xl" onSubmit={save}>
        <header className="mb-7">
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-accent-deep">Installation setup</p>
          <h1 className="mt-2 text-4xl font-black tracking-[-0.055em] sm:text-5xl">Make Session Party yours.</h1>
          <p className="mt-3 max-w-2xl text-sm font-semibold text-ink-secondary">Branding lives in this installation. Change it whenever you need—no file edits or redeploys.</p>
        </header>
        <ol className="mb-7 grid grid-cols-4 gap-2 sm:grid-cols-8" aria-label="Setup progress">
          {steps.map((label, index) => <li key={label} className={`rounded-control border-2 px-2 py-2 text-center text-[10px] font-black uppercase ${index === step ? "border-line-strong bg-accent text-on-accent" : index < step ? "border-line bg-accent-soft text-ink" : "border-line bg-surface-muted text-ink-faint"}`}><span className="block">{index + 1}</span><span className="hidden sm:block">{label}</span></li>)}
        </ol>

        <Card className="min-h-[25rem]" title={`Step ${step + 1} · ${steps[step]}`}>
          {step === 0 && <div className="max-w-xl space-y-4"><Input label="Organization name" value={brand.name} maxLength={120} required onChange={(event) => set("name", event.target.value)} /><p className="text-sm text-ink-secondary">This appears on login, navigation, email, and the administration shell.</p></div>}
          {step === 1 && <div className="grid gap-6 md:grid-cols-2"><div><h2 className="mb-3 text-lg font-black">Logo</h2><Dropzone accept="image/png,image/jpeg,image/webp" multiple={false} disabled={uploading !== null} hint="PNG, JPEG, or WebP · up to 5 MB" onFiles={(files) => files[0] && void upload(files[0], "installation-logo")} />{brand.logoAssetId && <div className="mt-3 flex items-center gap-3"><img className="max-h-14 max-w-48 object-contain" src={brandAssetUrl(brand.logoAssetId)!} alt="Current organization logo" /><Button variant="ghost" onClick={() => set("logoAssetId", null)}>Remove</Button></div>}</div><div><h2 className="mb-3 text-lg font-black">Favicon</h2><Dropzone accept="image/png,image/x-icon,image/vnd.microsoft.icon" multiple={false} disabled={uploading !== null} hint="PNG or ICO · up to 1 MB" onFiles={(files) => files[0] && void upload(files[0], "installation-favicon")} />{brand.faviconAssetId && <div className="mt-3 flex items-center gap-3"><img className="size-10 object-contain" src={brandAssetUrl(brand.faviconAssetId)!} alt="Current favicon" /><Button variant="ghost" onClick={() => set("faviconAssetId", null)}>Remove</Button></div>}</div></div>}
          {step === 2 && <div className="max-w-xl space-y-5"><Input label="Primary brand color" type="color" className="h-14 p-1" value={brand.primaryColor} onChange={(event) => set("primaryColor", event.target.value)} /><Input label="Hex value" value={brand.primaryColor} pattern="#[0-9a-fA-F]{6}" required onChange={(event) => set("primaryColor", event.target.value)} /><p className="text-sm text-ink-secondary">Hover, soft, deep, and readable foreground colors are derived automatically.</p></div>}
          {step === 3 && <div className="max-w-xl"><Select label="Font" value={brand.font} onChange={(event) => set("font", event.target.value as BrandAdmin["font"])}><option value="system">System</option><option value="inter">Inter</option><option value="manrope">Manrope</option><option value="source-sans">Source Sans</option></Select></div>}
          {step === 4 && <div className="grid max-w-2xl gap-5 sm:grid-cols-2"><Select label="Light and dark appearance" value={brand.appearance} onChange={(event) => set("appearance", event.target.value as BrandAdmin["appearance"])}><option value="system">Follow device</option><option value="light">Light</option><option value="dark">Dark</option></Select><Select label="Corner style" value={brand.radius} onChange={(event) => set("radius", event.target.value as BrandAdmin["radius"])}><option value="square">Square</option><option value="soft">Soft</option><option value="round">Round</option></Select></div>}
          {step === 5 && <div className="grid max-w-2xl gap-5 sm:grid-cols-2"><Input label="Sender name" value={brand.senderName} required onChange={(event) => set("senderName", event.target.value)} /><Input label="Sender email" type="email" value={brand.senderEmail ?? ""} hint="Must be authorized for your Cloudflare Email binding." onChange={(event) => set("senderEmail", event.target.value || null)} /><Input label="Reply-to email" type="email" value={brand.replyToEmail ?? ""} onChange={(event) => set("replyToEmail", event.target.value || null)} /></div>}
          {step === 6 && <BrandPreview brand={brand} />}
          {step === 7 && <div className="max-w-2xl space-y-5"><BrandPreview brand={brand} /><p className="text-sm font-semibold text-ink-secondary">Saving makes this identity live across login, navigation, browser metadata, email, and every event that inherits organization branding.</p></div>}
        </Card>
        {error && <p className="mt-5 rounded-control border-2 border-line-strong bg-danger-soft p-3 text-sm font-bold text-danger" role="alert">{error}</p>}
        <footer className="mt-6 flex items-center justify-between gap-3">
          <Button variant="secondary" disabled={step === 0 || saving} onClick={() => setStep((value) => Math.max(0, value - 1))}>Back</Button>
          {atLastStep ? <Button type="submit" loading={saving}>Save and continue</Button> : <Button onClick={() => setStep((value) => Math.min(steps.length - 1, value + 1))}>Continue</Button>}
        </footer>
      </form>
    </main>
  );
}
