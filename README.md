# The Earth Information Jukebox

**Can you hear the planet change?** A NASA Space Apps project that turns NASA Earth Information Center / Scientific Visualization Studio (SVS) visualizations into calm, explorable sound. It is built first for blind and low-vision listeners.

- **Every onset is data.** One soft note per data sample, so the steady pulse *is* the data's own clock and silence means "no data". Higher value = higher note; busier data = faster repeated notes (1–4 per sample, never more than 8 per second); lightning flashes are plucked hits where they strike. Nothing is random, and the background pad is a sustained chord with no beat, so no rhythm can be mistaken for data.
- **Explore freezes one frame** and offers four tools, in the spirit of NASA's Hearing Hubble and Chandra sonifications:
  - **Point**: a harp note plays the value under the probe (Hearing Hubble style), over a soft tone that glides and brightens with it;
  - **Row**: a playhead sweeps west to east, plucking the values, with a tick every 30°;
  - **Column**: the same north to south, with a deeper tick at the equator;
  - **Box**: a left-to-right image scan where north is higher and louder is more, followed by a spoken summary.
- **Voice guide** (optional): a neural voice (Fish Audio, pre-recorded at build time) speaks the introduction, the keys, and an intro for each visualization, with the lowest and highest data notes played inline. Live details such as box summaries and country names use the browser's own voice.
- **Earth soundscape**: on the Earth map each place has its own sound, shaped by real NOAA ETOPO1 elevation and depth: surf on shallow seas, a low rumble over the deep ocean, a warm tone on land that rises with height, wind on mountains, icy shimmer on glaciers. A real day of NASA MODIS clouds drifts over the globe.
- **Zoom** the globe or the flat map (wheel, pinch, + / −). **Night mode** layers the real Milky Way (NASA Deep Star Maps), slow nebula clouds and the react-bits Galaxy star field behind the app; the start screen uses the react-bits Topography field.
- **The soundtrack is pressed offline** into cached stems for crackle-free playback.

| Visualization | Source | Type of data |
|---|---|---|
| Ocean Currents & Sea Surface Temperature (ECCO2, 2007–2008) | [SVS 3912](https://svs.gsfc.nasa.gov/3912/) | **Decoded values**: pixel colours turned back into °C with the published colorbar |
| Night Lights 2012–2023 (Black Marble / VIIRS, EIC version) | [SVS 5313](https://svs.gsfc.nasa.gov/5313/) | **Colour/brightness as data**: no units; purple = more light, orange = less |
| Lightning Seen from the ISS (LIS, 2017–2023, 90 s of the 100 s movie) | [SVS 5011](https://svs.gsfc.nasa.gov/5011/) | **Detected events**: flash blobs found per frame |
| Aerosols: smoke, dust, sea salt, sulfate (GEOS, 19 Aug 2025) | [SVS 5669](https://svs.gsfc.nasa.gov/5669/) | **Categorical colours**: four types classified by hue, brightness = how much (still map) |
| Earth: countries (Blue Marble Next Generation + Natural Earth + NOAA ETOPO1 + MODIS clouds) | [NASA Earth Observatory](https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/) | **Still map soundscape**: sea / deep ocean / land / mountains / ice, borders and country names spoken |

## Run it

```powershell
npm install
python -m venv .venv
.venv\Scripts\python -m pip install -r scripts\requirements.txt

# Re-create all data from the source files (raw downloads cached in data-raw/, gitignored)
.venv\Scripts\python scripts\build_all.py --lite     # --lite: 12 MB SST movie instead of ~460 MB of TIFs

# Optional: re-record the voice guide (needs FISH_API_KEY in .env.local; uses Fish Audio's free model)
npm run voice

npm run dev        # http://localhost:3000
npm run build      # static export in out/
```

Requirements: Node 22+, Python 3.11+, ffmpeg on PATH.

The processed data, voice clips and samples are already in `public/`, so `npm run dev` works without running the pipeline. `build_all.py` checks the 30 MB budget.

**API key:** put `FISH_API_KEY=...` (and optionally `FISH_VOICE_ID`, `FISH_MODEL`) in `.env.local`, which is gitignored. The key is only used by `scripts/voice.mjs` at build time; it is never bundled into the site.

## Tests

```powershell
npm test                                   # vitest: deterministic score, note rates, pitch range, explore tools, region lookup, voice script
.venv\Scripts\python -m pytest             # colorbar decoder, country raster + RLE, aerosol colour classes
node scripts\smoke.mjs                     # headless Chrome against `npm run dev`: start gate, audio, Explore freeze/resume,
                                           #   zoom, night mode, no overlap when the player is hidden, every visualization loads
```

## Using it

The first screen asks for one key press: **Enter** starts with the voice guide, **Escape** starts silently (browsers only allow sound after a key press or click).

| Where | What |
|---|---|
| **Top bar** | Visualization dropdown, Observatory / How it sounds tabs, Voice guide, Descriptions, Night mode. |
| **Observatory** | Globe or Flat view with zoom. Live readings. Timeline, colour legend, **Sound legend**, **Explore**. |
| **How it sounds** | Every mapping with its live value and *why*, caveats, and the description transcript. |
| **The Jukebox** (right column; › hides it to a slim rail with play) | Turntable with play / pause, Speed (Slow / Normal / Fast), Volume, Style (Simple / Detailed / Data only), Mood (Calm / Deep / Bright). **Advanced**: pitch range, stereo width, instrument, per-layer mute / solo / level, shortcuts, vibration, test speakers. |

Keyboard shortcuts:

| Key | Action |
|---|---|
| Space | Play / pause |
| N / P | Next / previous visualization |
| E | Explore (freezes the frame) |
| L | Sound legend |
| D | Spoken descriptions of data changes |
| G | Globe / flat map |
| + / − / 0 | Zoom in / out / reset |
| M | Night mode |
| V | Voice guide on / off |
| H or ? | Hear all keys |
| Ctrl or Esc | Silence the voice guide |
| **In Explore** | 1–4 Point / Row / Column / Box · arrows move (Shift = faster, or resize the box) · Enter plays · A = whole map (Box) · [ ] previous / next frame · Esc leaves |

Single-key shortcuts can be turned off under *Advanced*.

See [METHODS.md](METHODS.md) for every mapping and the research behind it, and [DEMO_SCRIPT.md](DEMO_SCRIPT.md) for the 2-minute demo.

## Repository layout

```
scripts/               Python pipeline (ffmpeg + OpenCV + NumPy) and the voice generator
  build_all.py         one command: night sky + samples + datasets -> public/, budget check
  sky.py               night-mode Milky Way (NASA SVS Deep Star Maps 2020)
  clouds.py            real clouds for the Earth globe (NASA MODIS Terra + Aqua via GIBS)
  shots.mjs            UI screenshots of every state, for layout review
  samples.py           instrument samples (piano, strings, harp, flute, bass) from their GitHub listings
  voice.mjs            voice guide clips (Fish Audio, build time only)
  sources.py           every source URL used
  lib/colorbar.py      colorbar decoder (exact + hue/shaded mode)
  lib/features.py      shared per-frame features
  datasets/*.py        one script per visualization (sst, nightlights, lightning, aerosols, earth)
  tests/               pytest
public/data/<id>/      meta.json, grid.json, rules.json (hand-written), features.json + video.mp4 or a still image
public/voice/          pre-recorded voice guide clips + manifest.json
src/audio/             score (data -> notes), offline render, live engine, explore tools, moods, scales
src/voice/             voice guide (clips + browser speech fallback) and its script
src/components/        App, Header, StartGate, Observatory, Stage, Globe (three.js), GalaxyBackground, Drawer, LinerNotes
src/components/reactbits/  Galaxy and Topography from react-bits (reactbits.dev registry, kept verbatim)
src/hooks/usePlayer.ts glue: video time -> data frame -> engine; Explore freeze
```

## Attribution

Instrument samples:
- Salamander Grand Piano by Alexander Holm ([via Tone.js](https://github.com/Tonejs/audio)), [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/);
- cello, violin, harp, flute and contrabass from [tonejs-instruments](https://github.com/nbrosowsky/tonejs-instruments) by Nicholaus Brosowsky, CC BY 3.0.

Data and visualizations come from NASA's [Scientific Visualization Studio](https://svs.gsfc.nasa.gov/) and [Earth Information Center](https://svs.gsfc.nasa.gov/gallery/earth-information-center/), NASA Earth Observatory's Blue Marble Next Generation, NASA MODIS imagery via [GIBS](https://nasa-gibs.github.io/gibs-api-docs/) (clouds), [NOAA ETOPO1](https://www.ncei.noaa.gov/products/etopo-global-relief-model) (elevation and depth), and NASA SVS Deep Star Maps 2020 (night sky). Background components: [react-bits](https://reactbits.dev/) Galaxy and Topography. Country borders: [Natural Earth](https://www.naturalearthdata.com/) (public domain). Voice: [Fish Audio](https://fish.audio/). The interface design was ported from a Claude Design mockup.

NASA does not endorse any non-U.S. Government entity and is not responsible for information contained on non-U.S. Government websites.
