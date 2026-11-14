/**
 * Offline rendering of a Score into stems ("pressing the record"). Each stem is rendered
 * natively in an OfflineAudioContext (faster than real time, off the live audio graph) and
 * cached by key, so live playback is just a handful of buffer players: no per-note
 * scheduling on the main thread, therefore no crackle when the globe, video and React are busy.
 */
import * as Tone from "tone";
import { STEMS, type Inst, type Score, type Stem } from "./score";
import { midiToFreq } from "./scale";

export type Manifest = Record<string, Record<string, string>>;
export type Stems = Partial<Record<Stem, Tone.ToneAudioBuffer>>;

/** Soft envelopes: 20-40 ms attack (no clicks), 0.4-1 s release (calm, no abrupt cut-offs). */
const SAMPLE_OPTS: Partial<Record<Inst, { attack: number; release: number }>> = {
  piano: { attack: 0.02, release: 0.8 },
  harp: { attack: 0.02, release: 1 },
  flute: { attack: 0.04, release: 0.6 },
  violin: { attack: 0.02, release: 0.4 },
  contrabass: { attack: 0.03, release: 0.6 },
};

const RENDER_RATE = 32000; // plenty for these instruments, and faster than 44.1 kHz
/** Guide tone level: just audible under the lead, never competing with it. */
const GUIDE_GAIN = 0.09;

type Decoded = Record<string, Record<string, Tone.ToneAudioBuffer>>;
let decodedP: Promise<Decoded> | null = null;

/** Download + decode every sample ONCE; offline renders reuse the decoded buffers. */
function decodeSamples(manifest: Manifest): Promise<Decoded> {
  decodedP ??= (async () => {
    const out: Decoded = {};
    await Promise.all(
      Object.entries(manifest).flatMap(([inst, notes]) =>
        Object.entries(notes).map(async ([note, url]) => {
          (out[inst] ??= {})[note] = await Tone.ToneAudioBuffer.fromUrl(url);
        }),
      ),
    );
    return out;
  })();
  return decodedP;
}

async function finish(ctx: Tone.OfflineContext): Promise<Tone.ToneAudioBuffer> {
  const rendered = await (ctx.rawContext as OfflineAudioContext).startRendering();
  return new Tone.ToneAudioBuffer(rendered);
}

/** Continuous sine that glides to the exact (unquantized) value; fades out where there is no data. */
async function renderGuide(score: Score): Promise<Tone.ToneAudioBuffer | undefined> {
  const pts = score.auto;
  const first = pts.find((a) => a.guideMidi != null);
  if (!first) return undefined;
  const ctx = new Tone.OfflineContext(2, score.duration, RENDER_RATE);
  const O = <T extends object>(o: T) => ({ ...o, context: ctx });
  const pan = new Tone.Panner(O({ pan: 0 })).toDestination();
  const filter = new Tone.Filter(O({ frequency: 1400, type: "lowpass" as const, rolloff: -12 as const })).connect(pan);
  const gain = new Tone.Gain(O({ gain: 0 })).connect(filter);
  const osc = new Tone.Oscillator(O({ type: "sine" as const, frequency: midiToFreq(first.guideMidi!) })).connect(gain);
  let level = 0;
  let freq = midiToFreq(first.guideMidi!);
  for (const a of pts) {
    if (a.guideMidi != null) {
      freq = midiToFreq(a.guideMidi);
      osc.frequency.exponentialRampToValueAtTime(freq, a.time);
    }
    const target = a.guideMidi != null ? GUIDE_GAIN : 0;
    if (target !== level) {
      gain.gain.setValueAtTime(level, a.time);
      gain.gain.linearRampToValueAtTime(target, Math.min(score.duration, a.time + 0.25));
      level = target;
    }
    pan.pan.linearRampToValueAtTime(a.leadPan * 0.5, a.time);
  }
  osc.start(0);
  return finish(ctx);
}

async function renderStem(stem: Stem, score: Score, manifest: Decoded): Promise<Tone.ToneAudioBuffer | undefined> {
  if (stem === "guide") return renderGuide(score);
  const notes = score.notes.filter((n) => n.stem === stem);
  if (!notes.length) return undefined;
  // We schedule every note at an absolute time, so Tone's block-by-block JS clock (Tone.Offline)
  // is not needed: the native offline context renders it all at once.
  const ctx = new Tone.OfflineContext(2, score.duration, RENDER_RATE);
  const O = <T extends object>(o: T) => ({ ...o, context: ctx });
  const out = new Tone.Gain(O({ gain: stem === "lead" ? 1.4 : 0.9 })).toDestination();
  const voices: Partial<Record<Inst, { trigger: (n: (typeof notes)[number]) => void }>> = {};
  const insts = [...new Set(notes.map((n) => n.inst))];

  let dest: Tone.ToneAudioNode = out;
  if (stem === "lead") {
    // brightness (luminance) and stereo position (pan) follow the data
    const pan = new Tone.Panner(O({ pan: 0 })).connect(out);
    const filter = new Tone.Filter(O({ frequency: 2000, type: "lowpass" as const, rolloff: -12 as const })).connect(pan);
    for (const a of score.auto) {
      pan.pan.linearRampToValueAtTime(a.leadPan, a.time);
      filter.frequency.linearRampToValueAtTime(a.cutoff, a.time);
    }
    dest = filter;
  }

  for (const inst of insts) {
    if (inst === "chime") {
      // a soft bell: a distinct timbre, so time cues are never mistaken for data notes
      const chime = new Tone.PolySynth(O({ voice: Tone.Synth, options: { oscillator: { type: "custom" as const, partials: [1, 0, 0.35, 0, 0.12, 0, 0.05] }, envelope: { attack: 0.005, decay: 1.4, sustain: 0, release: 1.6 } } })).connect(dest);
      chime.volume.value = -8;
      voices[inst] = { trigger: (n) => chime.triggerAttackRelease(midiToFreq(n.midi), n.dur, n.time, n.vel) };
      continue;
    }
    if (stem === "events" || stem === "change") {
      const pool = Array.from({ length: stem === "events" ? 4 : 2 }, () => {
        const p = new Tone.Panner(O({ pan: 0 })).connect(dest);
        const smp = new Tone.Sampler(O({ urls: manifest[inst], ...SAMPLE_OPTS[inst] })).connect(p);
        return { p, smp };
      });
      let k = 0;
      voices[inst] = {
        trigger: (n) => {
          const v = pool[k++ % pool.length];
          v.p.pan.setValueAtTime(n.pan ?? 0, n.time);
          v.smp.triggerAttackRelease(midiToFreq(n.midi), n.dur, n.time, Math.min(1, n.vel));
        },
      };
      continue;
    }
    const smp = new Tone.Sampler(O({ urls: manifest[inst], ...SAMPLE_OPTS[inst] })).connect(dest);
    voices[inst] = { trigger: (n) => smp.triggerAttackRelease(midiToFreq(n.midi), n.dur, n.time, Math.min(1, n.vel)) };
  }
  for (const n of notes) voices[n.inst]?.trigger(n);
  return finish(ctx);
}

const cache = new Map<string, Promise<Stems>>();

/** Render (or reuse) all stems for a score. `key` identifies data + mood + settings. */
export function renderStems(key: string, score: Score, manifest: Manifest, onProgress?: (done: number, total: number) => void): Promise<Stems> {
  const hit = cache.get(key);
  if (hit) return hit;
  const job = (async () => {
    const decoded = await decodeSamples(manifest);
    const out: Stems = {};
    let done = 0;
    // stems render in parallel: the browser spreads native offline renders over its threads
    await Promise.all(
      STEMS.map(async (stem) => {
        out[stem] = await renderStem(stem, score, decoded);
        onProgress?.(++done, STEMS.length);
      }),
    );
    return out;
  })();
  cache.set(key, job);
  job.catch(() => cache.delete(key));
  return job;
}

let manifestP: Promise<Manifest> | null = null;
export const loadManifest = () => (manifestP ??= fetch("/samples/manifest.json").then((r) => r.json() as Promise<Manifest>));
