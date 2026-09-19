// Interaction-first "story" format.
//
// Instead of touring pages, we film a user ACCOMPLISHING something:
//   problem → cursor approach → click → response → result → outcome → brand.
//
// Each config "moment" is one continuously-recorded take (Playwright
// recordVideo, oversized so post-zooms stay sharp) structured as named BEATS.
// Beats are executed with wall-clock measurement, so post-production knows the
// exact second every interaction happened — the cinematic camera (a keyframed
// zoom/pan rendered with ffmpeg zoompan) and text overlays are timed against
// those measured marks, not guesses.
//
// In-page cinematography helpers are injected before the site loads:
//   · a visible virtual cursor that eases toward targets (slightly arced paths)
//   · a click ripple + cursor press-down so cause is always visible
//   · a focus-pull "spotlight" (backdrop blur + dim with a soft mask hole)
//   · a glow ring for active elements
//
// Golden rule enforced by design: the camera only moves between keyframes the
// config explicitly places on beats — no drift, no decorative wander.

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

const ffprobeDur = (file) =>
  parseFloat(
    execFileSync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      file,
    ]).toString()
  );

const fpath = (p) => "'" + p.replace(/\\/g, "/").replace(/:/g, "\\:") + "'";

// ---------------------------------------------------------------------------
// In-page cinematography kit (virtual cursor / ripple / spotlight / glow)
// ---------------------------------------------------------------------------

const CINE_KIT = `(() => {
  const boot = () => {
    if (document.getElementById('__vc')) return;
    const style = document.createElement('style');
    style.textContent = \`
      #__vc{position:fixed;left:0;top:0;width:26px;height:26px;margin:-13px 0 0 -13px;
        border-radius:50%;background:rgba(255,255,255,.92);
        border:2px solid rgba(22,58,41,.9);box-shadow:0 3px 12px rgba(0,0,0,.38);
        pointer-events:none;z-index:2147483647;opacity:0;
        transform:translate3d(-200px,-200px,0);
        transition:opacity .25s ease, scale .14s ease;}
      #__vc.down{scale:.74}
      .__vcRip{position:fixed;border-radius:50%;border:3px solid rgba(207,95,147,.95);
        pointer-events:none;z-index:2147483646;translate:-50% -50%;
        animation:__vcrip .65s cubic-bezier(.2,.7,.3,1) forwards;}
      @keyframes __vcrip{
        from{opacity:.95;width:12px;height:12px}
        to{opacity:0;width:96px;height:96px}}
      .__vcGlow{box-shadow:0 0 0 4px rgba(207,95,147,.35),
        0 0 38px 8px rgba(207,95,147,.45) !important;
        transition:box-shadow .45s ease !important;}
      #__vcSpot{position:fixed;inset:0;pointer-events:none;z-index:2147483600;
        opacity:0;transition:opacity .5s ease;
        backdrop-filter:blur(4px) brightness(.8) saturate(.92);}
    \`;
    document.head.appendChild(style);
    const dot = document.createElement('div'); dot.id = '__vc';
    const spot = document.createElement('div'); spot.id = '__vcSpot';
    document.body.appendChild(spot);
    document.body.appendChild(dot);
    let shown = false;
    document.addEventListener('mousemove', (e) => {
      if (!shown) { shown = true; dot.style.opacity = '1'; }
      dot.style.transform = 'translate3d(' + e.clientX + 'px,' + e.clientY + 'px,0)';
    }, true);
    document.addEventListener('mousedown', (e) => {
      dot.classList.add('down');
      const r = document.createElement('span');
      r.className = '__vcRip';
      r.style.left = e.clientX + 'px';
      r.style.top = e.clientY + 'px';
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 750);
    }, true);
    document.addEventListener('mouseup', () => dot.classList.remove('down'), true);

    window.__vcSpot = (rect, on) => {
      if (!on || !rect) { spot.style.opacity = '0'; return; }
      const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
      const rx = Math.max(rect.w * 0.8, 140), ry = Math.max(rect.h * 1.1, 100);
      const m = 'radial-gradient(ellipse ' + rx + 'px ' + ry + 'px at '
        + cx + 'px ' + cy + 'px, transparent 0%, transparent 52%, black 96%)';
      spot.style.webkitMaskImage = m; spot.style.maskImage = m;
      spot.style.opacity = '1';
    };
    window.__vcGlow = (sel, on) => {
      const el = document.querySelector(sel);
      if (el) el.classList[on ? 'add' : 'remove']('__vcGlow');
    };
  };
  // Booted explicitly by the capture runner AFTER the app has hydrated —
  // injecting extra <body> children before/during React hydration makes the
  // framework discard and remount the whole tree (window.__lenis flickers
  // away and beats crash).
  window.__vcBoot = boot;
})();`;

// ---------------------------------------------------------------------------
// Capture: beats, eased cursor, measured marks
// ---------------------------------------------------------------------------

async function settle(page) {
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  );
}

function scrollTargetExpr() {
  return ({ sel, align, offset }) => {
    const el = document.querySelector(sel);
    if (!el) return 0;
    const vh = window.innerHeight;
    const top = el.getBoundingClientRect().top + window.scrollY;
    let y = top - (offset || 0);
    if (align === "center")
      y = top - vh / 2 + el.getBoundingClientRect().height / 2 - (offset || 0);
    if (align === "below") y = top - vh * 0.92;
    const max = document.documentElement.scrollHeight - vh;
    return Math.max(0, Math.min(y, max));
  };
}

async function rectOf(page, sel) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }, sel);
}

// Eased cursor flight with a slight perpendicular arc — reads as a hand, not
// a robot. Wall-clock paced so the nominal ms matches measured time closely.
async function easedMove(page, state, to, ms) {
  const from = { ...state.cursor };
  const dx = to.x - from.x, dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  const nx = -dy / dist, ny = dx / dist;
  const arc = Math.min(42, dist * 0.09);
  const steps = Math.max(8, Math.round(ms / 24));
  const t0 = Date.now();
  for (let i = 1; i <= steps; i++) {
    const p = i / steps;
    const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    const bow = Math.sin(Math.PI * e) * arc;
    await page.mouse.move(from.x + dx * e + nx * bow, from.y + dy * e + ny * bow);
    const lag = t0 + ms * p - Date.now();
    if (lag > 4) await page.waitForTimeout(lag);
  }
  state.cursor = { x: to.x, y: to.y };
}

// The app can remount its tree shortly after load (e.g. a recovered hydration
// hiccup), briefly tearing down window.__lenis. Heal instead of crashing:
// every Lenis-dependent action first waits for the instance to be back.
async function lenisReady(page) {
  await page
    .waitForFunction(() => !!window.__lenis, null, { timeout: 10000 })
    .catch(() => {});
}

async function runAction(page, state, a) {
  if (
    a.posImmediate != null ||
    a.posBelow != null ||
    a.scrollIn != null ||
    a.scrollBy != null
  )
    await lenisReady(page);
  if (a.posImmediate != null) {
    const y = await page.evaluate(scrollTargetExpr(), {
      sel: a.posImmediate, align: a.align, offset: a.offset,
    });
    await page.evaluate((y) => window.__lenis.scrollTo(y, { immediate: true, force: true }), y);
    await settle(page);
  } else if (a.posBelow != null) {
    const y = await page.evaluate(scrollTargetExpr(), { sel: a.posBelow, align: "below" });
    await page.evaluate((y) => window.__lenis.scrollTo(y, { immediate: true, force: true }), y);
    await settle(page);
  } else if (a.scrollIn != null) {
    const y = await page.evaluate(scrollTargetExpr(), {
      sel: a.scrollIn, align: a.align, offset: a.offset,
    });
    await page.evaluate(
      ({ y, ms }) => window.__lenis.scrollTo(y, { duration: ms / 1000, force: true }),
      { y, ms: a.ms }
    );
    await page.waitForTimeout(a.ms + 60);
  } else if (a.scrollBy != null) {
    await page.evaluate(
      ({ px, ms }) =>
        window.__lenis.scrollTo(window.scrollY + px, { duration: ms / 1000, force: true }),
      { px: a.scrollBy, ms: a.ms }
    );
    await page.waitForTimeout(a.ms + 60);
  } else if (a.cursorAt != null) {
    await page.mouse.move(a.cursorAt.x, a.cursorAt.y);
    state.cursor = { ...a.cursorAt };
  } else if (a.moveTo != null) {
    const r = await rectOf(page, a.moveTo);
    if (r) {
      const to = {
        x: r.x + r.w / 2 + (a.dx || 0),
        y: r.y + r.h / 2 + (a.dy || 0),
      };
      await easedMove(page, state, to, a.ms || 900);
    }
  } else if (a.click) {
    await page.mouse.down();
    await page.waitForTimeout(95);
    await page.mouse.up();
  } else if (a.stubNav != null) {
    // Keep the click's visual response but cancel its navigation (e.g. an
    // <a target="_blank"> to an external booking system would pop a tab we
    // aren't filming).
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.addEventListener("click", (e) => e.preventDefault(), true);
    }, a.stubNav);
  } else if (a.spotlight != null) {
    const r = await rectOf(page, a.spotlight);
    await page.evaluate((r) => window.__vcSpot(r, true), r);
  } else if (a.spotlightOff) {
    await page.evaluate(() => window.__vcSpot(null, false));
  } else if (a.glow != null) {
    await page.evaluate((sel) => window.__vcGlow(sel, true), a.glow);
  } else if (a.glowOff != null) {
    await page.evaluate((sel) => window.__vcGlow(sel, false), a.glowOff);
  } else if (a.waitFor != null) {
    // Poll a page-side condition (e.g. the preloader counter hitting 100) so
    // beats can mark events we don't drive ourselves.
    await page
      .waitForFunction(a.waitFor, null, { timeout: a.timeout || 10000 })
      .catch(() => {});
  } else if (a.wait != null) {
    await page.waitForTimeout(a.wait);
  }
}

// "beat" / "beat+0.4" / "end" → seconds within the trimmed clip.
function parseMark(ref, marks) {
  const m = /^([\w-]+)(?:\+([\d.]+))?$/.exec(ref);
  if (!m || marks[m[1]] == null)
    throw new Error(`unknown camera/overlay mark "${ref}"`);
  return marks[m[1]] + (m[2] ? parseFloat(m[2]) : 0);
}

export async function captureStory(config, workDir, onlyIds) {
  fs.mkdirSync(workDir, { recursive: true });

  // The throttling flags matter: on Windows, occlusion detection can mark the
  // headless window hidden, freezing rAF — GSAP (and the site preloader) stall
  // mid-recording.
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--force-color-profile=srgb",
      "--hide-scrollbars",
      "--disable-features=CalculateNativeWinOcclusion",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
    ],
  });

  const moments = config.moments.filter(
    (m) => !onlyIds || onlyIds.includes(m.id)
  );
  const captured = [];

  // A take can die to a transient main-frame navigation (e.g. the page being
  // yanked to chrome-error:// by a failed request) — retry once before giving up.
  const filmMoment = async (moment) => {
    const vidDir = path.join(workDir, `rec_${moment.id}`);
    fs.rmSync(vidDir, { recursive: true, force: true });
    fs.mkdirSync(vidDir, { recursive: true });

    // Per-moment viewport (e.g. a phone take inside a landscape film).
    // recordVideo never upsamples: asking for more than the viewport just
    // letterboxes the frames onto a gray canvas. Record at viewport size.
    const vp = moment.viewport || config.viewport;
    const context = await browser.newContext({
      viewport: vp,
      deviceScaleFactor: config.deviceScaleFactor || 2,
      reducedMotion: "no-preference",
      recordVideo: { dir: vidDir, size: vp },
    });
    if (config.initScript && !moment.noInit)
      await context.addInitScript(config.initScript);
    await context.addInitScript(CINE_KIT);
    // Cancel navigations to external systems triggered by the filmed click —
    // e.g. a booking widget set via `window.location.href`, which no
    // click-handler stub can intercept. Respond 204: the browser treats the
    // navigation as a download-like no-op and STAYS on the current page
    // (aborting instead would commit chrome-error:// and kill the take).
    for (const frag of moment.blockUrls || []) {
      await context.route(
        (url) => url.href.includes(frag),
        (route) => route.fulfill({ status: 204, body: "" })
      );
    }
    const page = await context.newPage();
    // The recording starts with this page; remembering the wall clock here
    // lets us anchor trims to the schedule START (t0 - wallPage). Anchoring to
    // the file's END is wrong: closing a context appends a variable ~0.5-1s
    // finalization tail that would shift every clip late.
    const wallPage = Date.now();
    page.on("pageerror", (e) =>
      process.stdout.write(`  ! page error (${moment.id}): ${String(e).slice(0, 160)}\n`)
    );
    if (process.env.STORY_DEBUG) {
      page.on("console", (m) => {
        if (m.type() === "error")
          process.stdout.write(`  ! console (${moment.id}): ${m.text().slice(0, 160)}\n`);
      });
      page.on("framenavigated", (f) => {
        if (f === page.mainFrame())
          process.stdout.write(`  ! nav (${moment.id}): ${f.url()}\n`);
      });
    }

    let t0;
    if (moment.fromLoad) {
      // Film the page's own entrance: the clock starts at DOM-ready and the
      // site's intro animation IS the shot.
      await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: 60000 });
      t0 = Date.now();
    } else {
      await page.goto(config.url, { waitUntil: "networkidle", timeout: 60000 });
      await page.waitForFunction(() => !!window.__lenis, null, { timeout: 20000 });
      await page.evaluate(() => document.fonts && document.fonts.ready);
      await page.evaluate(() => {
        document.body.style.overflow = "";
        window.__lenis && window.__lenis.start();
      });
      await page.waitForTimeout(400);
      await lenisReady(page);
      await page.evaluate(() => window.__vcBoot && window.__vcBoot());
      if (process.env.STORY_DEBUG) {
        const d = await page.evaluate(() => ({
          lenis: !!window.__lenis,
          storage: (() => { try { sessionStorage.getItem("x"); return "ok"; } catch { return "DENIED"; } })(),
          preloaded: (() => { try { return sessionStorage.getItem("ami-preloaded"); } catch { return "?"; } })(),
          plnum: document.querySelector(".pl-num")?.textContent ?? null,
        }));
        process.stdout.write(`  ? ready state (${moment.id}): ${JSON.stringify(d)}\n`);
      }
      t0 = Date.now();
    }

    const state = { cursor: { x: -100, y: -100 } };
    const marks = { start: 0 };
    const samples = {};

    // Resolve selector-keyframes the moment their base beat starts, because
    // elements move between beats (the page scrolls under the camera).
    const sampleAt = async (base) => {
      for (const k of moment.camera || []) {
        if (!k.focus) continue;
        const kb = k.at.split("+")[0];
        if (kb !== base) continue;
        const key = `${k.at}|${k.focus}`;
        if (samples[key]) continue;
        const r = await rectOf(page, k.focus);
        if (r) {
          samples[key] = {
            cx: (r.x + r.w / 2) / vp.width,
            cy: (r.y + r.h / 2) / vp.height,
          };
        }
      }
    };

    try {
      await sampleAt("start");
      for (const beat of moment.beats) {
        marks[beat.name] = (Date.now() - t0) / 1000;
        await sampleAt(beat.name);
        for (const a of beat.do || []) await runAction(page, state, a);
      }
      await page.waitForTimeout(180); // absorb screencast tail
      marks.end = (Date.now() - t0) / 1000;
      await sampleAt("end");
    } catch (e) {
      await context.close().catch(() => {});
      throw e;
    }

    const video = page.video();
    await context.close();
    const webm = await video.path();

    const meta = {
      id: moment.id,
      marks,
      samples,
      total: marks.end,
      vp,
      head: (t0 - wallPage) / 1000,
    };
    fs.writeFileSync(
      path.join(workDir, `${moment.id}.json`),
      JSON.stringify({ ...meta, webm }, null, 2)
    );
    captured.push({ moment, webm, ...meta });
    process.stdout.write(
      `  · ${moment.id.padEnd(10)} ${meta.total.toFixed(2)}s  beats: ` +
        Object.entries(marks)
          .map(([k, v]) => `${k}@${v.toFixed(2)}`)
          .join(" ") +
        "\n"
    );
  };

  for (const moment of moments) {
    try {
      await filmMoment(moment);
    } catch (e) {
      process.stdout.write(
        `  ! take failed (${moment.id}): ${String(e.message || e).slice(0, 120)} — retrying\n`
      );
      await filmMoment(moment);
    }
  }

  await browser.close();
  return captured;
}

// ---------------------------------------------------------------------------
// Camera: keyframes → zoompan expressions
// ---------------------------------------------------------------------------

// Eased interpolation between keyframe values as a single ffmpeg expr.
// T is the input-frame clock; before the first key it holds, after the last
// it holds — clip() inside each segment handles both ends. A keyframe's
// `ease` shapes the segment ENDING at it: "out" (fast attack, decelerating
// settle — the professional punch-in), "in", "linear", default smoothstep.
function piecewise(keys, fps, get) {
  const T = `(in/${fps})`;
  if (keys.length === 1) return get(keys[0]).toFixed(4);
  const seg = (a, b) => {
    const v0 = get(a).toFixed(4);
    const v1 = get(b).toFixed(4);
    if (v0 === v1) return v0;
    const dt = Math.max(0.001, b.t - a.t).toFixed(3);
    const p = `clip((${T}-${a.t.toFixed(3)})/${dt},0,1)`;
    const e =
      b.ease === "out"
        ? `(1-pow(1-${p},3))`
        : b.ease === "in"
          ? `pow(${p},3)`
          : b.ease === "linear"
            ? p
            : `${p}*${p}*(3-2*${p})`;
    return `(${v0}+(${v1}-${v0})*${e})`;
  };
  let expr = seg(keys[keys.length - 2], keys[keys.length - 1]);
  for (let i = keys.length - 2; i > 0; i--) {
    expr = `if(lt(${T},${keys[i].t.toFixed(3)}),${seg(keys[i - 1], keys[i])},${expr})`;
  }
  return expr;
}

function cameraFilter(moment, marks, samples, fps, outW, outH) {
  const raw = moment.camera || [];
  let keys;
  if (!raw.length) {
    keys = [{ t: 0, cx: 0.5, cy: 0.5, z: 1 }];
  } else {
    keys = raw.map((k) => {
      let cx = k.cx, cy = k.cy;
      if (k.focus) {
        const s = samples[`${k.at}|${k.focus}`];
        if (s) ({ cx, cy } = s);
      }
      return {
        t: parseMark(k.at, marks),
        cx: Math.max(0.12, Math.min(0.88, cx ?? 0.5)),
        cy: Math.max(0.12, Math.min(0.88, cy ?? 0.5)),
        z: Math.max(1, k.z ?? 1),
        ease: k.ease,
      };
    });
    keys.sort((a, b) => a.t - b.t);
  }

  const Z = piecewise(keys, fps, (k) => k.z);
  const CX = piecewise(keys, fps, (k) => k.cx);
  const CY = piecewise(keys, fps, (k) => k.cy);
  // Pre-upscale 2x lanczos: zoompan positions in integer input pixels, so at
  // native size slow moves visibly step; doubling halves the steps and keeps
  // zoomed crops crisp. A light unsharp restores UI-text bite after scaling.
  return (
    `scale=${outW * 2}:${outH * 2}:flags=lanczos,` +
    `zoompan=z='${Z}'` +
    `:x='max(0,min((${CX})*iw-iw/(2*zoom),iw-iw/zoom))'` +
    `:y='max(0,min((${CY})*ih-ih/(2*zoom),ih-ih/zoom))'` +
    `:d=1:s=${outW}x${outH}:fps=${fps},` +
    `unsharp=5:5:0.35:5:5:0`
  );
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

const fadeAlpha = (ts, te, fd = 0.45) =>
  `alpha='if(lt(t,${ts}),0,` +
  `if(lt(t,${ts + fd}),(t-${ts})/${fd},` +
  `if(lt(t,${te - fd}),1,` +
  `if(lt(t,${te}),(${te}-t)/${fd},0))))'`;

export async function assembleStory(config, captured, outFile) {
  const work = path.join(path.dirname(outFile), "story_work");
  fs.mkdirSync(work, { recursive: true });
  const txtDir = path.join(work, "txt");
  fs.mkdirSync(txtDir, { recursive: true });

  const { width: W, height: H } = config.viewport;
  const fps = config.fps;
  const headFont = fpath(config.fonts.heading);
  const bodyFont = fpath(config.fonts.body);

  // Slack-demo style interstitial: full-bleed brand-color screen, big display
  // lines rising in with a stagger, small kicker above. Announces the moment
  // that follows it.
  const buildCard = (id, card) => {
    const bg = card.bg.replace("#", "0x");
    const fg = card.fg.replace("#", "0x");
    const accent = (card.accent || card.fg).replace("#", "0x");
    const sec = card.seconds || 1.7;
    const lines = card.lines;
    const lineH = 132;
    const blockTop = H / 2 - (lines.length * lineH) / 2 - 10;

    let chain = `[0:v]format=yuv420p`;
    if (card.kicker) {
      const kf = path.join(txtDir, `${id}_card_k.txt`);
      fs.writeFileSync(kf, card.kicker, "utf8");
      chain +=
        `,drawtext=fontfile=${bodyFont}:textfile=${fpath(kf)}:` +
        `fontsize=30:fontcolor=${accent}:x=(w-text_w)/2:y=${Math.round(blockTop - 76)}:` +
        `alpha='if(lt(t,0.1),0,min(1,(t-0.1)/0.35))'`;
    }
    lines.forEach((line, li) => {
      const lf = path.join(txtDir, `${id}_card_l${li}.txt`);
      fs.writeFileSync(lf, line, "utf8");
      const st = (0.22 + li * 0.16).toFixed(2);
      chain +=
        `,drawtext=fontfile=${headFont}:textfile=${fpath(lf)}:` +
        `fontsize=110:fontcolor=${fg}:x=(w-text_w)/2:` +
        `y='${Math.round(blockTop + li * lineH)}+pow(1-min(1,(t-${st})/0.6),3)*90':` +
        `alpha='if(lt(t,${st}),0,min(1,(t-${st})/0.4))'`;
    });

    const out = path.join(work, `card_${id}.mp4`);
    ff(
      [
        "-f", "lavfi", "-i", `color=c=${bg}:s=${W}x${H}:d=${sec}:r=${fps}`,
        "-filter_complex", `${chain}[v]`,
        "-map", "[v]",
        "-r", String(fps),
        "-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        out,
      ],
      `card:${id}`
    );
    return { file: out, dur: sec, isCard: true };
  };

  const segs = [];
  for (let i = 0; i < captured.length; i++) {
    const { moment, webm, marks, samples, total, vp, head } = captured[i];

    if (moment.card) {
      segs.push(buildCard(moment.id, moment.card));
      process.stdout.write(`  · card ${moment.id.padEnd(9)} ${(moment.card.seconds || 1.7).toFixed(2)}s\n`);
    }

    // 1) normalize the screencast to constant fps (timestamps stay wall-clock)
    const norm = path.join(work, `${moment.id}_norm.mp4`);
    ff(
      [
        "-i", webm,
        "-r", String(fps), "-fps_mode", "cfr",
        "-an", "-c:v", "libx264", "-crf", "16", "-preset", "veryfast",
        "-pix_fmt", "yuv420p",
        norm,
      ],
      `norm:${moment.id}`
    );

    // 2) trim to the measured beat window + camera + overlays in one pass.
    //    Anchor at the measured HEAD (page-create → schedule start): the
    //    recording begins with page creation, so `head + mark` is that mark's
    //    true position in the file. `clipFrom: "<beat>"` keeps only the take
    //    from that beat onward, for non-interaction footage that should just
    //    be a glimpse.
    const clipBase = moment.clipFrom ? (marks[moment.clipFrom] ?? 0) : 0;
    const effTotal = total - clipBase;
    const effMarks = Object.fromEntries(
      Object.entries(marks).map(([k, v]) => [k, Math.max(0, v - clipBase)])
    );
    const dur = ffprobeDur(norm);
    const start =
      head != null
        ? Math.max(0, Math.min(head + clipBase, dur - effTotal))
        : Math.max(0, dur - effTotal);

    // A moment filmed at a different aspect (phone take) is scaled to full
    // height and pillarboxed on a brand color instead of being stretched.
    const mvp = vp || config.viewport;
    let camW = W;
    let camH = H;
    let padFilter = null;
    if (Math.abs(mvp.width / mvp.height - W / H) > 0.01) {
      camH = H;
      camW = Math.max(2, Math.round(((mvp.width / mvp.height) * H) / 2) * 2);
      const pc = (moment.padColor || config.padColor || "#000000").replace("#", "0x");
      padFilter = `pad=${W}:${H}:${Math.round((W - camW) / 2)}:0:color=${pc}`;
    }

    const filters = [cameraFilter(moment, effMarks, samples, fps, camW, camH)];
    if (padFilter) filters.push(padFilter);

    if (moment.overlay) {
      const o = moment.overlay;
      const ts = parseMark(o.at, effMarks);
      const te = Math.min(effTotal - 0.1, ts + (o.seconds || 2.2));
      if (o.kicker) {
        fs.writeFileSync(path.join(txtDir, `${moment.id}_k.txt`), o.kicker, "utf8");
        filters.push(
          `drawtext=fontfile=${bodyFont}:textfile=${fpath(path.join(txtDir, `${moment.id}_k.txt`))}:` +
            `fontsize=27:fontcolor=white:borderw=2:bordercolor=black@0.45:` +
            `shadowcolor=black@0.45:shadowx=2:shadowy=2:` +
            `x=96:y=h-256:${fadeAlpha(ts, te)}`
        );
      }
      fs.writeFileSync(path.join(txtDir, `${moment.id}_t.txt`), o.title, "utf8");
      filters.push(
        `drawtext=fontfile=${headFont}:textfile=${fpath(path.join(txtDir, `${moment.id}_t.txt`))}:` +
          `fontsize=62:fontcolor=white:borderw=2:bordercolor=black@0.55:` +
          `shadowcolor=black@0.5:shadowx=3:shadowy=3:` +
          `x=96:y=h-212:${fadeAlpha(ts + 0.12, te)}`
      );
    }

    filters.push("format=yuv420p");
    if (i === 0) {
      const fic = (config.fadeInColor || "white").replace("#", "0x");
      filters.push(`fade=t=in:st=0:d=0.5:color=${fic}`);
    }
    // Loop seam: fade the film's tail to the color its first frames open on,
    // so replay reads as continuous.
    if (i === captured.length - 1 && config.loopOut && !config.endcard) {
      const lo = config.loopOut;
      const ld = lo.seconds || 0.45;
      filters.push(
        `fade=t=out:st=${Math.max(0, effTotal - ld).toFixed(2)}:d=${ld}:color=${lo.color.replace("#", "0x")}`
      );
    }

    const seg = path.join(work, `seg_${String(i).padStart(2, "0")}_${moment.id}.mp4`);
    ff(
      [
        "-ss", start.toFixed(3),
        "-i", norm,
        "-t", effTotal.toFixed(3),
        "-filter_complex", `[0:v]${filters.join(",")}[v]`,
        "-map", "[v]",
        "-r", String(fps),
        "-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        seg,
      ],
      `seg:${moment.id}`
    );
    segs.push({ file: seg, dur: effTotal });
    process.stdout.write(`  · seg ${moment.id.padEnd(10)} ${effTotal.toFixed(2)}s\n`);
  }

  // 3) brand end card (white, logo, CTA) — the only card in the film.
  if (config.endcard) {
    const e = config.endcard;
    fs.writeFileSync(path.join(txtDir, "end_h.txt"), e.headline, "utf8");
    fs.writeFileSync(path.join(txtDir, "end_u.txt"), e.url, "utf8");
    const petrol = (config.brand.petrol || "#163a29").replace("#", "0x");
    const magenta = (config.brand.magenta || "#cf5f93").replace("#", "0x");
    const end = path.join(work, "seg_end.mp4");
    ff(
      [
        "-f", "lavfi", "-i", `color=c=white:s=${W}x${H}:d=${e.seconds}:r=${fps}`,
        "-i", config.logo,
        "-filter_complex",
        `[0:v]format=yuv420p[bg];[1:v]scale=460:-1[lg];` +
          `[bg][lg]overlay=x=(W-w)/2:y=(H-h)/2-120[a];` +
          `[a]drawtext=fontfile=${headFont}:textfile=${fpath(path.join(txtDir, "end_h.txt"))}:` +
          `fontsize=58:fontcolor=${petrol}:x=(w-text_w)/2:y=h/2+90[b];` +
          `[b]drawtext=fontfile=${bodyFont}:textfile=${fpath(path.join(txtDir, "end_u.txt"))}:` +
          `fontsize=38:fontcolor=${magenta}:x=(w-text_w)/2:y=h/2+170[v]`,
        "-map", "[v]",
        "-r", String(fps),
        "-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        end,
      ],
      "endcard"
    );
    segs.push({ file: end, dur: e.seconds, isEnd: true });
  }

  // 4) transition chain: demo-style slide pushes around text cards, plain
  //    fade between filmed moments, dip-to-white into the brand card.
  const inputs = [];
  segs.forEach((s) => inputs.push("-i", s.file));
  let fc = "";
  let acc = segs[0].dur;
  let prev = "[0:v]";
  for (let i = 1; i < segs.length; i++) {
    const trans = segs[i].isEnd
      ? "fadewhite"
      : segs[i].isCard || segs[i - 1].isCard
        ? "slideleft"
        : "fade";
    const XF = trans === "slideleft" ? 0.35 : 0.5;
    const out = i === segs.length - 1 ? "[v]" : `[x${i}]`;
    fc += `${prev}[${i}:v]xfade=transition=${trans}:duration=${XF}:offset=${(acc - XF).toFixed(3)}${out};`;
    acc = acc - XF + segs[i].dur;
    prev = out;
  }
  const finalDur = acc;
  if (segs.length === 1) fc = `[0:v]null[v];`;

  const hasMusic = config.music && fs.existsSync(config.music);
  if (hasMusic) {
    inputs.push("-i", config.music);
    fc +=
      `[${segs.length}:a]afade=t=in:st=0:d=1.0,` +
      `afade=t=out:st=${Math.max(0, finalDur - 1.8).toFixed(3)}:d=1.8,` +
      `volume=0.8,atrim=0:${finalDur.toFixed(3)}[a];`;
  }
  fc = fc.replace(/;$/, "");

  const mapArgs = ["-map", "[v]"];
  if (hasMusic) mapArgs.push("-map", "[a]", "-c:a", "aac", "-b:a", "192k", "-shortest");

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

  return { outFile, finalDur, hasMusic, segments: segs.length };
}

// Re-assemble from cached recordings + measured marks (skip slow capture).
export function loadCapturedStory(config, workDir, onlyIds) {
  const moments = config.moments.filter((m) => !onlyIds || onlyIds.includes(m.id));
  return moments.map((moment) => {
    const metaPath = path.join(workDir, `${moment.id}.json`);
    if (!fs.existsSync(metaPath))
      throw new Error(`no cached capture for "${moment.id}" — run without --assemble-only`);
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    return {
      moment,
      webm: meta.webm,
      marks: meta.marks,
      samples: meta.samples,
      total: meta.total,
      vp: meta.vp,
      head: meta.head,
    };
  });
}
