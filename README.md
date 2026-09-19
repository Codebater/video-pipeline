# video-pipeline — polished videos from our websites

Fully-automated, **config-driven** videos. Four formats, same engine:

**1. Walkthrough promo** (`<site>.json`) — a smooth, captioned scroll tour:
```
intro card  ⨝  captioned site walkthrough  ⨝  outro CTA card   (+ optional music)
```
```powershell
node build.mjs dhami
```

**2. Feature reel** (`<site>.reel.json`) — a fast ~15s highlight of the *special*
interactions (GSAP, button animations, nav/footer details, creative sections).
Each feature is a **white card with animated English text** naming the effect,
followed by a **close-up of that effect in motion**:
```
[card: "The smiley that rolls"] → [close-up of the rolling button] → … → end card
```
```powershell
node build.mjs dhami --reel
```

**3. Hover loop** (`<site>.loop.json`) — a short, **silent, seamlessly-looping**
montage of the site's best beats, for a "work/portfolio" hover preview (the
[serious.business](https://serious.business/work) effect). Outputs the three
files a hover `<video>` needs — `mp4` + `webm` + `webp` poster:
```powershell
node build.mjs dhami --loop
```

**4. Interaction story** (`<site>.story.json`) — an **interaction-first** film:
not a page tour, but a user visibly *accomplishing something*. A visible cursor
eases toward the CTA, clicks (ripple), the UI responds, the page flies to the
result, a focus-pull spotlights the payoff — with a keyframed cinematic camera
(push-ins, holds, pull-backs) and Slack-demo-style **colored text cards**
(animated English lines on full-bleed brand colors) announcing each moment:
```
site's own entrance → [color card] → cursor → click → response → result → [color card] → … → brand card
```
```powershell
node build.mjs dhami --story
node build.mjs dhami --story --only=booking      # iterate one moment
node build.mjs dhami --story --assemble-only      # retime camera/text w/o re-filming
```

All four work the same for every site — the only per-site thing is a JSON file
in [`sites/`](sites/). Dhami is the first one wired up.

---

## Why this approach (not a screen recorder)

We **don't** screen-record in real time. On a loaded machine a real-time recorder
judders and every run looks different. Instead we drive the page's scroll position
**frame-by-frame** and screenshot each frame, then stitch with ffmpeg. The motion
is deterministic and butter-smooth regardless of CPU load.

This works because our sites are GSAP/ScrollTrigger-driven: setting the scroll
position re-renders every animation at exactly the right state. We move the camera
through Lenis (`window.__lenis.scrollTo(y, {immediate:true})`) so ScrollTrigger
stays in lock-step. Even pinned sections (the GBT horizontal timeline) animate
correctly because we scroll *through* the pin's spacer.

---

## One-time setup

```powershell
cd video-pipeline
npm install
npx playwright install chromium
```

ffmpeg must be on PATH (`ffmpeg -version`). Already present on this machine.

---

## The workflow (per video)

1. **Build & serve the site** (a production build avoids the dev RSC-manifest
   gotcha). For Dhami:
   ```powershell
   cd ..\dhami
   npm run build
   npx next start -p 3950        # must match "url" in sites/dhami.json
   ```
2. **Run the pipeline:**
   ```powershell
   cd ..\video-pipeline
   node build.mjs dhami
   ```
3. **Output:** `out/dhami/dhami-promo.mp4`

That's it. Re-run step 2 any time the site changes.

### Faster iteration
- `node build.mjs dhami --capture-only`  — only re-grab frames (the slow part).
- `node build.mjs dhami --assemble-only` — re-render the video from existing
  frames in `out/dhami/frames/`. Use this to tweak captions / intro / music
  without re-capturing (seconds instead of minutes).

---

## Adding music

The promo renders **silent** unless a track exists at the path in the config's
`music` field (default `assets/music/track.mp3`). Drop a royalty-free track there
and re-run `--assemble-only`. The pipeline auto fades it in (1.2s), fades it out
(1.5s), trims to length, and mixes at 80% volume.

Good free sources: [Pixabay Music](https://pixabay.com/music/),
[Uppbeat](https://uppbeat.io/), YouTube Audio Library.

---

## Configuring a site (`sites/<name>.json`)

| Field | Meaning |
|---|---|
| `url` | Where the site is served (must be running). |
| `viewport` | Capture resolution. `1920x1080` for web/YouTube. For Reels/TikTok use `{ "width": 1080, "height": 1920 }`. |
| `fps` | Capture + output frame rate (30 is smooth and fast; 60 doubles capture time). |
| `navOffset` | Pixels to leave above a section so the fixed nav doesn't cover its heading. |
| `brand` | Colors for the intro/outro cards (`bg`, `bgDeep`, `accent`, `text`). |
| `fonts.heading` / `fonts.body` | TTF paths for cards + captions. |
| `logo` | Logo PNG (transparent) for the intro/outro. |
| `music` | Optional MP3. Missing = silent. |
| `initScript` | JS run before page load. Dhami seeds `sessionStorage['ami-preloaded']='1'` to skip the preloader instantly. |
| `intro` / `outro` | Card text + durations. |
| `shots` | The camera shot list (below). |

### Shot list

Each shot is a camera move. They run in order; the camera starts at the top.

```jsonc
// Hold on a section (live animations like counters keep playing):
{ "type": "hold",   "at": "#sluzby", "seconds": 2.8, "caption": "Naše služby" }

// Smoothly scroll to a section. ease: "inOut" | "in" | "out" | "linear".
{ "type": "scroll", "to": "#cenik",  "seconds": 2.2, "ease": "inOut" }

// Scroll/hold then interact (open an FAQ, hover a card, etc.):
{ "type": "interact", "at": "#faq", "seconds": 3,
  "actions": [ { "click": ".faq-item:first-child button" }, { "wait": 500 } ] }
```

- `at` / `to` accept a CSS selector **or** an absolute pixel offset (number).
- `caption` is optional. Consecutive shots with the **identical** caption are
  merged into one on-screen range (so a caption can span a long scroll without
  flickering — that's how the GBT pass works).

### Tuning the camera for a section

To traverse a **pinned** section, scroll to the section *after* it — the pin adds
spacer height to the document, so the scroll naturally animates through the pin.
(Dhami scrolls `#gbt → #o-mne` over 5s to play the whole horizontal timeline.)

---

## Feature reel (`sites/<name>.reel.json`)

The reel showcases the site's **special interactions**. Unlike the walkthrough
(deterministic scroll capture), close-ups are filmed with Playwright's real-time
**video recorder** — these are time-based micro-interactions (hovers, a rolling
button, cursor-tracking eyes), not scroll-driven, so each is performed live and
recorded. Each feature performs its action at the **end** of its recording; the
pipeline keeps only the last `clipSeconds` (ffmpeg `-sseof`) and crops to a 16:9
close-up around the `focus` element.

Each `features[]` entry:

| Field | Meaning |
|---|---|
| `kicker` / `title` / `blurb` | English text on the white card (kicker = small magenta label). |
| `cardSeconds` | White card length (~0.8s). The title rises + fades in, blurb follows. |
| `clipSeconds` | Close-up length (~1.5s). Kept from the end of the recording. |
| `focus` | CSS selector of the element to crop the close-up around. |
| `pad` | Padding (px) around the focus box before expanding to 16:9. Crops never go below 820px wide, so tight elements stay sharp. |
| `actions[]` | The script that drives the interaction (below). |

**Action verbs** (run in order; everything before the final `clipSeconds` is
trimmed off, so early positioning is "free"):

```jsonc
{ "posImmediate": "#sel", "align": "top|center|below" }  // jump scroll (no animation)
{ "posBelow": "#sel" }                                    // park just below a scroll-trigger
{ "wait": 350 }                                           // ms
{ "stubScroll": true }                                    // disable lenis.scrollTo (so a click can't navigate away)
{ "click": "#sel" }                                       // e.g. trigger the smiley roll
{ "hover": "#sel" }
{ "hoverNth": "#sel", "n": 0 }                            // hover the nth match (nav links)
{ "mouseLean": "#sel", "ms": 1700 }                       // trace the cursor around an element (magnetic buttons)
{ "mouseCircle": "#sel", "radius": 230, "turns": 1.5, "ms": 1700 }  // orbit the cursor (mascot eyes)
{ "scrollIn": "#sel", "align": "center", "offset": 0, "ms": 1100 }  // REAL smooth scroll → fires ScrollTrigger, films the reveal
```

Use `scrollIn` (not `posImmediate`) for scroll-triggered reveals (animated
headings, the signature) — it actually animates the scroll so GSAP fires and the
motion is filmed. Park the element with `posBelow` first so the trigger hasn't
already fired during setup.

Tune total length by editing `cardSeconds` / `clipSeconds` / `endcard.seconds`;
the pipeline prints the final duration. Music fades are computed from the total.

---

## Hover loop (`sites/<name>.loop.json`)

A short silent loop for a portfolio/work grid that swaps a poster image for a
playing video on hover. Capture is the same deterministic scroll-stepper as the
walkthrough; the config is just a fast forward `shots` montage (plus `crossfade`
and optional `speed`). Defaults to 1280×720 — plenty for a hover tile and light
to ship.

**Seamlessness:** a forward montage's first and last frames differ, so the loop
would jump. The pipeline folds a faded-in copy of the clip's **head** over its
**tail**, then trims the head — making the first and last frames identical
(verified: amplified frame-diff is pure black). No "design it to start where it
ends" gymnastics required; any montage loops cleanly.

Outputs (in `out/<name>/`): `<name>-loop.mp4`, `<name>-loop.webm` (VP9, smaller —
listed first so browsers prefer it), `<name>-loop.webp` (poster).

**Use it on a page** — exactly the serious.business pattern (poster shows, video
plays muted on hover):

```html
<a class="work-tile" href="...">
  <video muted loop playsinline preload="none"
         poster="dhami-loop.webp"
         onmouseenter="this.play()" onmouseleave="this.pause()">
    <source src="dhami-loop.webm" type="video/webm">
    <source src="dhami-loop.mp4"  type="video/mp4">
  </video>
</a>
```
```css
.work-tile { display:block; aspect-ratio:16/9; overflow:hidden; border-radius:1rem; }
.work-tile video { width:100%; height:100%; object-fit:cover; }
```
For many tiles, prefer lazy-loading: keep `preload="none"` and only `.play()` on
hover (as above) so you don't fetch every clip up front.

---

## Interaction story (`sites/<name>.story.json`)

The interaction-first format. Rules it was built around: film *interactions*
(not pages), show **cause → effect** in full (cursor → click → response →
result), move the camera only with intent, and shape the whole film as
*problem → action → result → outcome → brand*.

**How it works.** Each `moment` is one continuously-recorded take (real-time
`recordVideo`, since these are time-based micro-interactions) structured as
named **beats**. Beats execute with wall-clock measurement, so post-production
knows the exact second of every interaction. The cinematic camera is a list of
keyframes pinned to those beats (`"at": "click+0.3"`) and rendered with ffmpeg
`zoompan` — push-ins, holds and pull-backs that stay frame-synced with the
filmed action even though capture timing varies run to run.

Injected in-page cinematography kit (works on any site):
- **virtual cursor** — visible dot that eases toward targets on slightly arced,
  human paths (`moveTo`), presses down on click
- **click ripple** — expanding magenta ring at the click point
- **focus pull** — `spotlight` action: backdrop blur + dim with a soft mask
  hole around the payoff element
- **glow** — `glow` action: brand-colored ring around an active element

Beat actions: `posImmediate`/`posBelow` (jump-position via Lenis), `scrollIn` /
`scrollBy` (real smooth scroll, filmed), `moveTo` (eased cursor flight),
`click` (press at current cursor), `cursorAt`, `spotlight`/`spotlightOff`,
`glow`/`glowOff`, `wait`, and `waitFor` (poll a page condition — used to film
the site's own preloader by marking when its counter hits 100).

Per-moment options: `fromLoad` (start the clock at DOM-ready and film the
page's entrance), `noInit` (skip the config `initScript`, e.g. to let the
preloader play), `clipFrom: "<beat>"` (keep only the take from that beat on —
non-interaction footage should be a 1–2s glimpse, not a dwell), `blockUrls`
(cancel navigations to external systems the filmed click would trigger),
`card` (Slack-style interstitial BEFORE the moment: full-bleed `bg` color
screen, small `kicker`, big display `lines` that rise in with a stagger;
slide-push transitions in and out), `overlay` (kicker + title drawn on the
footage at a beat-timed moment — use sparingly, and never where the UI's own
copy already says it), `camera` keyframes (`focus` selector or `cx`/`cy` +
`z`; selector positions are sampled live at the start of the keyframe's base
beat, because elements move as the page scrolls).

Loop-style films (`sites/dhami-loop.story.json` is the reference): per-moment
`viewport` films a phone take inside a landscape film (scaled to full height,
pillarboxed on `padColor`); `fadeInColor` + `loopOut: {color, seconds}` make
the tail fade into the color the film opens on, so replay reads as continuous.
Skip `card`/`endcard` and use `overlay` captions instead — interstitials would
break the loop rhythm.

Camera style: zooms should be quick, professional punch-ins — hold wide, then
a ~0.4s push with `"ease": "out"` right ON the action (click, result, hover),
then hold. The renderer pre-upscales 2x lanczos before `zoompan` (halves its
integer-pixel stepping, keeps zoomed crops crisp) and finishes with a light
`unsharp`. Set `STORY_DEBUG=1` to log page errors, console errors and
main-frame navigations per take.

Iteration flags: `--only=id1,id2` films/assembles a subset;
`--assemble-only` reuses cached recordings + measured beat marks (in
`out/<site>/story_cap/`) so camera/text retiming renders in seconds.

Gotchas learned the hard way:
- `recordVideo` **never upsamples**: asking for a size larger than the
  viewport letterboxes the frames onto a gray canvas and silently breaks all
  camera geometry. Record at viewport size; `zoompan` + lanczos handles zooms
  up to ~2x acceptably at 1080p.
- Trim anchors at the **end** of the recording (page-load noise is at the
  start): keep the last `marks.end` seconds, measured Node-side.
- Don't put an overlay on a beat where the site's own copy already says it —
  it reads as clutter (golden rule: every element must answer "why should the
  viewer care *right now*?").
- Never inject DOM into `<body>` before/during React hydration (the cine kit
  boots via `window.__vcBoot()` AFTER readiness) — early injection makes the
  app discard + remount its tree, killing `window.__lenis` mid-take.
- A click that sets `window.location.href` to an external site can't be
  stubbed at the handler level — `blockUrls` cancels it with an HTTP 204
  (`route.abort()` is wrong: it commits `chrome-error://` and destroys the
  page). Takes also auto-retry once on transient navigation crashes.
- Trims anchor to the measured HEAD (page-create → schedule start), not the
  file end: closing a context appends a variable ~0.5-1s finalization tail
  that would shift every camera keyframe and caption late.

Music goes at `assets/music/story.mp3` (optional; silent without it).

---

## Adding a new site

1. Serve it.
2. Copy `sites/dhami.json` → `sites/<name>.json`, update `url`, `brand`, `logo`,
   `fonts`, intro/outro text, and write a `shots` list against that site's section
   anchors / selectors.
3. `node build.mjs <name>`.

---

## Output layout

```
out/<site>/
  frames/            walkthrough: captured PNG frames + manifest.json
  work/              walkthrough: intermediate clips + caption textfiles
  <site>-promo.mp4   walkthrough video
  reel_cap/          reel: per-feature .webm recordings
  reel_work/         reel: cards + cropped clips + concat list
  <site>-reel.mp4    feature reel
  story_cap/         story: per-moment .webm recordings + measured beat marks
  story_work/        story: normalized/graded segments + text files
  <site>-story.mp4   interaction story
```

All `frames/`, `work/`, `reel_cap/`, `reel_work/` are intermediates — safe to
delete; they regenerate. Music for the reel goes at `assets/music/reel.mp3`
(the promo uses `track.mp3`); both fade in/out automatically.
