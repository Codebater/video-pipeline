// Post-production: turn the captured frame sequence into a polished promo.
//
//   intro card  ⨝  captioned body (from frames)  ⨝  outro CTA card   + music
//
// Everything is rendered at the same W/H/fps/pixel-format so the xfade
// crossfades and the final concat never choke. ffmpeg is invoked with an argv
// array (no shell), so the only escaping we owe is filtergraph-level: colons in
// Windows font/text paths get a backslash and the path is single-quoted.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ff = (args, label) => {
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
      stdio: ["ignore", "inherit", "inherit"],
    });
  } catch (e) {
    throw new Error(`ffmpeg failed at: ${label}`);
  }
};

// Escape a Windows path for use inside an ffmpeg filtergraph option value.
const fpath = (p) => "'" + p.replace(/\\/g, "/").replace(/:/g, "\\:") + "'";

// drawtext alpha expression: fade in over fd, hold, fade out over fd.
const fadeAlpha = (ts, te, fd = 0.4) =>
  `alpha='if(lt(t,${ts}),0,` +
  `if(lt(t,${ts + fd}),(t-${ts})/${fd},` +
  `if(lt(t,${te - fd}),1,` +
  `if(lt(t,${te}),(${te}-t)/${fd},0))))'`;

// Merge consecutive segments that carry the identical caption into one range,
// so a caption spanning several shots doesn't dip out and back at the seam.
function captionRanges(manifest) {
  const out = [];
  for (const s of manifest.segments) {
    if (!s.caption) continue;
    const last = out[out.length - 1];
    if (last && last.caption === s.caption && Math.abs(last.endSec - s.startSec) < 0.05) {
      last.endSec = s.endSec;
    } else {
      out.push({ caption: s.caption, startSec: s.startSec, endSec: s.endSec });
    }
  }
  return out;
}

export async function assemble(config, framesDir, manifest, outFile) {
  const work = path.join(path.dirname(outFile), "work");
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  const { width: W, height: H, fps } = manifest;
  const bodySec = manifest.totalFrames / fps;
  const headFont = fpath(config.fonts.heading);
  const bodyFont = fpath(config.fonts.body);
  const accent = config.brand.accent.replace("#", "0x");
  const bg = config.brand.bg.replace("#", "0x");
  const bgDeep = (config.brand.bgDeep || config.brand.bg).replace("#", "0x");

  // ---- Stage A: body with baked, fading captions ---------------------------
  const ranges = captionRanges(manifest);
  ranges.forEach((r, i) => {
    fs.writeFileSync(path.join(work, `cap${i}.txt`), r.caption, "utf8");
  });
  const capFilters = ranges.map((r, i) => {
    const tf = fpath(path.join(work, `cap${i}.txt`));
    return (
      `drawtext=fontfile=${headFont}:textfile=${tf}:` +
      `fontsize=54:fontcolor=white:borderw=2:bordercolor=black@0.55:` +
      `shadowcolor=black@0.5:shadowx=3:shadowy=3:` +
      `x=92:y=h-196:${fadeAlpha(r.startSec, r.endSec)}`
    );
  });
  const bodyChain =
    `[0:v]format=yuv420p` +
    (capFilters.length ? "," + capFilters.join(",") : "") +
    `,vignette=PI/5[v]`;

  const body = path.join(work, "body.mp4");
  ff(
    [
      "-framerate", String(fps),
      "-start_number", "0",
      "-i", path.join(framesDir, "f_%06d.png"),
      "-filter_complex", bodyChain,
      "-map", "[v]",
      "-r", String(fps),
      "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
      body,
    ],
    "body"
  );

  // ---- Stage B: intro card -------------------------------------------------
  const introSec = config.intro.seconds;
  fs.writeFileSync(path.join(work, "title.txt"), config.intro.title, "utf8");
  fs.writeFileSync(path.join(work, "sub.txt"), config.intro.subtitle, "utf8");
  const intro = path.join(work, "intro.mp4");
  ff(
    [
      "-f", "lavfi", "-i", `color=c=${bg}:s=${W}x${H}:d=${introSec}:r=${fps}`,
      "-i", config.logo,
      "-filter_complex",
      `[0:v]format=yuv420p,` +
        // subtle radial-ish darken at edges for depth
        `vignette=PI/4[bgc];` +
        `[1:v]scale=560:-1[lg];` +
        `[bgc][lg]overlay=x=(W-w)/2:y=(H-h)/2-150[withlogo];` +
        `[withlogo]drawtext=fontfile=${headFont}:textfile=${fpath(
          path.join(work, "title.txt")
        )}:fontsize=72:fontcolor=white:x=(w-text_w)/2:y=h/2+60[t1];` +
        `[t1]drawtext=fontfile=${bodyFont}:textfile=${fpath(
          path.join(work, "sub.txt")
        )}:fontsize=34:fontcolor=${accent}:x=(w-text_w)/2:y=h/2+170,` +
        `fade=t=in:st=0:d=0.5[v]`,
      "-map", "[v]",
      "-r", String(fps),
      "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
      intro,
    ],
    "intro"
  );

  // ---- Stage C: outro CTA card --------------------------------------------
  const outroSec = config.outro.seconds;
  fs.writeFileSync(path.join(work, "cta.txt"), config.outro.headline, "utf8");
  fs.writeFileSync(path.join(work, "url.txt"), config.outro.url, "utf8");
  const outro = path.join(work, "outro.mp4");
  ff(
    [
      "-f", "lavfi", "-i", `color=c=${bgDeep}:s=${W}x${H}:d=${outroSec}:r=${fps}`,
      "-i", config.logo,
      "-filter_complex",
      `[0:v]format=yuv420p,vignette=PI/4[bgc];` +
        `[1:v]scale=420:-1[lg];` +
        `[bgc][lg]overlay=x=(W-w)/2:y=(H-h)/2-130[withlogo];` +
        `[withlogo]drawtext=fontfile=${headFont}:textfile=${fpath(
          path.join(work, "cta.txt")
        )}:fontsize=64:fontcolor=white:x=(w-text_w)/2:y=h/2+70[t1];` +
        `[t1]drawtext=fontfile=${bodyFont}:textfile=${fpath(
          path.join(work, "url.txt")
        )}:fontsize=40:fontcolor=${accent}:x=(w-text_w)/2:y=h/2+170,` +
        `fade=t=in:st=0:d=0.5:color=${bgDeep},fade=t=out:st=${outroSec - 0.6}:d=0.6[v]`,
      "-map", "[v]",
      "-r", String(fps),
      "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
      outro,
    ],
    "outro"
  );

  // ---- Stage D: crossfade-concat + music ----------------------------------
  const xf = 0.6;
  const off1 = (introSec - xf).toFixed(3);
  const off2 = (introSec + bodySec - 2 * xf).toFixed(3);
  const finalDur = introSec + bodySec + outroSec - 2 * xf;

  const inputs = ["-i", intro, "-i", body, "-i", outro];
  const hasMusic = config.music && fs.existsSync(config.music);
  if (hasMusic) inputs.push("-i", config.music);

  let fc =
    `[0:v][1:v]xfade=transition=fade:duration=${xf}:offset=${off1}[ab];` +
    `[ab][2:v]xfade=transition=fade:duration=${xf}:offset=${off2}[v]`;

  const mapArgs = ["-map", "[v]"];
  if (hasMusic) {
    fc +=
      `;[3:a]afade=t=in:st=0:d=1.2,` +
      `afade=t=out:st=${(finalDur - 1.5).toFixed(3)}:d=1.5,` +
      `volume=0.8,atrim=0:${finalDur.toFixed(3)}[a]`;
    mapArgs.push("-map", "[a]", "-c:a", "aac", "-b:a", "192k", "-shortest");
  }

  ff(
    [
      ...inputs,
      "-filter_complex", fc,
      ...mapArgs,
      "-r", String(fps),
      "-c:v", "libx264", "-crf", "19", "-preset", "medium", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-t", finalDur.toFixed(3),
      outFile,
    ],
    "concat"
  );

  return { outFile, finalDur, hasMusic };
}
