// Hover-preview loop (the serious.business "work" effect).
//
// Produces a short, SILENT, seamlessly-looping montage of a site's best beats,
// in the three formats a hover <video> wants:
//   <site>-loop.mp4   (h264, broad support)
//   <site>-loop.webm  (vp9, smaller — browsers prefer it)
//   <site>-loop.webp  (poster, shown before the video plays)
//
// Capture reuses the deterministic frame-stepper (lib/capture.mjs) so the motion
// is smooth and load-independent. The seamlessness comes from a crossfade that
// folds the clip's HEAD back over its TAIL, so the first and last frames are
// identical (both = montage frame at t=crossfade) and the wrap is invisible.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { capture } from "./capture.mjs";

const ff = (args, label) => {
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
      stdio: ["ignore", "inherit", "inherit"],
    });
  } catch {
    throw new Error(`ffmpeg failed at: ${label}`);
  }
};

export async function buildLoop(config, outDir) {
  const framesDir = path.join(outDir, "loop_frames");
  const work = path.join(outDir, "loop_work");
  fs.mkdirSync(work, { recursive: true });

  const manifest = await capture(config, framesDir);
  const { fps, width: W, height: H } = manifest;
  const speed = config.speed || 1.0;

  // 1) Encode the raw montage from frames (optionally time-stretched by `speed`).
  const montage = path.join(work, "montage.mp4");
  const setpts = speed === 1 ? "" : `,setpts=${(1 / speed).toFixed(4)}*PTS`;
  ff(
    [
      "-framerate", String(fps),
      "-start_number", "0",
      "-i", path.join(framesDir, "f_%06d.png"),
      "-vf", `format=yuv420p${setpts}`,
      "-an",
      "-r", String(fps),
      "-c:v", "libx264", "-crf", "16", "-preset", "medium", "-pix_fmt", "yuv420p",
      montage,
    ],
    "montage"
  );

  const D = +((manifest.totalFrames / fps) / speed).toFixed(3);
  const cf = Math.min(config.crossfade || 0.6, D / 3);
  const shifted = +(D - cf).toFixed(3);
  const frameDur = 1 / fps;
  // Start the head's fade one frame early so it reaches full opacity BEFORE the
  // final frame (fade-in holds at 1 after completing). Otherwise the last frame
  // sits at α≈0.94 and leaves a faint ghost of the tail at the loop wrap.
  const fadeStart = +(shifted - frameDur).toFixed(3);

  // 2) Seamless-loop filter: shift a faded-in copy of the head onto the tail,
  //    then trim the first `cf` seconds. Result length = D - cf, and its first
  //    and last frames are the same montage frame → perfect wrap.
  const loopFilter =
    `[0:v]split=2[base][top];` +
    `[top]trim=0:${cf},setpts=PTS+${shifted}/TB,format=yuva420p,` +
    `fade=t=in:st=${fadeStart}:d=${cf}:alpha=1[tshift];` +
    `[base][tshift]overlay=format=auto,trim=${cf}:${D},setpts=PTS-STARTPTS,format=yuv420p[v]`;

  const mp4 = path.join(outDir, `${config.name}-loop.mp4`);
  ff(
    [
      "-i", montage,
      "-filter_complex", loopFilter,
      "-map", "[v]", "-an",
      "-r", String(fps),
      "-c:v", "libx264", "-crf", "20", "-preset", "medium", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      mp4,
    ],
    "loop.mp4"
  );

  // 3) WebM (VP9) — smaller; browsers pick it first when both are offered.
  const webm = path.join(outDir, `${config.name}-loop.webm`);
  ff(
    [
      "-i", montage,
      "-filter_complex", loopFilter,
      "-map", "[v]", "-an",
      "-r", String(fps),
      "-c:v", "libvpx-vp9", "-crf", "34", "-b:v", "0", "-row-mt", "1",
      "-pix_fmt", "yuv420p",
      webm,
    ],
    "loop.webm"
  );

  // 4) Poster — first frame of the loop, as webp.
  const poster = path.join(outDir, `${config.name}-loop.webp`);
  ff(
    [
      "-i", mp4,
      "-frames:v", "1",
      "-c:v", "libwebp", "-quality", "82",
      poster,
    ],
    "poster"
  );

  const sizeKB = (p) => (fs.statSync(p).size / 1024).toFixed(0);
  return {
    mp4, webm, poster,
    duration: shifted,
    dims: `${W}x${H}`,
    sizes: { mp4: sizeKB(mp4), webm: sizeKB(webm), poster: sizeKB(poster) },
  };
}
