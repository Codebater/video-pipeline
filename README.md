# video-pipeline

Turn a website into a polished promo video from a JSON file. No screen recorder, no
editor, no timeline to nudge by hand — the page is filmed **frame by frame** and stitched
with ffmpeg, so the same config produces the same video every time.

Four formats share one engine:

| Format | Config | What it is |
|---|---|---|
| **Walkthrough** | `<site>.json` | Intro card → captioned scroll tour → outro CTA, optional music |
| **Feature reel** | `<site>.reel.json` | ~15s of the site's *special* interactions, each announced by an animated card then shown in close-up |
| **Hover loop** | `<site>.loop.json` | Short, silent, seamless montage for a portfolio hover preview — outputs `mp4` + `webm` + `webp` poster |
| **Interaction story** | `<site>.story.json` | An interaction-first film: a visible cursor eases to a CTA, clicks, the UI responds, a focus-pull spotlights the payoff |

```bash
node build.mjs mysite            # walkthrough
node build.mjs mysite --reel
node build.mjs mysite --loop
node build.mjs mysite --story
```

---

## Why frame-by-frame

Real-time screen recording judders under load, and every take comes out different. This
drives the page's scroll position one frame at a time, screenshots each frame, and hands
the sequence to ffmpeg. Motion is perfectly smooth regardless of what else the machine
is doing, and a rerun is byte-comparable.

The camera moves through Lenis rather than the native scrollbar:

```js
window.__lenis.scrollTo(y, { immediate: true })
```

which keeps ScrollTrigger in lock-step, so every scroll-driven animation renders at
exactly the right state — including pinned sections, because the capture scrolls
*through* the pin's spacer rather than past it.

### The constraint this implies

**Your site must be scroll-deterministic.** That means GSAP/ScrollTrigger animations
driven by scroll position, with Lenis exposed as `window.__lenis`. Sites whose motion is
time-based (CSS animations on a wall clock, autoplaying video, `setInterval` reveals)
will not film correctly — the capture advances scroll, not time, so those elements sit
frozen or tear. This is a real limitation, not a configuration issue.

---

## Setup

```bash
npm install
npx playwright install chromium
```

ffmpeg must be on your `PATH` (`ffmpeg -version`).

---

## Per-video workflow

1. **Serve a production build** of the target site. A dev server will bite you — Next's
   RSC manifest behaves differently under `next dev` and frames come out inconsistent.

   ```bash
   npm run build && npx next start -p 3950
   ```

   The port must match `url` in your site config.

2. **Run the pipeline:**

   ```bash
   node build.mjs mysite
   node build.mjs mysite --story --only=booking      # iterate a single moment
   node build.mjs mysite --story --assemble-only     # retime camera/text without refilming
   ```

`--capture-only` and `--assemble-only` split the two expensive halves so you can iterate
on timing without re-screenshotting hundreds of frames.

---

## Configuring a site

One JSON file in `sites/` per format. The shape:

```jsonc
{
  "name": "mysite",
  "url": "http://localhost:3950",
  "lang": "en",
  "viewport": { "width": 1920, "height": 1080 },
  "fps": 30,
  "navOffset": 96,                    // sticky header height, so captions clear it

  "brand": { "bg": "#20563e", "cream": "#FAF8F5", "accent": "#f4abc8", "text": "#FAF8F5" },
  "fonts": { "heading": "/path/to/heading.ttf", "body": "/path/to/body.ttf" },
  "logo":  "/path/to/logo.png",
  "music": "assets/music/track.mp3",

  "initScript": "sessionStorage.setItem('preloader-seen','1')",   // skip intro animations

  "intro":  { "seconds": 3.2, "title": "Site Name", "subtitle": "One line of positioning" },
  "outro":  { "seconds": 3.6, "headline": "Call to action", "url": "example.com" }
}
```

`initScript` runs before the page loads and is how you skip a preloader or force a
consistent starting state — without it, frame 1 differs between runs.

> **Note on paths.** Font, logo and music paths in the example configs are absolute and
> machine-specific. Keep your own configs out of version control and ship only
> `sites/example.json`.

---

## Repo layout

```
build.mjs          CLI entry — parses flags, picks the format, runs capture → assemble
lib/
  capture.mjs      Playwright: deterministic frame capture, Lenis camera
  assemble.mjs     ffmpeg: stitching, cards, captions, music
  reel.mjs         feature-reel choreography
  loop.mjs         seamless-loop builder (mp4/webm/webp)
  story.mjs        interaction story: cursor, clicks, keyframed camera, colour cards
sites/             one JSON per site per format
assets/            music, fonts, shared card art
out/               rendered video
```

---

## License

MIT. See [LICENSE](LICENSE).
