import { deflateSync } from "node:zlib";

export const DEMO_AVATAR_SIZE = 128;

type Rgb = readonly [red: number, green: number, blue: number];

const glyphs: Readonly<Record<string, readonly number[]>> = {
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  B: [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  C: [0b01111, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b01111],
  D: [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  F: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
  G: [0b01111, 0b10000, 0b10000, 0b10111, 0b10001, 0b10001, 0b01110],
  H: [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  J: [0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100],
  K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  Q: [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  W: [0b10001, 0b10001, 0b10001, 0b10001, 0b10101, 0b11011, 0b10001],
};

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

const crc32 = (value: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of value) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (name: string, data: Buffer): Buffer => {
  const type = Buffer.from(name, "ascii");
  const chunk = Buffer.allocUnsafe(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  type.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), data.length + 8);
  return chunk;
};

const hueToRgb = (p: number, q: number, raw: number): number => {
  let hue = raw;
  if (hue < 0) hue += 1;
  if (hue > 1) hue -= 1;
  if (hue < 1 / 6) return p + (q - p) * 6 * hue;
  if (hue < 1 / 2) return q;
  if (hue < 2 / 3) return p + (q - p) * (2 / 3 - hue) * 6;
  return p;
};

const hsl = (hue: number, saturation: number, lightness: number): Rgb => {
  const h = ((hue % 360) + 360) % 360 / 360;
  const s = saturation / 100;
  const l = lightness / 100;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hueToRgb(p, q, h + 1 / 3) * 255),
    Math.round(hueToRgb(p, q, h) * 255),
    Math.round(hueToRgb(p, q, h - 1 / 3) * 255),
  ];
};

const mix = (from: Rgb, to: Rgb, amount: number): Rgb => [
  Math.round(from[0] + (to[0] - from[0]) * amount),
  Math.round(from[1] + (to[1] - from[1]) * amount),
  Math.round(from[2] + (to[2] - from[2]) * amount),
];

const nameSeed = (name: string, index: number): number => {
  let hash = (0x811c9dc5 ^ index) >>> 0;
  for (const character of name) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
};

const avatarInitials = (name: string): string => {
  const words = name.trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) throw new Error("Demo avatar name must not be blank.");
  const initials = `${words[0]![0] ?? ""}${words.length > 1 ? words.at(-1)![0] ?? "" : ""}`;
  if ([...initials].some((letter) => !glyphs[letter])) {
    throw new Error(`Demo avatar initials contain an unsupported character: ${initials}`);
  }
  return initials;
};

export function createDemoAvatarBase64(name: string, index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("Demo avatar index must be a nonnegative integer.");
  const initials = avatarInitials(name);
  const seed = nameSeed(name, index);
  const primary = hsl((index * 137.508 + 228) % 360, 72, 43);
  const secondary = hsl((index * 137.508 + 278) % 360, 78, 62);
  const dark: Rgb = [18, 23, 38];
  const white: Rgb = [255, 252, 241];
  const size = DEMO_AVATAR_SIZE;
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);

  const setPixel = (x: number, y: number, color: Rgb): void => {
    const offset = y * stride + 1 + x * 4;
    raw[offset] = color[0];
    raw[offset + 1] = color[1];
    raw[offset + 2] = color[2];
    raw[offset + 3] = 255;
  };

  const getPixel = (x: number, y: number): Rgb => {
    const offset = y * stride + 1 + x * 4;
    return [raw[offset]!, raw[offset + 1]!, raw[offset + 2]!];
  };

  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x += 1) {
      const gradient = (x * 0.42 + y * 0.58) / (size - 1);
      let color = mix(primary, secondary, gradient);
      const diagonal = (x + y + (seed & 31)) % 31;
      if (diagonal < 3) color = mix(color, white, 0.12);
      const dx = x - (24 + ((seed >>> 8) % 80));
      const dy = y - (22 + ((seed >>> 16) % 82));
      if (dx * dx + dy * dy < 29 * 29) color = mix(color, white, 0.13);
      if (x < 4 || y < 4 || x >= size - 4 || y >= size - 4) color = mix(color, dark, 0.52);
      setPixel(x, y, color);
    }
  }

  for (let y = 27; y < 101; y += 1) {
    for (let x = 14; x < 114; x += 1) {
      const cornerDistance = Math.min(x - 14, 113 - x, y - 27, 100 - y);
      if (cornerDistance >= 0 && (cornerDistance >= 12 || (x - 26) ** 2 + (y - 39) ** 2 <= 12 ** 2
        || (x - 101) ** 2 + (y - 39) ** 2 <= 12 ** 2 || (x - 26) ** 2 + (y - 88) ** 2 <= 12 ** 2
        || (x - 101) ** 2 + (y - 88) ** 2 <= 12 ** 2)) {
        setPixel(x, y, mix(getPixel(x, y), dark, 0.28));
      }
    }
  }

  const scale = 8;
  const gap = scale;
  const textWidth = initials.length * 5 * scale + (initials.length - 1) * gap;
  const startX = Math.floor((size - textWidth) / 2);
  const startY = Math.floor((size - 7 * scale) / 2);
  const paintText = (offsetX: number, offsetY: number, color: Rgb): void => {
    [...initials].forEach((letter, letterIndex) => {
      const rows = glyphs[letter]!;
      rows.forEach((bits, row) => {
        for (let column = 0; column < 5; column += 1) {
          if ((bits & (1 << (4 - column))) === 0) continue;
          for (let pixelY = 0; pixelY < scale; pixelY += 1) {
            for (let pixelX = 0; pixelX < scale; pixelX += 1) {
              setPixel(
                startX + letterIndex * (5 * scale + gap) + column * scale + pixelX + offsetX,
                startY + row * scale + pixelY + offsetY,
                color,
              );
            }
          }
        }
      });
    });
  };
  paintText(2, 3, mix(dark, primary, 0.18));
  paintText(0, 0, white);

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return png.toString("base64");
}
