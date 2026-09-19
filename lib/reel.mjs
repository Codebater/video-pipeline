// Feature-highlight reel.
//
// For each "special" interaction on the site we produce a pair:
//   white animated title card (English)  →  cropped close-up of the effect.
// Then we concat all pairs (+ an end card, + optional music) into a ~15s reel.
//
// Close-ups are captured with Playwright's real-time video recorder (these are
// time-based micro-interactions — hovers, rolls, eye-tracking — not scroll-
// driven, so deterministic frame-stepping can't reproduce them). Each feature
// records in its own context; the meaningful action is performed at the END of
// the recording and we keep only the last `clipSeconds` via ffmpeg's -sseof.

import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ff = (args, label) => {
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
      stdio: ["ignore", "inherit", "inherit"],
    });
  } catch {
    throw new Error(`ffmpeg failed at: ${label}`);
  }
};
const fpath = (p) => "'" + p.replace(/\\/g, "/").replace(/:/g, "\\:") + "'";

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

async function settle(page) {
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  );
}

// Resolve an element's document scroll offset with an alignment.
function scrollTargetExpr() {
  return ({ sel, align, offset }) => {
    const el = document.querySelector(sel);
    if (!el) return 0;
    const vh = window.innerHeight;
    const top = el.getBoundingClientRect().top + window.scrollY;
    let y = top - (offset || 0);
    if (align === "center")
      y = top - vh / 2 + el.getBoundingClientRect().height / 2 - (offset || 0);
    if (align === "below") y = top - vh * 0.92; // just out of trigger range
    const max = document.documentElement.scrollHeight - vh;
    return Math.max(0, Math.min(y, max));
  };
}

async function centerOf(page, sel) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  }, sel);
}

async function runActions(page, feature) {
  for (const a of feature.actions) {
    if (a.posImmediate != null) {
      const y = await page.evaluate(scrollTargetExpr(), {
        sel: a.posImmediate,
        align: a.align,
        offset: a.offset,
      });
      await page.evaluate((y) => window.__lenis.scrollTo(y, { immediate: true, force: true }), y);
      await settle(page);
    } else if (a.posBelow != null) {
      const y = await page.evaluate(scrollTargetExpr(), { sel: a.posBelow, align: "below" });
      await page.evaluate((y) => window.__lenis.scrollTo(y, { immediate: true, force: true }), y);
      await settle(page);
    } else if (a.stubScroll) {
      await page.evaluate(() => {
        window.__lenis.__realScrollTo = window.__lenis.scrollTo;
        window.__lenis.scrollTo = () => {};
      });
    } else if (a.scrollIn != null) {
      const y = await page.evaluate(scrollTargetExpr(), {
        sel: a.scrollIn,
        align: a.align,
        offset: a.offset,
      });
      // Real smooth scroll so ScrollTrigger fires naturally and motion is filmed.
      await page.evaluate(
        ({ y, ms }) => window.__lenis.scrollTo(y, { duration: ms / 1000, force: true }),
        { y, ms: a.ms }
      );
      await page.waitForTimeout(a.ms + 60);
    } else if (a.click != null) {
      await page.click(a.click, { force: true }).catch(() => {});
    } else if (a.hover != null) {
      await page.hover(a.hover, { force: true }).catch(() => {});
    } else if (a.hoverNth != null) {
      const loc = page.locator(a.hoverNth).nth(a.n);
      await loc.hover({ force: true }).catch(() => {});
    } else if (a.mouseLean != null) {
      const c = await centerOf(page, a.mouseLean);
      const ms = a.ms || 1500;
      // enter, then trace a small loop near the edges to make it lean.
      await page.mouse.move(c.x, c.y, { steps: 6 });
      const pts = [
        [0.32, -0.32], [0.34, 0.30], [-0.34, 0.32], [-0.32, -0.30], [0.2, 0],
      ];
      for (const [fx, fy] of pts) {
        await page.mouse.move(c.x + c.w * fx, c.y + c.h * fy, { steps: 10 });
        await page.waitForTimeout(ms / pts.length);
      }
    } else if (a.mouseCircle != null) {
      const c = await centerOf(page, a.mouseCircle);
      const ms = a.ms || 1500;
      const turns = a.turns || 1;
      const R = a.radius || 200;
      const N = Math.max(24, Math.round(ms / 28));
      for (let i = 0; i <= N; i++) {
        const ang = (i / N) * turns * Math.PI * 2;
        await page.mouse.move(c.x + Math.cos(ang) * R, c.y + Math.sin(ang) * R * 0.55, {
          steps: 2,
        });
        await page.waitForTimeout(ms / N);
      }
    } else if (a.wait != null) {
      await page.waitForTimeout(a.wait);
    }
  }
}

// Expand a bbox to a padded 16:9 crop clamped inside W×H. `minW` keeps the crop
// from getting so tight that upscaling to full frame turns soft.
function crop169(box, pad, W, H, minW = 820) {
  let x = box.x - pad,
    y = box.y - pad,
    w = box.w + 2 * pad,
    h = box.h + 2 * pad;
  const R = 16 / 9;
  if (w / h < R) {
    const nw = h * R;
    x -= (nw - w) / 2;
    w = nw;
  } else {
    const nh = w / R;
    y -= (nh - h) / 2;
    h = nh;
  }
  const floorW = Math.min(minW, W);
  if (w < floorW) {
    const cx = x + w / 2,
      cy = y + h / 2;
    w = floorW;
    h = w / R;
    x = cx - w / 2;
    y = cy - h / 2;
  }
  if (w > W) {
    h *= W / w;
    w = W;
  }
  if (h > H) {
    w *= H / h;
    h = H;
  }
  x = Math.max(0, Math.min(x, W - w));
  y = Math.max(0, Math.min(y, H - h));
  const r2 = (n) => Math.max(2, Math.round(n / 2) * 2);
  return { x: r2(x), y: r2(y), w: r2(w), h: r2(h) };
}

export async function captureReel(config, workDir) {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  const { width: W, height: H } = config.viewport;

  const browser = await chromium.launch({
    headless: true,
    args: ["--force-color-profile=srgb", "--hide-scrollbars"],
  });

  const captured = [];
  for (const feature of config.features) {
    const vidDir = path.join(workDir, `rec_${feature.id}`);
    fs.mkdirSync(vidDir, { recursive: true });

    const context = await browser.newContext({
      viewport: config.viewport,
      deviceScaleFactor: config.deviceScaleFactor || 1,
      reducedMotion: "no-preference",
      recordVideo: { dir: vidDir, size: config.viewport },
    });
    if (config.initScript) await context.addInitScript(config.initScript);
    const page = await context.newPage();
    await page.goto(config.url, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForFunction(() => !!window.__lenis, null, { timeout: 20000 });
    await page.evaluate(() => document.fonts && document.fonts.ready);
    await page.evaluate(() => {
      document.body.style.overflow = "";
      window.__lenis && window.__lenis.start();
    });
    await page.waitForTimeout(400);

    await runActions(page, feature);

    // Crop box from the focus element's final position.
    let box;
    try {
      box = await centerOf(page, feature.focus).then((c) => ({
        x: c.x - c.w / 2,
        y: c.y - c.h / 2,
        w: c.w,
        h: c.h,
      }));
    } catch {
      box = { x: W / 4, y: H / 4, w: W / 2, h: H / 2 };
    }
    const cropRect = crop169(box, feature.pad || 60, W, H);

    const video = page.video();
    await context.close();
    const webm = await video.path();

    captured.push({ feature, webm, crop: cropRect });
    process.stdout.write(
      `  · ${feature.id.padEnd(10)} crop ${cropRect.w}x${cropRect.h} @ ${cropRect.x},${cropRect.y}\n`
    );
  }

  await browser.close();
  return captured;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function cardFilter(config, f, W, H) {
  const head = fpath(config.fonts.heading);
  const body = fpath(config.fonts.body);
  const petrol = config.brand.petrol.replace("#", "0x");
  const magenta = config.brand.magenta.replace("#", "0x");
  const muted = config.brand.muted.replace("#", "0x");
  const tf = (name) => fpath(path.join(config._cardTxt, name));

  // Title rises ~45px and fades in over 0.45s; blurb fades a beat later.
  const titleY = `(h/2-20)+(1-min(1\\,t/0.45))*45`;
  const titleA = `alpha='min(1\\,t/0.4)'`;
  const blurbA = `alpha='if(lt(t\\,0.35)\\,0\\,min(1\\,(t-0.35)/0.4))'`;
  const kickA = `alpha='min(1\\,t/0.3)'`;

  return (
    `color=c=white:s=${W}x${H}:d=${f.cardSeconds}:r=${config.fps},format=yuv420p,` +
    `drawtext=fontfile=${body}:textfile=${tf(`${f.id}_k.txt`)}:` +
    `fontsize=30:fontcolor=${magenta}:x=(w-text_w)/2:y=h/2-150:${kickA},` +
    `drawtext=fontfile=${head}:textfile=${tf(`${f.id}_t.txt`)}:` +
    `fontsize=86:fontcolor=${petrol}:x=(w-text_w)/2:y=${titleY}:${titleA},` +
    `drawtext=fontfile=${body}:textfile=${tf(`${f.id}_b.txt`)}:` +
    `fontsize=40:fontcolor=${muted}:x=(w-text_w)/2:y=h/2+90:${blurbA}`
  );
}

export async function assembleReel(config, captured, outFile) {
  const work = path.join(path.dirname(outFile), "reel_work");
  fs.mkdirSync(work, { recursive: true });
  const segDir = path.join(work, "segs");
  fs.rmSync(segDir, { recursive: true, force: true });
  fs.mkdirSync(segDir, { recursive: true });
  config._cardTxt = path.join(work, "txt");
  fs.mkdirSync(config._cardTxt, { recursive: true });

  const { width: W, height: H } = config.viewport;
  const fps = config.fps;
  const segs = [];
  let idx = 0;

  for (const { feature: f, webm, crop } of captured) {
    // Title card
    fs.writeFileSync(path.join(config._cardTxt, `${f.id}_k.txt`), f.kicker, "utf8");
    fs.writeFileSync(path.join(config._cardTxt, `${f.id}_t.txt`), f.title, "utf8");
    fs.writeFileSync(path.join(config._cardTxt, `${f.id}_b.txt`), f.blurb, "utf8");
    const card = path.join(segDir, `${String(idx++).padStart(2, "0")}_card.mp4`);
    ff(
      [
        "-f", "lavfi",
        "-i", cardFilter(config, f, W, H),
        "-r", String(fps),
        "-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        card,
      ],
      `card:${f.id}`
    );
    segs.push(card);

    // Close-up clip: keep last clipSeconds, crop → 16:9, scale to full frame.
    const clip = path.join(segDir, `${String(idx++).padStart(2, "0")}_clip.mp4`);
    ff(
      [
        "-sseof", `-${f.clipSeconds}`,
        "-i", webm,
        "-vf",
        `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=${W}:${H}:flags=lanczos,` +
          `format=yuv420p,fade=t=in:st=0:d=0.12`,
        "-r", String(fps),
        "-an",
        "-c:v", "libx264", "-crf", "19", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        clip,
      ],
      `clip:${f.id}`
    );
    segs.push(clip);
  }

  // End card
  if (config.endcard) {
    const e = config.endcard;
    fs.writeFileSync(path.join(config._cardTxt, `end_h.txt`), e.headline, "utf8");
    fs.writeFileSync(path.join(config._cardTxt, `end_u.txt`), e.url, "utf8");
    const head = fpath(config.fonts.heading);
    const body = fpath(config.fonts.body);
    const petrol = config.brand.petrol.replace("#", "0x");
    const magenta = config.brand.magenta.replace("#", "0x");
    const end = path.join(segDir, `${String(idx++).padStart(2, "0")}_end.mp4`);
    ff(
      [
        "-f", "lavfi",
        "-i", `color=c=white:s=${W}x${H}:d=${e.seconds}:r=${fps}`,
        "-i", config.logo,
        "-filter_complex",
        `[0:v]format=yuv420p[bg];[1:v]scale=460:-1[lg];` +
          `[bg][lg]overlay=x=(W-w)/2:y=(H-h)/2-120[a];` +
          `[a]drawtext=fontfile=${head}:textfile=${fpath(
            path.join(config._cardTxt, "end_h.txt")
          )}:fontsize=58:fontcolor=${petrol}:x=(w-text_w)/2:y=h/2+90[b];` +
          `[b]drawtext=fontfile=${body}:textfile=${fpath(
            path.join(config._cardTxt, "end_u.txt")
          )}:fontsize=38:fontcolor=${magenta}:x=(w-text_w)/2:y=h/2+170,` +
          `fade=t=in:st=0:d=0.3[v]`,
        "-map", "[v]",
        "-r", String(fps),
        "-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        end,
      ],
      "endcard"
    );
    segs.push(end);
  }

  // Concat (re-encode for safe, uniform output) + optional music.
  const listFile = path.join(work, "list.txt");
  fs.writeFileSync(
    listFile,
    segs.map((s) => `file '${s.replace(/\\/g, "/")}'`).join("\n"),
    "utf8"
  );

  const totalDur =
    captured.reduce((s, c) => s + c.feature.cardSeconds + c.feature.clipSeconds, 0) +
    (config.endcard ? config.endcard.seconds : 0);

  const hasMusic = config.music && fs.existsSync(config.music);
  if (hasMusic) {
    const silent = path.join(work, "reel_silent.mp4");
    ff(
      [
        "-f", "concat", "-safe", "0", "-i", listFile,
        "-r", String(fps),
        "-c:v", "libx264", "-crf", "19", "-preset", "medium", "-pix_fmt", "yuv420p",
        silent,
      ],
      "concat"
    );
    ff(
      [
        "-i", silent, "-i", config.music,
        "-filter_complex",
        `[1:a]afade=t=in:st=0:d=0.6,afade=t=out:st=${Math.max(
          0,
          totalDur - 1.8
        ).toFixed(2)}:d=1.8,volume=0.85[a]`,
        "-map", "0:v", "-map", "[a]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest",
        "-movflags", "+faststart",
        outFile,
      ],
      "mux"
    );
  } else {
    ff(
      [
        "-f", "concat", "-safe", "0", "-i", listFile,
        "-r", String(fps),
        "-c:v", "libx264", "-crf", "19", "-preset", "medium", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        outFile,
      ],
      "concat"
    );
  }

  return { outFile, hasMusic, segments: segs.length };
}
