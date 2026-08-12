import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiFetch } from "@/client/api";
import { EventBrand, InstallationBrand, type EventBrand as EventBrandValue, type InstallationBrand as InstallationBrandValue } from "../schema";
import { deriveBrandColors } from "../colors";

export { brandInitials, deriveBrandColors } from "../colors";

export const FALLBACK_BRAND: InstallationBrandValue = {
  configured: false,
  name: "Session Party",
  logoAssetId: null,
  faviconAssetId: null,
  primaryColor: "#896aff",
  font: "inter",
  appearance: "system",
  radius: "square",
  version: 0,
};

const fontStacks = {
  system: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  inter: '"Inter", "SF Pro Text", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  manrope: '"Manrope", "Avenir Next", ui-sans-serif, system-ui, sans-serif',
  "source-sans": '"Source Sans 3", "Source Sans Pro", ui-sans-serif, system-ui, sans-serif',
} as const;

const radii = {
  square: { card: "2px", control: "2px" },
  soft: { card: "10px", control: "7px" },
  round: { card: "20px", control: "999px" },
} as const;

const setVariable = (name: string, value: string) => document.documentElement.style.setProperty(name, value);

export function brandAssetUrl(assetId: string | null): string | null {
  return assetId ? `/api/v1/assets/${encodeURIComponent(assetId)}` : null;
}

function setFavicon(assetId: string | null) {
  const href = brandAssetUrl(assetId) ?? "/favicon.svg";
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="icon"], link[rel="shortcut icon"]')) {
    if (link.dataset.runtimeBrand !== "favicon") link.remove();
  }
  let favicon = document.querySelector<HTMLLinkElement>('link[data-runtime-brand="favicon"]');
  if (!favicon) {
    favicon = document.createElement("link");
    favicon.rel = "icon";
    favicon.dataset.runtimeBrand = "favicon";
    document.head.append(favicon);
  }
  favicon.href = href;
}

export function applyBrandTheme(
  brand: Pick<InstallationBrandValue, "name" | "primaryColor" | "font" | "appearance" | "radius"> & { faviconAssetId?: string | null },
) {
  const colors = deriveBrandColors(brand.primaryColor);
  setVariable("--color-accent", colors.accent);
  setVariable("--color-accent-hover", colors.hover);
  setVariable("--color-accent-soft", colors.soft);
  setVariable("--color-accent-deep", colors.deep);
  setVariable("--color-on-accent", colors.foreground);
  setVariable("--font-sans", fontStacks[brand.font]);
  setVariable("--radius-card", radii[brand.radius].card);
  setVariable("--radius-control", radii[brand.radius].control);
  const dark = brand.appearance === "dark"
    || brand.appearance === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.appearance = dark ? "dark" : "light";
  if (dark) {
    setVariable("--color-canvas", "#171714");
    setVariable("--color-surface", "#24231f");
    setVariable("--color-surface-muted", "#34322c");
    setVariable("--color-ink", "#fffdf7");
    setVariable("--color-ink-secondary", "#d8d1c3");
    setVariable("--color-ink-faint", "#aaa394");
    setVariable("--color-line", "#4f4a40");
    setVariable("--color-line-strong", "#fffdf7");
    setVariable("--color-on-ink", "#171714");
  } else {
    setVariable("--color-canvas", "#f3efe3");
    setVariable("--color-surface", "#fffdf7");
    setVariable("--color-surface-muted", "#e8e2d5");
    setVariable("--color-ink", "#171714");
    setVariable("--color-ink-secondary", "#4f4a40");
    setVariable("--color-ink-faint", "#665f52");
    setVariable("--color-line", "#cfc7b8");
    setVariable("--color-line-strong", "#171714");
    setVariable("--color-on-ink", "#fffdf7");
  }
  if ("faviconAssetId" in brand) setFavicon(brand.faviconAssetId ?? null);
  document.documentElement.dataset.brandReady = "true";
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

let bootBrand: InstallationBrandValue = FALLBACK_BRAND;

export async function initializeBrand(): Promise<InstallationBrandValue> {
  try {
    bootBrand = await apiFetch("/api/v1/brand", { schema: InstallationBrand });
  } catch {
    bootBrand = FALLBACK_BRAND;
  }
  applyBrandTheme(bootBrand);
  document.title = bootBrand.name;
  return bootBrand;
}

export async function fetchEventBrand(eventId: string): Promise<EventBrandValue> {
  return apiFetch(`/api/v1/events/${encodeURIComponent(eventId)}/brand`, { schema: EventBrand });
}

export function useEventBrand(eventId: string | undefined): EventBrandValue | null {
  const [brand, setBrand] = useState<EventBrandValue | null>(null);
  useEffect(() => {
    if (!eventId) {
      setBrand(null);
      return;
    }
    let current = true;
    void fetchEventBrand(eventId).then((value) => {
      if (current) setBrand(value);
    }).catch(() => {
      if (current) setBrand(null);
    });
    return () => { current = false; };
  }, [eventId]);
  return brand;
}

export function applyEventBrand(brand: EventBrandValue) {
  applyBrandTheme({
    name: brand.publicName,
    primaryColor: brand.effectivePrimaryColor,
    font: brand.font,
    appearance: brand.appearance,
    radius: brand.radius,
  });
  document.title = brand.publicName;
}

type BrandContextValue = {
  readonly brand: InstallationBrandValue;
  readonly setBrand: (brand: InstallationBrandValue) => void;
};

const BrandContext = createContext<BrandContextValue>({ brand: FALLBACK_BRAND, setBrand: () => undefined });

export function BrandProvider({ children }: { readonly children: ReactNode }) {
  const [brand, setBrandState] = useState(bootBrand);
  const value = useMemo<BrandContextValue>(() => ({
    brand,
    setBrand: (next) => {
      bootBrand = next;
      applyBrandTheme(next);
      setBrandState(next);
    },
  }), [brand]);
  return <BrandContext.Provider value={value}>{children}</BrandContext.Provider>;
}

export const useBrand = () => useContext(BrandContext);
