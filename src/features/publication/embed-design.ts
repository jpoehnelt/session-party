import type { CSSProperties } from "react";

export const EMBED_AESTHETICS = ["bold", "minimal", "editorial"] as const;

export type EmbedAesthetic = (typeof EMBED_AESTHETICS)[number];

export interface EmbedDesign {
  readonly aesthetic: EmbedAesthetic;
  readonly accent: string;
}

export const DEFAULT_EMBED_DESIGN: EmbedDesign = {
  aesthetic: "bold",
  accent: "#635BFF",
};

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function normalizeEmbedAccent(value: string | null | undefined): string {
  return value && HEX_COLOR.test(value) ? value.toUpperCase() : DEFAULT_EMBED_DESIGN.accent;
}

export function embedDesignFromSearch(search: string | URLSearchParams): EmbedDesign {
  const params = typeof search === "string"
    ? new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
    : search;
  const requestedAesthetic = params.get("aesthetic");
  return {
    aesthetic: EMBED_AESTHETICS.includes(requestedAesthetic as EmbedAesthetic)
      ? requestedAesthetic as EmbedAesthetic
      : DEFAULT_EMBED_DESIGN.aesthetic,
    accent: normalizeEmbedAccent(params.get("accent")),
  };
}

export function embedDesignSearch(design: EmbedDesign): string {
  return new URLSearchParams({
    aesthetic: design.aesthetic,
    accent: normalizeEmbedAccent(design.accent),
  }).toString();
}

function contrastColor(hex: string): "#FFFFFF" | "#171714" {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  const [red = 0, green = 0, blue = 0] = channels;
  return (red * 299 + green * 587 + blue * 114) / 1000 >= 150 ? "#171714" : "#FFFFFF";
}

const aestheticTokens: Record<EmbedAesthetic, Record<string, string>> = {
  bold: {
    "--color-canvas": "#F3EFE3",
    "--color-surface": "#FFFDF7",
    "--color-surface-muted": "#E8E2D5",
    "--color-ink": "#171714",
    "--color-ink-secondary": "#4F4A40",
    "--color-ink-faint": "#665F52",
    "--color-line": "#CFC7B8",
    "--color-line-strong": "#171714",
  },
  minimal: {
    "--color-canvas": "#F8FAFC",
    "--color-surface": "#FFFFFF",
    "--color-surface-muted": "#F1F5F9",
    "--color-ink": "#0F172A",
    "--color-ink-secondary": "#475569",
    "--color-ink-faint": "#64748B",
    "--color-line": "#E2E8F0",
    "--color-line-strong": "#CBD5E1",
  },
  editorial: {
    "--color-canvas": "#F4EFE5",
    "--color-surface": "#FFFCF5",
    "--color-surface-muted": "#EAE1D2",
    "--color-ink": "#25211C",
    "--color-ink-secondary": "#5D554B",
    "--color-ink-faint": "#766C5F",
    "--color-line": "#D8CCBA",
    "--color-line-strong": "#5B5145",
  },
};

export function embedDesignStyle(design: EmbedDesign): CSSProperties {
  const accent = normalizeEmbedAccent(design.accent);
  const softAccent = `color-mix(in srgb, ${accent} 14%, white)`;
  return {
    ...aestheticTokens[design.aesthetic],
    "--color-accent": accent,
    "--color-accent-hover": `color-mix(in srgb, ${accent} 84%, black)`,
    "--color-accent-soft": softAccent,
    "--color-accent-deep": `color-mix(in srgb, ${accent} 68%, black)`,
    "--color-on-accent": contrastColor(accent),
    "--embed-accent-contrast": contrastColor(accent),
    "--color-production-coral": accent,
    ...(design.aesthetic === "minimal"
      ? {
          "--color-production-lime": softAccent,
          "--color-production-sky": softAccent,
          "--color-production-yellow": softAccent,
        }
      : {}),
  } as CSSProperties;
}

export function embedTypographyClass(aesthetic: EmbedAesthetic): string {
  return aesthetic === "editorial"
    ? "font-serif [&_h1]:font-serif [&_h2]:font-serif [&_h3]:font-serif"
    : "font-sans";
}
