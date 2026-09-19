// Deterministic frame capture.
//
// Instead of screen-recording in real time (which judders on a loaded machine),
// we drive the page's scroll position frame-by-frame and screenshot each frame.
// The output is independent of machine load: every run produces identical, butter
// -smooth motion. GSAP/ScrollTrigger animations are scroll-driven, so setting the
// scroll position re-renders them at exactly the right state.
//
// The page uses Lenis smooth-scroll (exposed as window.__lenis) wired to
// ScrollTrigger via `lenis.on('scroll', ScrollTrigger.update)`. We therefore move
// the camera with `lenis.scrollTo(y, { immediate: true })` so ScrollTrigger stays
// in lock-step with us rather than fighting Lenis's own smoothing loop.

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const easings = {
  linear: (t) => t,
  in: (t) => t * t,
  out: (t) => 1 - (1 - t) * (1 - t),
  inOut: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
};

const pad = (n) => String(n).padStart(6, "0");

export async function capture(config, framesDir) {
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });

  const { width, height } = config.viewport;
  const fps = config.fps;

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--force-color-profile=srgb",
      "--hide-scrollbars",
      "--disable-features=CalculateNativeWinOcclusion",
    ],
  });
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    reducedMotion: "no-preference",
  });
  if (config.initScript) await context.addInitScript(config.initScript);

  const page = await context.newPage();
  await page.goto(config.url, { waitUntil: "networkidle", timeout: 60000 });

  // Wait for Lenis + fonts + the preloader to have cleared.
  await page.waitForFunction(() => !!window.__lenis, null, { timeout: 20000 });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  // Preloader skips instantly (sessionStorage seeded) but give layout a beat,
  // and make sure body scroll lock is released.
  await page.evaluate(() => {
    document.body.style.overflow = "";
    window.__lenis && window.__lenis.start();
  });
  await page.waitForTimeout(600);

  // Resolve a shot target (selector or absolute y) to a document scroll offset,
  // framing the section just below the fixed nav.
  const targetY = (sel, navOffset) =>
    page.evaluate(
      ({ sel, navOffset }) => {
        const max =
          document.documentElement.scrollHeight - window.innerHeight;
        if (typeof sel === "number") return Math.max(0, Math.min(sel, max));
        const el = document.querySelector(sel);
        if (!el) return 0;
        const y = el.getBoundingClientRect().top + window.scrollY - navOffset;
        return Math.max(0, Math.min(y, max));
      },
      { sel, navOffset }
    );

  const setScroll = (y) =>
    page.evaluate((y) => {
      window.__lenis.scrollTo(y, { immediate: true, force: true });
    }, y);

  // Let GSAP paint the new scroll state before we grab the pixel: two rAFs.
  const settle = () =>
    page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r))
        )
    );

  let frame = 0;
  const segments = [];

  const shoot = async () => {
    await settle();
    await page.screenshot({
      path: path.join(framesDir, `f_${pad(frame)}.png`),
      animations: "allow",
    });
    frame++;
  };

  let currentY = 0;
  await setScroll(0);

  for (const shot of config.shots) {
    const nFrames = Math.max(1, Math.round(shot.seconds * fps));
    const startFrame = frame;

    if (shot.type === "scroll") {
      const from = currentY;
      const to = await targetY(shot.to, config.navOffset);
      const ease = easings[shot.ease] || easings.inOut;
      for (let i = 0; i < nFrames; i++) {
        const t = nFrames === 1 ? 1 : i / (nFrames - 1);
        const y = from + (to - from) * ease(t);
        await setScroll(y);
        await shoot();
      }
      currentY = to;
    } else if (shot.type === "hold") {
      const y = await targetY(shot.at, config.navOffset);
      await setScroll(y);
      currentY = y;
      // Capture live frames (counters, marquee keep animating during a hold).
      for (let i = 0; i < nFrames; i++) await shoot();
    } else if (shot.type === "interact") {
      if (shot.at != null) {
        const y = await targetY(shot.at, config.navOffset);
        await setScroll(y);
        currentY = y;
      }
      for (const act of shot.actions || []) {
        if (act.hover) await page.hover(act.hover).catch(() => {});
        if (act.click) await page.click(act.click).catch(() => {});
        if (act.wait) await page.waitForTimeout(act.wait);
      }
      for (let i = 0; i < nFrames; i++) await shoot();
    }

    segments.push({
      type: shot.type,
      caption: shot.caption || null,
      startFrame,
      endFrame: frame - 1,
      startSec: startFrame / fps,
      endSec: frame / fps,
    });
    process.stdout.write(
      `  · ${shot.type.padEnd(8)} ${(shot.at || shot.to || "").padEnd(10)} ` +
        `${(frame - startFrame)} frames  (${(frame / fps).toFixed(1)}s)\n`
    );
  }

  await browser.close();

  const manifest = { fps, width, height, totalFrames: frame, segments };
  fs.writeFileSync(
    path.join(framesDir, "manifest.json"),
    JSON.stringify(manifest, null, 2)
  );
  return manifest;
}
