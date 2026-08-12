type Rgb = readonly [number, number, number];

const rgb = (hex: string): Rgb => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];

const hex = ([red, green, blue]: Rgb): string => `#${[red, green, blue]
  .map((channel) => Math.round(channel).toString(16).padStart(2, "0"))
  .join("")}`;

const mix = (color: Rgb, target: Rgb, amount: number): Rgb => color.map(
  (channel, index) => channel + (target[index]! - channel) * amount,
) as unknown as Rgb;

const luminance = (color: Rgb): number => {
  const channels = color.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
};

const contrast = (left: Rgb, right: Rgb): number => {
  const [lighter, darker] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
};

export function deriveBrandColors(primaryColor: string) {
  const primary = rgb(primaryColor);
  const black: Rgb = [23, 23, 20];
  const white: Rgb = [255, 253, 247];
  const foreground = contrast(primary, black) >= contrast(primary, white) ? black : white;
  const hoverTarget = foreground === black ? black : white;
  return {
    accent: hex(primary),
    hover: hex(mix(primary, hoverTarget, 0.12)),
    soft: hex(mix(primary, white, 0.8)),
    deep: hex(mix(primary, black, 0.52)),
    foreground: hex(foreground),
    contrast: contrast(primary, foreground),
  };
}

export const readableBrandForeground = (primaryColor: string): string =>
  deriveBrandColors(primaryColor).foreground;

export function brandInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "SP";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
}
