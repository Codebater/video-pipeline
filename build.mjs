#!/usr/bin/env node
// Promo video pipeline — entry point.
//
//   node build.mjs <site>                 capture + assemble
//   node build.mjs <site> --capture-only  just grab frames
//   node build.mjs <site> --assemble-only re-render from existing frames
//
// <site> is the basename of a JSON config in ./sites (e.g. "dhami").

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";
import { capture } from "./lib/capture.mjs";
import { assemble } from "./lib/assemble.mjs";
import { captureReel, assembleReel } from "./lib/reel.mjs";
import { buildLoop } from "./lib/loop.mjs";
import { captureStory, assembleStory, loadCapturedStory } from "./lib/story.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const site = args.find((a) => !a.startsWith("--"));
const captureOnly = args.includes("--capture-only");
const assembleOnly = args.includes("--assemble-only");
const reel = args.includes("--reel");
const loop = args.includes("--loop");
const story = args.includes("--story");
const onlyArg = args.find((a) => a.startsWith("--only="));
const onlyIds = onlyArg ? onlyArg.slice(7).split(",") : null;

if (!site) {
  console.error(
    "usage: node build.mjs <site> [--reel|--loop|--story] [--capture-only|--assemble-only] [--only=id1,id2]"
  );
  process.exit(1);
}

const configPath = path.join(
  __dirname,
  "sites",
  reel
    ? `${site}.reel.json`
    : loop
      ? `${site}.loop.json`
      : story
        ? `${site}.story.json`
        : `${site}.json`
);
if (!fs.existsSync(configPath)) {
  console.error(`no config at ${configPath}`);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

const outDir = path.join(__dirname, "out", site);
const framesDir = path.join(outDir, "frames");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${site}-promo.mp4`);

const probe = (url) =>
  new Promise((resolve) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, (res) => {
      res.resume();
      resolve(res.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(8000, () => {
      req.destroy();
      resolve(false);
    });
  });

(async () => {
  const t0 = Date.now();

  if (loop) {
    process.stdout.write(`▶ Probing ${config.url} ...\n`);
    if (!(await probe(config.url))) {
      console.error(`\n✗ ${config.url} is not responding. Start the site first.\n`);
      process.exit(2);
    }
    process.stdout.write(`▶ Capturing best-moments montage + building seamless loop...\n`);
    const r = await buildLoop(config, outDir);
    process.stdout.write(
      `\n✓ Loop done in ${((Date.now() - t0) / 1000).toFixed(0)}s  ` +
        `(${r.duration}s, ${r.dims}, seamless)\n` +
        `  ${r.mp4}   (${r.sizes.mp4} KB)\n` +
        `  ${r.webm}  (${r.sizes.webm} KB)\n` +
        `  ${r.poster} (${r.sizes.poster} KB)\n`
    );
    return;
  }

  if (story) {
    const storyOut = path.join(outDir, `${site}-story.mp4`);
    const storyWork = path.join(outDir, "story_cap");
    let captured;
    if (assembleOnly) {
      captured = loadCapturedStory(config, storyWork, onlyIds);
      process.stdout.write(`▶ Reusing ${captured.length} cached moment recordings...\n`);
    } else {
      process.stdout.write(`▶ Probing ${config.url} ...\n`);
      if (!(await probe(config.url))) {
        console.error(`\n✗ ${config.url} is not responding. Start the site first.\n`);
        process.exit(2);
      }
      process.stdout.write(`▶ Filming interaction moments...\n`);
      captured = await captureStory(config, storyWork, onlyIds);
    }
    if (captureOnly) {
      process.stdout.write(`◼ Capture-only: recordings + marks in ${storyWork}\n`);
      return;
    }
    process.stdout.write(`▶ Directing camera + assembling story...\n`);
    const r = await assembleStory(config, captured, storyOut);
    process.stdout.write(
      `\n✓ Story done in ${((Date.now() - t0) / 1000).toFixed(0)}s  ` +
        `(${r.finalDur.toFixed(1)}s, ${r.segments} segments` +
        `${r.hasMusic ? " + music" : ", no music"})\n  ${storyOut}\n`
    );
    return;
  }

  if (reel) {
    const reelOut = path.join(outDir, `${site}-reel.mp4`);
    const reelWork = path.join(outDir, "reel_cap");
    process.stdout.write(`▶ Probing ${config.url} ...\n`);
    if (!(await probe(config.url))) {
      console.error(`\n✗ ${config.url} is not responding. Start the site first.\n`);
      process.exit(2);
    }
    process.stdout.write(`▶ Recording ${config.features.length} feature close-ups...\n`);
    const captured = await captureReel(config, reelWork);
    process.stdout.write(`▶ Building cards + assembling reel...\n`);
    const { hasMusic, segments } = await assembleReel(config, captured, reelOut);
    process.stdout.write(
      `\n✓ Reel done in ${((Date.now() - t0) / 1000).toFixed(0)}s  (${segments} segments` +
        `${hasMusic ? " + music" : ", no music"})\n  ${reelOut}\n`
    );
    return;
  }

  let manifest;

  if (!assembleOnly) {
    process.stdout.write(`▶ Probing ${config.url} ...\n`);
    if (!(await probe(config.url))) {
      console.error(
        `\n✗ ${config.url} is not responding.\n` +
          `  Start the site first, e.g.:  cd ../${site} && npx next start -p ${
            new URL(config.url).port || "3000"
          }\n`
      );
      process.exit(2);
    }
    process.stdout.write(`▶ Capturing frames (${config.fps}fps)...\n`);
    manifest = await capture(config, framesDir);
    process.stdout.write(
      `✓ Captured ${manifest.totalFrames} frames (${(
        manifest.totalFrames / manifest.fps
      ).toFixed(1)}s of body)\n`
    );
  } else {
    manifest = JSON.parse(
      fs.readFileSync(path.join(framesDir, "manifest.json"), "utf8")
    );
  }

  if (captureOnly) {
    process.stdout.write(`◼ Capture-only: frames in ${framesDir}\n`);
    return;
  }

  process.stdout.write(`▶ Assembling promo with ffmpeg...\n`);
  const { finalDur, hasMusic } = await assemble(config, framesDir, manifest, outFile);

  process.stdout.write(
    `\n✓ Done in ${((Date.now() - t0) / 1000).toFixed(0)}s\n` +
      `  ${outFile}\n` +
      `  ${finalDur.toFixed(1)}s @ ${manifest.width}x${manifest.height} ${manifest.fps}fps` +
      `${hasMusic ? " + music" : " (no music — drop a track at " + config.music + ")"}\n`
  );
})().catch((e) => {
  console.error("\n✗ " + e.message);
  process.exit(1);
});
