/**
 * generate-icons.mjs
 * Builds ALL Android launcher/splash graphics from icon-source.png:
 *   - adaptive icon (API 26+, what every modern phone uses):
 *       mipmap-<dpi>/ic_launcher_foreground.png  (artwork inside the safe zone)
 *       values/ic_launcher_background.xml    (background colour)
 *     The Capacitor template's mipmap-anydpi-v26/ic_launcher.xml already
 *     points at those two names, so replacing only ic_launcher.png (what
 *     the previous version did) had NO visible effect on modern devices.
 *   - legacy square + round icons (API < 26)
 *   - splash screens (every drawable-<variant>/splash.png the template created)
 *
 * The source is a rounded-square artwork on a white canvas: the white
 * border/corners are cut away with a rounded-rect mask first.
 *
 * Usage: node scripts/generate-icons.mjs   (runs in CI after `cap add android`)
 * Optional: --preview <dir> also writes preview PNGs there (no android/ needed).
 */
import sharp from "sharp";
import { readFileSync, mkdirSync, existsSync, readdirSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "icon-source.png");
if (!existsSync(src)) { console.error("icon-source.png not found in project root."); process.exit(1); }
const previewDir = process.argv.includes("--preview") ? process.argv[process.argv.indexOf("--preview") + 1] : null;
const RES = join(root, "android/app/src/main/res");
const hasAndroid = existsSync(RES);
if (!hasAndroid && !previewDir) { console.error("android/ not found - run `npx cap add android` first."); process.exit(1); }

/* 1. Cut the rounded-square artwork out of the white canvas. */
const trimmed = await sharp(readFileSync(src)).trim({ threshold: 18 }).png().toBuffer({ resolveWithObject: true });
const side = Math.min(trimmed.info.width, trimmed.info.height);
const INSET = Math.round(side * 0.022);          // drop the soft white fringe
const art = side - INSET * 2;
const rr = Math.round(art * 0.225);              // corner radius of the artwork
const mask = Buffer.from(`<svg width="${art}" height="${art}"><rect width="${art}" height="${art}" rx="${rr}" ry="${rr}" fill="#fff"/></svg>`);
const artwork = await sharp(trimmed.data)
  .extract({ left: Math.round((trimmed.info.width - side) / 2) + INSET, top: Math.round((trimmed.info.height - side) / 2) + INSET, width: art, height: art })
  .composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();

/* 2. Background colour = average colour of the artwork's outer ring. */
const { data: px, info } = await sharp(artwork).resize(64, 64).raw().toBuffer({ resolveWithObject: true });
let r = 0, g = 0, b = 0, n = 0;
for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
  if (x > 9 && x < 54 && y > 9 && y < 54) continue;
  const i = (y * 64 + x) * info.channels;
  if (px[i + 3] < 200) continue;
  r += px[i]; g += px[i + 1]; b += px[i + 2]; n++;
}
const hex = "#" + [r, g, b].map((v) => Math.round(v / n).toString(16).padStart(2, "0")).join("");
console.log("background colour:", hex);

const out = async (rel, buf) => {
  if (previewDir) { mkdirSync(previewDir, { recursive: true }); writeFileSync(join(previewDir, rel.replace(/\//g, "_")), buf); }
  if (hasAndroid) { const p = join(RES, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, buf); }
};

const DENS = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [dpi, k] of Object.entries(DENS)) {
  /* adaptive foreground: 108dp canvas, artwork ~68% (the launcher mask shows ~66%
     of the canvas, the artwork's own rounded corners fall outside the mask). */
  const fg = Math.round(108 * k);
  const inner = Math.round(fg * 0.68);
  const art2 = await sharp(artwork).resize(inner, inner).png().toBuffer();
  await out(`mipmap-${dpi}/ic_launcher_foreground.png`,
    await sharp({ create: { width: fg, height: fg, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: art2, gravity: "center" }]).png().toBuffer());

  /* legacy icons (48dp): full rounded artwork; round = circle */
  const px48 = Math.round(48 * k);
  await out(`mipmap-${dpi}/ic_launcher.png`, await sharp(artwork).resize(px48, px48).png().toBuffer());
  const circle = Buffer.from(`<svg width="${px48}" height="${px48}"><circle cx="${px48 / 2}" cy="${px48 / 2}" r="${px48 / 2}"/></svg>`);
  const roundArt = await sharp(artwork).resize(Math.round(px48 * 1.12), Math.round(px48 * 1.12)).extract({ left: Math.round(px48 * 0.06), top: Math.round(px48 * 0.06), width: px48, height: px48 }).composite([{ input: circle, blend: "dest-in" }]).png().toBuffer();
  await out(`mipmap-${dpi}/ic_launcher_round.png`, roundArt);
}
await out("values/ic_launcher_background.xml", Buffer.from(`<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${hex}</color>\n</resources>\n`));

/* 3. Splash: keep each template splash's own size, dark app colour + logo. */
const SPLASH_BG = { r: 22, g: 48, b: 43, alpha: 1 };
const splashTargets = [];
if (hasAndroid) for (const d of readdirSync(RES)) if (d.startsWith("drawable") && existsSync(join(RES, d, "splash.png"))) splashTargets.push([d, null]);
if (previewDir) splashTargets.push(["preview", { w: 1080, h: 1920 }]);
for (const [d, forced] of splashTargets) {
  const dim = forced || (await sharp(join(RES, d, "splash.png")).metadata());
  const w = dim.w || dim.width, h = dim.h || dim.height;
  const logo = Math.round(Math.min(w, h) * 0.5);
  const logoBuf = await sharp(artwork).resize(logo, logo).png().toBuffer();
  const buf = await sharp({ create: { width: w, height: h, channels: 4, background: SPLASH_BG } }).composite([{ input: logoBuf, gravity: "center" }]).png().toBuffer();
  if (hasAndroid && !forced) writeFileSync(join(RES, d, "splash.png"), buf);
  if (previewDir) writeFileSync(join(previewDir, `splash_${d}.png`), buf);
}
console.log("Icons + adaptive foreground + splash generated.");
