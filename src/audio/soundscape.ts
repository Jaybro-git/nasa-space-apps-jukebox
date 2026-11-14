/**
 * Earth soundscape for Explore on the Earth atlas: instead of one tone whose pitch changes,
 * each kind of place has its own texture, and the numbers (depth, height) shape it.
 *
 *   shallow sea  -> surf: pink noise in slow swells; shallower = faster, brighter waves
 *   deep ocean   -> the surf darkens and slows, and a low rumble grows; deeper = lower
 *   land         -> a warm open fifth whose pitch rises with elevation
 *   mountains    -> gusting wind that grows with height (and rises in pitch)
 *   ice/glacier  -> crystalline bell shimmer and a high, cold wind
 *
 * `terrainSound` is pure (tested); `Soundscape` holds the live Tone.js layers.
 */
import * as Tone from "tone";
import type { Terrain } from "@/data/types";
import { degreeToMidi, midiToFreq, valueToDegree, type MusicKey } from "./scale";

export interface ScapeParams {
  /** wave layer level 0..1, its brightness (Hz) and swell rate (Hz) */
  surf: number;
  surfCutoff: number;
  waveRate: number;
  /** deep-ocean rumble level 0..1 and pitch (Hz) */
  deep: number;
  deepHz: number;
  /** land tone level 0..1 and height 0..1 (sets its pitch) */
  land: number;
  height: number;
  /** wind level 0..1 and band centre (Hz) */
  wind: number;
  windHz: number;
  /** glacier shimmer level 0..1 */
  ice: number;
}

const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));

export const SILENT: ScapeParams = { surf: 0, surfCutoff: 800, waveRate: 0.15, deep: 0, deepHz: 60, land: 0, height: 0, wind: 0, windHz: 600, ice: 0 };

/** Terrain (metres, negative = ocean depth) -> soundscape parameters. */
export function terrainSound(t: Terrain): ScapeParams {
  if (t.elev < 0) {
    const depth = -t.elev;
    const d = clamp(depth / 5000);
    return {
      ...SILENT,
      surf: 1 - 0.55 * clamp(depth / 4000),
      surfCutoff: 250 + 1650 * Math.pow(1 - d, 1.5),
      waveRate: 0.24 - 0.16 * d,
      deep: 0.85 * clamp((depth - 300) / 3500),
      deepHz: 75 - 35 * clamp(depth / 9000),
    };
  }
  const e = t.elev;
  return {
    ...SILENT,
    land: t.ice ? 0.4 : 0.8,
    height: clamp(e / 5000),
    wind: clamp(0.9 * clamp((e - 700) / 2800) + (t.ice ? 0.35 : 0)),
    windHz: 350 + 0.3 * Math.min(e, 6000) + (t.ice ? 900 : 0),
    ice: t.ice ? 0.9 : 0,
  };
}

/** Plain words for a place (spoken with the Point tool's Enter, and in summaries). */
export function terrainWords(t: Terrain): string {
  if (t.elev < 0) {
    const d = -t.elev;
    return d < 200 ? `shallow sea, ${Math.round(d)} metres deep` : d < 2000 ? `ocean, ${Math.round(d / 10) * 10} metres deep` : `deep ocean, ${(d / 1000).toFixed(1)} kilometres deep`;
  }
  const kind = t.ice ? "ice" : t.elev > 2500 ? "high mountains" : t.elev > 1000 ? "highlands" : "lowland";
  return `${kind}, ${Math.round(t.elev / 10) * 10} metres high`;
}

type Ctx = { context: Tone.Context };

/** Live layers; everything ends in `out` (the Explore channel). */
export class Soundscape {
  private nodes: Tone.ToneAudioNode[] = [];
  private pan: Tone.Panner;
  private surfGain: Tone.Gain;
  private surfFilter: Tone.Filter;
  private surfLfo: Tone.LFO;
  private deepGain: Tone.Gain;
  private deepOsc: Tone.Oscillator;
  private landGain: Tone.Gain;
  private landA: Tone.Oscillator;
  private landB: Tone.Oscillator;
  private windGain: Tone.Gain;
  private windFilter: Tone.Filter;
  private iceGain: Tone.Gain;
  private bells: Tone.PolySynth;
  private sources: (Tone.Noise | Tone.Oscillator | Tone.LFO)[] = [];
  private bellTimer: ReturnType<typeof setInterval> | null = null;
  private bellStep = 0;
  private iceLevel = 0;
  running = false;

  constructor(
    private ctx: Tone.Context,
    out: Tone.ToneAudioNode,
    private key: () => MusicKey,
  ) {
    const O = <T extends object>(o: T): T & Ctx => ({ ...o, context: ctx });
    this.pan = new Tone.Panner(O({ pan: 0 })).connect(out);

    // surf: pink noise -> low-pass -> swell (LFO on gain) -> level
    this.surfGain = new Tone.Gain(O({ gain: 0 })).connect(this.pan);
    const swell = new Tone.Gain(O({ gain: 0.5 })).connect(this.surfGain);
    this.surfFilter = new Tone.Filter(O({ type: "lowpass" as const, frequency: 900, rolloff: -24 as const })).connect(swell);
    const surfNoise = new Tone.Noise(O({ type: "pink" as const, volume: -8 })).connect(this.surfFilter);
    this.surfLfo = new Tone.LFO(O({ frequency: 0.15, min: 0.12, max: 1 })).connect(swell.gain);

    // deep ocean: low sine + brown-noise rumble
    this.deepGain = new Tone.Gain(O({ gain: 0 })).connect(this.pan);
    this.deepOsc = new Tone.Oscillator(O({ type: "sine" as const, frequency: 60, volume: -6 })).connect(this.deepGain);
    const rumbleF = new Tone.Filter(O({ type: "lowpass" as const, frequency: 160 })).connect(this.deepGain);
    const rumble = new Tone.Noise(O({ type: "brown" as const, volume: -10 })).connect(rumbleF);

    // land: an open fifth, soft triangle, warm low-pass
    this.landGain = new Tone.Gain(O({ gain: 0 })).connect(this.pan);
    const landF = new Tone.Filter(O({ type: "lowpass" as const, frequency: 1100 })).connect(this.landGain);
    this.landA = new Tone.Oscillator(O({ type: "triangle" as const, frequency: 147, volume: -12 })).connect(landF);
    this.landB = new Tone.Oscillator(O({ type: "triangle" as const, frequency: 220, volume: -16 })).connect(landF);

    // wind: white noise -> band-pass -> gusts (slow LFO on gain)
    this.windGain = new Tone.Gain(O({ gain: 0 })).connect(this.pan);
    const gust = new Tone.Gain(O({ gain: 0.5 })).connect(this.windGain);
    this.windFilter = new Tone.Filter(O({ type: "bandpass" as const, frequency: 600, Q: 1.6 })).connect(gust);
    const windNoise = new Tone.Noise(O({ type: "white" as const, volume: -14 })).connect(this.windFilter);
    const gustLfo = new Tone.LFO(O({ frequency: 0.11, min: 0.2, max: 1 })).connect(gust.gain);

    // glacier: soft high bells
    this.iceGain = new Tone.Gain(O({ gain: 0 })).connect(this.pan);
    this.bells = new Tone.PolySynth(O({ voice: Tone.FMSynth, options: { harmonicity: 3.5, modulationIndex: 1.5, envelope: { attack: 0.005, decay: 1.2, sustain: 0, release: 1.5 }, modulationEnvelope: { attack: 0.005, decay: 0.4, sustain: 0, release: 0.5 } } })).connect(this.iceGain);
    this.bells.volume.value = -14;

    this.sources = [surfNoise, this.surfLfo, this.deepOsc, rumble, this.landA, this.landB, windNoise, gustLfo];
    this.nodes = [this.pan, this.surfGain, swell, this.surfFilter, surfNoise, this.surfLfo, this.deepGain, this.deepOsc, rumbleF, rumble, this.landGain, landF, this.landA, this.landB, this.windGain, gust, this.windFilter, windNoise, gustLfo, this.iceGain, this.bells];
  }

  private start(): void {
    if (this.running) return;
    this.running = true;
    const t = this.ctx.now() + 0.02;
    for (const s of this.sources) s.start(t);
    // glacier bells: a slow, fixed pentatonic pattern, only heard while over ice
    this.bellTimer = setInterval(() => {
      if (this.iceLevel < 0.1) return;
      const k = this.key();
      const deg = [10, 12, 11, 13, 12, 14, 10, 13][this.bellStep++ % 8];
      this.bells.triggerAttackRelease(midiToFreq(degreeToMidi(k, deg)), 0.6, this.ctx.now() + 0.02, 0.25 + 0.2 * this.iceLevel);
    }, 750);
  }

  /** Glide to a new place (0.4 s), panned by longitude. */
  set(p: ScapeParams, pan: number): void {
    this.start();
    const r = 0.4;
    this.pan.pan.rampTo(clamp(pan, -1, 1), r);
    this.surfGain.gain.rampTo(0.55 * p.surf, r);
    this.surfFilter.frequency.rampTo(p.surfCutoff, r);
    this.surfLfo.frequency.rampTo(p.waveRate, r);
    this.deepGain.gain.rampTo(0.5 * p.deep, r);
    this.deepOsc.frequency.rampTo(p.deepHz, r);
    this.landGain.gain.rampTo(0.5 * p.land, r);
    const root = midiToFreq(degreeToMidi(this.key(), valueToDegree(p.height, -5, 7)));
    this.landA.frequency.rampTo(root, r);
    this.landB.frequency.rampTo(root * 1.5, r);
    this.windGain.gain.rampTo(0.6 * p.wind, r);
    this.windFilter.frequency.rampTo(p.windHz, r);
    this.iceGain.gain.rampTo(p.ice, r);
    this.iceLevel = p.ice;
  }

  /** Fade everything out and stop the sources (keeps the nodes for the next time). */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.iceLevel = 0;
    if (this.bellTimer) clearInterval(this.bellTimer);
    this.bellTimer = null;
    for (const g of [this.surfGain, this.deepGain, this.landGain, this.windGain, this.iceGain]) g.gain.rampTo(0, 0.5);
    const t = this.ctx.now() + 0.7;
    for (const s of this.sources) s.stop(t);
  }

  dispose(): void {
    if (this.bellTimer) clearInterval(this.bellTimer);
    this.nodes.forEach((n) => n.dispose());
  }
}
