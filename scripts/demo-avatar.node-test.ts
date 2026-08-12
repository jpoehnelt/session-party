import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import test from "node:test";
import { createDemoAvatarBase64, DEMO_AVATAR_SIZE } from "./demo-avatar";

const fixtureSpeakerNames = [
  "Priya Raman", "Alex Morgan", "Avery Chen", "Blair Okafor", "Cameron Singh",
  "Casey Rivera", "Dakota Kim", "Drew Williams", "Elliot Hassan", "Emerson Silva",
  "Finley Jones", "Harper Brown", "Hayden Garcia", "Jamie Patel", "Jordan Lee",
  "Kai Thompson", "Kendall Martin", "Lane Davis", "Logan Wilson", "Marley Taylor",
  "Morgan Clark", "Nico Anderson", "Parker Lewis", "Quinn Robinson", "Reese Walker",
  "Remy Martinez", "Robin Moore", "Rowan Hall", "Sasha Nguyen", "Taylor Jackson",
] as const;

const decodePixels = (base64: string): Buffer => {
  const png = Buffer.from(base64, "base64");
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const compressed: Buffer[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      assert.equal(data.readUInt32BE(0), DEMO_AVATAR_SIZE);
      assert.equal(data.readUInt32BE(4), DEMO_AVATAR_SIZE);
      assert.equal(data[8], 8);
      assert.equal(data[9], 6);
    }
    if (type === "IDAT") compressed.push(data);
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(compressed));
  assert.equal(raw.length, (DEMO_AVATAR_SIZE * 4 + 1) * DEMO_AVATAR_SIZE);
  for (let row = 0; row < DEMO_AVATAR_SIZE; row += 1) assert.equal(raw[row * (DEMO_AVATAR_SIZE * 4 + 1)], 0);
  return raw;
};

test("creates deterministic, distinct PNG avatars for every demo speaker", () => {
  const avatars = fixtureSpeakerNames.map((name, index) => createDemoAvatarBase64(name, index));
  assert.equal(new Set(avatars).size, fixtureSpeakerNames.length);
  assert.equal(createDemoAvatarBase64(fixtureSpeakerNames[0], 0), avatars[0]);
  assert.ok(avatars.every((avatar) => Buffer.from(avatar, "base64").length > 1_000));
  for (const avatar of avatars) decodePixels(avatar);
});

test("renders varied color and a legible light monogram instead of a flat black square", () => {
  const raw = decodePixels(createDemoAvatarBase64("Priya Raman", 0));
  const colors = new Set<string>();
  let lightPixels = 0;
  const stride = DEMO_AVATAR_SIZE * 4 + 1;
  for (let y = 0; y < DEMO_AVATAR_SIZE; y += 1) {
    for (let x = 0; x < DEMO_AVATAR_SIZE; x += 1) {
      const offset = y * stride + 1 + x * 4;
      const red = raw[offset]!;
      const green = raw[offset + 1]!;
      const blue = raw[offset + 2]!;
      colors.add(`${red},${green},${blue}`);
      if (red > 235 && green > 235 && blue > 225) lightPixels += 1;
    }
  }
  assert.ok(colors.size > 100);
  assert.ok(lightPixels > 500);
});

test("rejects invalid avatar inputs", () => {
  assert.throws(() => createDemoAvatarBase64("", 0), /must not be blank/);
  assert.throws(() => createDemoAvatarBase64("Priya Raman", -1), /nonnegative integer/);
  assert.throws(() => createDemoAvatarBase64("Élodie Raman", 0), /unsupported character/);
});
