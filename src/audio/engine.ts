/**
 * Playback engine. The data soundtrack is a SCORE (score.ts) rendered OFFLINE into stems
 * (render.ts) and cached; live playback is only a few buffer players synced to the video,
 * so it cannot crackle when the globe, video and UI are busy.
 *
 * Live (cheap) parts:
 *  - the pad: a sustained, beat-free chord in the mood's key. Never data-driven, no pulse.
 *  - Explore on a frozen frame: a gliding voice for the Point tool, scheduled sweeps for the
 *    Row / Column tools, a harp image-scan for the Box tool, plus soft gridline ticks
 *  - the audio legend demos and reference tones
 *
 * All live nodes are bound to this engine's own context (never the global one), because
 * Tone.Offline swaps the global context while it renders.
 */
import * as Tone from "tone";
import { midiToFreq, valueToMidi, valueToMidiSmooth, degreeToMidi, type MusicKey } from "./scale";
import { MOODS, type Lead, type Mood } from "./moods";
import type { Stem } from "./score";
import type { Stems, Manifest } from "./render";
import type { BoxColumn, LineSample } from "./explore";
import { Soundscape, terrainSound, type ScapeParams } from "./soundscape";
import type { DemoKind } from "@/data/types";

export type LayerId = "bed" | Stem | "explore";
export type SoundStyle = "calm" | "detailed" | "data";
export type Speed = 0.5 | 1 | 1.5;

export const LAYERS: { id: LayerId; label: string; description: string }[] = [
  { id: "bed", label: "Pad", description: "A soft, sustained background chord. It never changes with the data and has no beat." },
  { id: "lead", label: "Data notes", description: "One note per data sample: higher value = higher note; busier data = faster repeated notes." },
  { id: "guide", label: "Guide tone", description: "A very quiet tone that glides to the exact value, so small changes are audible too." },
  { id: "change", label: "Change cues", description: "Big rise: flute above, right ear. Big drop: bass below, left ear." },
  { id: "events", label: "Events", description: "Detected events (lightning) as plucked hits where they happen: left/right = longitude, higher = further north." },
  { id: "ticks", label: "Time bells", description: "A soft bell at each new month, two at a new year, a chord at a new phase." },
  { id: "explore", label: "Explore", description: "Explore tools: the gliding probe tone, sweeps, box scans and gridline ticks." },
];

const LAYER_DB: Record<LayerId, number> = { bed: -20, lead: -2, guide: -4, change: -6, events: -5, ticks: -8, explore: -4 };
const DATA_STEMS: Stem[] = ["lead", "guide", "change", "events", "ticks"];

/** Layers a sound style switches off (on top of the user's own mutes). */
export const STYLE_MUTES: Record<SoundStyle, LayerId[]> = {
  calm: ["guide", "change"],
  detailed: [],
  data: ["bed"],
};

export const STYLES: { id: SoundStyle; label: string; help: string }[] = [
  { id: "calm", label: "Simple", help: "Pad + data notes + events. The easiest to listen to." },
  { id: "detailed", label: "Detailed", help: "Adds the guide tone (exact value) and change cues." },
  { id: "data", label: "Data only", help: "Every data layer, no background pad." },
];

export interface Controls {
  pitchOct: number;
  panWidth: number;
  lead: Lead;
  speed: Speed;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
/** Explore pad level: quiet "extended emission" under the plucked notes. */
const PAD_DB = -20;
/** Pad brightness follows the value (Hubble: brighter = brighter sound). */
const padCutoff = (v: number) => 500 * Math.pow(2, 2.3 * v);

export class SoundEngine {
  private ctx!: Tone.Context;
  private ch = {} as Record<LayerId, Tone.Channel>;
  private master!: Tone.Gain;
  private duckGain!: Tone.Gain;
  private analyser!: Tone.Analyser;
  private outMeter!: Tone.Meter;
  private stemPlayers: Partial<Record<Stem, Tone.Player>> = {};
  private duration = 0;
  private bedSynth!: Tone.PolySynth;
  private bedDrone!: Tone.Synth;
  private harp!: Tone.Sampler;
  private harpPan!: Tone.Panner;
  private probe!: Tone.Sampler;
  private probePan!: Tone.Panner;
  private voice!: Tone.Synth;
  private voiceFilter!: Tone.Filter;
  private voicePan!: Tone.Panner;
  /** polyphonic: ticks are scheduled ahead by sweeps and also fired live, in any order */
  private tick!: Tone.PolySynth;
  /** the pad is monophonic (it glides), so its note starts must strictly increase */
  private lastVoiceStart = 0;
  /** stem players restart on every seek; two seeks in one audio block must not share a start time */
  private lastStemStart = 0;
  private stemTime(t: number): number {
    this.lastStemStart = Math.max(t, this.lastStemStart + 0.005);
    return this.lastStemStart;
  }
  private scape!: Soundscape;
  private restTimer: ReturnType<typeof setInterval> | null = null;
  private lastMove = 0;
  private voiceOn = false;
  private sweepEnd = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private disposables: Tone.ToneAudioNode[] = [];
  private userMutes = new Set<LayerId>();
  private style: SoundStyle = "calm";

  mood: Mood = MOODS[0];
  controls: Controls = { pitchOct: 2, panWidth: 0.8, lead: MOODS[0].lead, speed: 1 };
  /** position bookkeeping (seconds of video/data time) */
  private offset = 0;
  private startedAt = 0;
  private running = false;
  rate = 1;
  ready = false;
  samplesLoaded = false;

  private get key(): MusicKey {
    return this.mood.key;
  }
  private opt<T extends object>(o: T): T & { context: Tone.Context } {
    return { ...o, context: this.ctx };
  }

  /** Must be called synchronously from a user gesture (no autoplay). */
  async init(manifestP: Manifest | Promise<Manifest>): Promise<void> {
    if (this.ready || this.initP) return this.initP ?? undefined;
    // context created synchronously inside the user's click, before any await
    const raw = new AudioContext({ latencyHint: "playback" });
    this.ctx = new Tone.Context({ context: raw, lookAhead: 0.1 });
    void raw.resume();
    this.initP = this.build(manifestP);
    return this.initP;
  }
  private initP: Promise<void> | null = null;

  private async build(manifestP: Manifest | Promise<Manifest>): Promise<void> {
    const manifest = await manifestP;

    const limiter = new Tone.Limiter(this.opt({ threshold: -1 })).toDestination();
    this.outMeter = new Tone.Meter(this.opt({ smoothing: 0.8 }));
    limiter.connect(this.outMeter);
    const comp = new Tone.Compressor(this.opt({ threshold: -18, ratio: 2.5, attack: 0.03, release: 0.3 })).connect(limiter);
    this.master = new Tone.Gain(this.opt({ gain: 1.5 })).connect(comp);
    this.duckGain = new Tone.Gain(this.opt({ gain: 1 })).connect(this.master);
    this.analyser = new Tone.Analyser(this.opt({ type: "fft" as const, size: 128 }));
    this.duckGain.connect(this.analyser);
    // light room: ~20% wet, ~2 s decay (calm, but notes stay distinct)
    const verb = new Tone.Reverb(this.opt({ decay: 2.2, preDelay: 0.02, wet: 1 }));
    await verb.generate();
    verb.connect(this.duckGain);
    const verbSend = new Tone.Gain(this.opt({ gain: 0.2 })).connect(verb);
    this.disposables.push(limiter, this.outMeter, comp, this.master, this.duckGain, this.analyser, verb, verbSend);

    for (const { id } of LAYERS) {
      const c = new Tone.Channel(this.opt({ volume: LAYER_DB[id] })).connect(this.duckGain);
      if (id !== "bed") c.connect(verbSend);
      this.ch[id] = c;
      this.disposables.push(c);
    }
    this.applyMutes();

    // pad: static low-pass (no LFO: nothing in the background moves on its own)
    const bedFilter = new Tone.Filter(this.opt({ frequency: 900, type: "lowpass" as const, rolloff: -12 as const })).connect(this.ch.bed);
    this.bedSynth = new Tone.PolySynth(this.opt({ voice: Tone.Synth, options: { oscillator: { type: "triangle" as const }, envelope: { attack: 4, decay: 1, sustain: 0.9, release: 4 } } })).connect(bedFilter);
    this.bedSynth.volume.value = -6;
    this.bedDrone = new Tone.Synth(this.opt({ oscillator: { type: "sine" as const }, envelope: { attack: 4, decay: 1, sustain: 1, release: 4 }, volume: -6 })).connect(this.ch.bed);

    // explore instruments: harp (box scan), piano (reference + legend), gliding voice, ticks
    this.harpPan = new Tone.Panner(this.opt({ pan: 0 })).connect(this.ch.explore);
    this.harp = new Tone.Sampler(this.opt({ urls: manifest.harp, attack: 0.02, release: 1.2 })).connect(this.harpPan);
    this.probePan = new Tone.Panner(this.opt({ pan: 0 })).connect(this.ch.explore);
    this.probe = new Tone.Sampler(this.opt({ urls: manifest.piano, attack: 0.02, release: 0.8 })).connect(this.probePan);
    this.voicePan = new Tone.Panner(this.opt({ pan: 0 })).connect(this.ch.explore);
    this.voiceFilter = new Tone.Filter(this.opt({ frequency: 900, type: "lowpass" as const, rolloff: -24 as const })).connect(this.voicePan);
    // soft, warm gliding voice: sine + gentle vibrato
    const vib = new Tone.Vibrato(this.opt({ frequency: 4.5, depth: 0.05 })).connect(this.voiceFilter);
    this.voice = new Tone.Synth(this.opt({ oscillator: { type: "fattriangle" as const, count: 3, spread: 12 }, envelope: { attack: 0.35, decay: 0.3, sustain: 1, release: 0.9 }, portamento: 0.3 })).connect(vib);
    this.voice.volume.value = PAD_DB;
    // gridline tick: very short, a timbre no data note uses
    this.tick = new Tone.PolySynth(this.opt({ voice: Tone.Synth, maxPolyphony: 24, options: { oscillator: { type: "triangle" as const }, envelope: { attack: 0.002, decay: 0.06, sustain: 0, release: 0.05 } } })).connect(this.ch.explore);
    this.tick.volume.value = -14;
    this.disposables.push(vib);
    this.disposables.push(bedFilter, this.bedSynth, this.bedDrone, this.harpPan, this.harp, this.probePan, this.probe, this.voicePan, this.voiceFilter, this.voice, this.tick);

    // wait for the live samplers (their buffers use our own context)
    await new Promise<void>((resolve) => {
      const check = () => (this.harp.loaded && this.probe.loaded ? resolve() : setTimeout(check, 50));
      check();
    });
    this.scape = new Soundscape(this.ctx, this.ch.explore, () => this.key);
    this.disposables.push(this.scape as unknown as Tone.ToneAudioNode);
    this.samplesLoaded = true;
    this.ready = true;
  }

  // ---------------------------------------------------------------- stems (pre-rendered)
  /** Swap in freshly rendered stems; keeps playing from the same position (0.4 s crossfade). */
  setStems(stems: Stems, duration: number): void {
    if (!this.ready) return;
    const pos = this.position();
    const now = this.ctx.now();
    const old = this.stemPlayers;
    this.stemPlayers = {};
    this.duration = duration;
    for (const stem of DATA_STEMS) {
      const buf = stems[stem];
      if (!buf) continue;
      const p = new Tone.Player(this.opt({ loop: true, fadeIn: 0.4, fadeOut: 0.4 })).connect(this.ch[stem]);
      p.buffer = buf;
      p.loopEnd = duration;
      p.playbackRate = this.rate;
      this.stemPlayers[stem] = p;
      this.disposables.push(p);
      if (this.running) p.start(now + 0.05, pos % duration);
    }
    for (const p of Object.values(old)) {
      if (!p) continue;
      p.stop(now + 0.45);
      setTimeout(() => p.dispose(), 1500);
    }
  }

  get hasStems(): boolean {
    return Object.keys(this.stemPlayers).length > 0;
  }

  /** Current data/video time of the soundtrack. */
  position(): number {
    if (!this.ready || !this.running) return this.offset;
    const p = this.offset + (this.ctx.now() - this.startedAt) * this.rate;
    return this.duration ? p % this.duration : p;
  }

  /** Jump the soundtrack to a video time (seek / resync). */
  seek(t: number): void {
    this.offset = t;
    if (!this.running) return;
    const now = this.stemTime(this.ctx.now() + 0.03);
    this.startedAt = now;
    for (const p of Object.values(this.stemPlayers)) {
      if (!p) continue;
      p.stop(now);
      p.start(now, this.duration ? t % this.duration : t);
    }
  }

  setRate(rate: number): void {
    this.offset = this.position();
    this.startedAt = this.ready ? this.ctx.now() : 0;
    this.rate = rate;
    for (const p of Object.values(this.stemPlayers)) if (p) p.playbackRate = rate;
  }

  play(at: number): void {
    if (!this.ready || this.running) return;
    if (this.ctx.state !== "running") void this.ctx.resume();
    this.running = true;
    this.offset = at;
    const now = this.stemTime(this.ctx.now() + 0.05);
    this.startedAt = now;
    for (const p of Object.values(this.stemPlayers)) if (p) p.start(now, this.duration ? at % this.duration : at);
    this.startBed();
  }

  pause(): void {
    if (!this.ready || !this.running) return;
    this.offset = this.position();
    this.running = false;
    const now = this.ctx.now();
    for (const p of Object.values(this.stemPlayers)) p?.stop(now);
    this.stopBed();
  }

  get playing(): boolean {
    return this.ready && this.running;
  }

  // ---------------------------------------------------------------- pad, mood, style, volume
  private startBed(): void {
    this.stopBed();
    const now = this.ctx.now() + 0.05;
    const deep = this.mood.colour === "deep";
    const root = degreeToMidi(this.key, 0, deep ? -2 : -1);
    const third = this.key.steps.includes(4) ? 16 : 15;
    const chord = deep ? [root, root + 7, root + 12] : [root, root + 7, root + 12, root + third];
    this.bedSynth.triggerAttack(chord.map(midiToFreq), now, 0.3);
    this.bedDrone.triggerAttack(midiToFreq(root - 12), now, 0.45);
  }

  private stopBed(): void {
    const now = this.ctx.now();
    this.bedSynth.releaseAll(now);
    this.bedDrone.triggerRelease(now);
  }

  setMood(m: Mood): void {
    this.mood = m;
    this.controls = { ...this.controls, lead: m.lead };
    if (this.running) this.startBed();
  }

  setControls(patch: Partial<Controls>): void {
    this.controls = { ...this.controls, ...patch };
    if (patch.speed) this.setRate(patch.speed);
  }

  setStyle(s: SoundStyle): void {
    this.style = s;
    this.applyMutes();
  }

  /** Master volume, 0..1 (perceptual: 0 = silent, 1 = full). */
  setVolume(v: number): void {
    if (this.ready) this.master.gain.rampTo(1.5 * Math.pow(clamp(v, 0, 1), 2), 0.15);
  }

  private applyMutes(): void {
    if (!this.ch.bed) return;
    const style = new Set(STYLE_MUTES[this.style]);
    for (const { id } of LAYERS) this.ch[id].mute = this.userMutes.has(id) || style.has(id);
  }

  /** Dip everything while the voice guide speaks (about -8 dB). */
  duck(on: boolean): void {
    if (this.ready) this.duckGain.gain.rampTo(on ? 0.4 : 1, 0.25);
  }

  // ---------------------------------------------------------------- Explore (frozen frame)
  /** Leaving Explore: stop any sweep and release the probe voice. */
  explore(on: boolean): void {
    if (!this.ready || on) return;
    this.stopSweep();
    this.voiceOff();
    this.scape.stop();
    if (this.restTimer) clearInterval(this.restTimer);
    this.restTimer = null;
  }

  private voiceOff(): void {
    if (!this.voiceOn) return;
    this.voice.triggerRelease(this.ctx.now());
    this.voiceOn = false;
    this.lastExplore = null;
  }

  /** True while a Row / Column / Box sweep is sounding. */
  get sweeping(): boolean {
    return this.ready && this.ctx.now() < this.sweepEnd;
  }

  /**
   * Point tool, Hearing Hubble style: every move onto a new place plucks a harp note on the
   * scale (pitch = value, louder = more), over a soft pad that glides to the exact value and
   * brightens with it (Chandra: points as notes, extended areas as a continuous tone).
   * Resting on a place repeats the pluck gently every ~2 s, so the value never disappears.
   * No data: the pad fades and one low tick says "nothing here".
   */
  exploreAt(value: number | null, x: number, accent: boolean): void {
    if (!this.ready || this.sweeping) return;
    const now = this.ctx.now();
    const pan = clamp(x * 2 - 1, -1, 1);
    this.lastMove = performance.now();
    this.voicePan.pan.rampTo(pan, 0.2);
    this.harpPan.pan.rampTo(pan, 0.05);
    this.probePan.pan.rampTo(pan, 0.05);
    if (value == null) {
      if (this.voiceOn) this.voice.volume.rampTo(-60, 0.3);
      if (this.lastExplore !== -1) this.tick.triggerAttackRelease(220, 0.04, now, 0.35);
      this.lastExplore = -1;
      return;
    }
    const v = clamp(value, 0, 1);
    const same = this.lastExplore != null && this.lastExplore >= 0 && Math.abs(v - this.lastExplore) < 0.005;
    this.lastExplore = v;
    const freq = midiToFreq(valueToMidiSmooth(this.key, v, this.controls.pitchOct));
    if (!this.voiceOn) {
      this.voiceAttack(freq, now);
      this.voiceOn = true;
    } else this.voice.setNote(freq, now);
    this.voice.volume.rampTo(PAD_DB, 0.3);
    this.voiceFilter.frequency.rampTo(padCutoff(v), 0.3);
    if (!same || accent) this.pluck(v, now, accent ? 0.75 : 0.3 + 0.45 * v);
    this.startRest();
  }
  private lastExplore: number | null = null;

  /** Start the pad, never at or before its previous start (Tone throws otherwise). */
  private voiceAttack(freq: number, t: number): void {
    const at = Math.max(t, this.lastVoiceStart + 0.01);
    this.lastVoiceStart = at;
    this.voice.triggerAttack(freq, at, 0.6);
  }

  private pluck(v: number, at: number, vel: number): void {
    this.harp.triggerAttackRelease(midiToFreq(valueToMidi(this.key, v, this.controls.pitchOct)), 1.2, at, vel);
  }

  /** While the probe rests, re-pluck the value softly every 2.2 s. */
  private startRest(): void {
    if (this.restTimer) return;
    this.restTimer = setInterval(() => {
      if (!this.voiceOn || this.sweeping || this.lastExplore == null || this.lastExplore < 0) return;
      if (performance.now() - this.lastMove < 1500) return;
      this.pluck(this.lastExplore, this.ctx.now() + 0.02, 0.18 + 0.25 * this.lastExplore);
    }, 2200);
  }

  // ---------------------------------------------------------------- Earth soundscape
  /** Point tool on the Earth atlas: the soundscape glides to this place (null = silence). */
  scapeAt(p: ScapeParams | null, x: number): void {
    if (!this.ready || this.sweeping) return;
    if (!p) return this.scape.stop();
    this.scape.set(p, clamp(x * 2 - 1, -1, 1));
  }

  /**
   * Row / Column / Box on the Earth atlas: walk the soundscape through `steps` over `seconds`
   * (with gridline ticks), like a playhead crossing the map. Returns the length in seconds.
   */
  playScape(steps: { t: number; p: ScapeParams; pan: number; tick?: "minor" | "major" }[], seconds = 6): number {
    if (!this.ready || !steps.length) return 0;
    this.stopSweep();
    this.voiceOff();
    const t0 = this.ctx.now() + 0.08;
    for (const st of steps) {
      this.timers.push(setTimeout(() => this.scape.set(st.p, st.pan), 80 + st.t * seconds * 1000));
      if (st.tick) this.tick.triggerAttackRelease(st.tick === "major" ? 440 : 1320, 0.04, t0 + st.t * seconds, st.tick === "major" ? 0.6 : 0.35);
    }
    this.sweepEnd = t0 + seconds;
    return seconds;
  }

  /** A soft gridline / border tick right now (major = lower, stronger). */
  tickNow(major: boolean): void {
    if (this.ready) this.tick.triggerAttackRelease(major ? 440 : 1320, 0.04, this.ctx.now() + 0.01, major ? 0.6 : 0.35);
  }

  private stopSweep(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    if (!this.ready) return;
    const now = this.ctx.now();
    this.voice.frequency.cancelScheduledValues(now);
    this.voice.volume.cancelScheduledValues(now);
    this.voiceFilter.frequency.cancelScheduledValues(now);
    this.voicePan.pan.cancelScheduledValues(now);
    this.harp.releaseAll(now);
    this.sweepEnd = 0;
  }

  /**
   * Row / Column tool, Hearing Hubble style: a playhead crosses the line; each sampled place
   * plucks a harp note (pitch = value, louder = more, at most ~6 notes per second), a soft pad
   * glides along underneath, silence = no data, and a tick marks every 30-degree gridline
   * (a lower one at the equator / prime meridian). Returns the sweep length in seconds.
   */
  playLine(samples: LineSample[], seconds = 6): number {
    if (!this.ready || !samples.length) return 0;
    this.stopSweep();
    this.voiceOff();
    const t0 = this.ctx.now() + 0.08;
    const stride = Math.max(1, Math.ceil(samples.length / 36));
    const first = samples.find((s) => s.value != null);
    const freq = (v: number) => midiToFreq(valueToMidiSmooth(this.key, v, this.controls.pitchOct));
    this.voice.volume.setValueAtTime(-60, t0 - 0.01);
    this.voiceAttack(freq(first?.value ?? 0.5), t0);
    this.voiceOn = true;
    samples.forEach((s, k) => {
      const t = t0 + s.t * seconds;
      this.voicePan.pan.linearRampToValueAtTime(s.pan, t);
      if (s.value != null) {
        this.voice.frequency.linearRampToValueAtTime(freq(s.value), t);
        this.voice.volume.linearRampToValueAtTime(PAD_DB, t);
        this.voiceFilter.frequency.linearRampToValueAtTime(padCutoff(s.value), t);
        if (k % stride === 0) {
          this.harpPan.pan.setValueAtTime(s.pan, t);
          this.pluck(s.value, t, 0.25 + 0.45 * s.value);
        }
      } else this.voice.volume.linearRampToValueAtTime(-60, t);
      if (s.tick) this.tick.triggerAttackRelease(s.tick === "major" ? 440 : 1320, 0.04, t, s.tick === "major" ? 0.6 : 0.35);
    });
    const end = t0 + seconds + 0.05;
    this.voice.triggerRelease(end);
    this.sweepEnd = end;
    this.timers.push(setTimeout(() => (this.voiceOn = false), (seconds + 0.2) * 1000));
    return seconds;
  }

  /**
   * Box tool (Chandra-style image scan): columns left -> right, each row band a harp note,
   * north = higher, louder = higher value. Returns the scan length in seconds.
   */
  playBox(columns: BoxColumn[], seconds = 5): number {
    if (!this.ready || !columns.length) return 0;
    this.stopSweep();
    this.voiceOff();
    const colDur = clamp(seconds / columns.length, 0.15, 0.45);
    const t0 = this.ctx.now() + 0.08;
    columns.forEach((c, k) => {
      const t = t0 + k * colDur;
      this.harpPan.pan.setValueAtTime(c.pan, t);
      for (const nt of c.notes) {
        const midi = valueToMidi(this.key, nt.pitch01, this.controls.pitchOct);
        this.harp.triggerAttackRelease(midiToFreq(midi), colDur * 2, t, 0.12 + 0.6 * clamp(nt.gain, 0, 1));
      }
    });
    const total = colDur * columns.length;
    this.sweepEnd = t0 + total;
    return total;
  }

  // ---------------------------------------------------------------- legend (live demos)
  /** Lowest and highest note the data can play: the auditory "axis" of this mood. */
  referenceTones(): void {
    if (!this.ready) return;
    const t = this.ctx.now() + 0.05;
    this.probePan.pan.value = 0;
    this.probe.triggerAttackRelease(midiToFreq(valueToMidi(this.key, 0, this.controls.pitchOct)), 1.2, t, 0.7);
    this.probe.triggerAttackRelease(midiToFreq(valueToMidi(this.key, 1, this.controls.pitchOct)), 1.2, t + 1.5, 0.7);
  }

  /** One reference note (0 = lowest, 1 = highest) for the voice guide's inline tones. */
  refNote(u: number): void {
    if (!this.ready) return;
    this.probePan.pan.value = 0;
    this.probe.triggerAttackRelease(midiToFreq(valueToMidi(this.key, u, this.controls.pitchOct)), 1, this.ctx.now() + 0.03, 0.7);
  }

  /** Demonstrate one mapping in `seconds`, from -> to. */
  demo(kind: DemoKind, from: number, to: number, seconds: number): void {
    if (!this.ready) return;
    this.stopSweep();
    this.voiceOff();
    const t0 = this.ctx.now() + 0.05;
    const note = (u: number) => midiToFreq(valueToMidi(this.key, u, this.controls.pitchOct));
    const at = (u: number) => from + (to - from) * u;
    if (kind === "density") {
      // repeated notes getting faster: 1 per second -> 8 per second
      let t = 0;
      while (t < seconds) {
        const rate = 1 + 7 * clamp(at(t / seconds), 0, 1);
        this.probe.triggerAttackRelease(note(0.5), 0.25, t0 + t, 0.5);
        t += 1 / rate;
      }
    } else if (kind === "luminance") {
      for (let k = 0; k < 6; k++) this.probe.triggerAttackRelease(note(0.5), 0.6, t0 + (k * seconds) / 6, 0.2 + 0.6 * clamp(at(k / 5), 0, 1));
    } else if (kind === "pan" || kind === "events") {
      for (let k = 0; k < 8; k++) {
        const t = t0 + (k * seconds) / 8;
        const u = clamp(at(k / 7), -1, 1);
        this.probePan.pan.setValueAtTime(kind === "pan" ? u : u * 2 - 1, t);
        this.probe.triggerAttackRelease(note(kind === "events" ? 0.3 + 0.5 * (k / 7) : 0.5), 0.3, t, 0.55);
      }
      this.timers.push(setTimeout(() => (this.probePan.pan.value = 0), seconds * 1000 + 300));
    } else if (kind === "gain" || kind === "loss") {
      const up = kind === "gain";
      this.probePan.pan.setValueAtTime(up ? 0.7 : -0.7, t0);
      for (let k = 0; k < 4; k++) this.probe.triggerAttackRelease(note(up ? 0.4 + k * 0.15 : 0.85 - k * 0.15), 0.5, t0 + k * 0.6, 0.5);
      this.timers.push(setTimeout(() => (this.probePan.pan.value = 0), seconds * 1000));
    } else if (kind === "scape") {
      // the Earth soundscape: shallow sea -> deep ocean -> lowland -> mountains -> glacier
      const tour = [
        { elev: -50, ice: false },
        { elev: -4500, ice: false },
        { elev: 200, ice: false },
        { elev: 3500, ice: false },
        { elev: 2500, ice: true },
      ];
      tour.forEach((t, k) => this.timers.push(setTimeout(() => this.scape.set(terrainSound(t), 0), (k * seconds * 1000) / tour.length)));
      this.timers.push(setTimeout(() => this.scape.stop(), seconds * 1000 + 200));
    } else if (kind === "ticks") {
      this.tick.triggerAttackRelease(1320, 0.04, t0, 0.4);
      this.tick.triggerAttackRelease(440, 0.04, t0 + 1, 0.6);
    } else {
      // pitch (and anything else): one note per step, rising with the value
      for (let k = 0; k < 8; k++) this.probe.triggerAttackRelease(note(clamp(at(k / 7), 0, 1)), 0.4, t0 + (k * seconds) / 8, 0.5);
    }
  }

  // ---------------------------------------------------------------- mixer / meters
  setLayer(id: LayerId, opts: { mute?: boolean; solo?: boolean; volume?: number }): void {
    const c = this.ch[id];
    if (!c) return;
    if (opts.mute != null) {
      if (opts.mute) this.userMutes.add(id);
      else this.userMutes.delete(id);
      this.applyMutes();
    }
    if (opts.solo != null) c.solo = opts.solo;
    if (opts.volume != null) c.volume.rampTo(LAYER_DB[id] + opts.volume, 0.2);
  }

  spectrum(bins = 16): number[] {
    if (!this.ready) return [];
    const v = this.analyser.getValue() as Float32Array;
    const out: number[] = [];
    for (let i = 0; i < bins; i++) out.push(clamp((v[i] + 90) / 70, 0, 1)); // ~375 Hz bins: 0 .. 6 kHz
    return out;
  }

  get outputDb(): number {
    if (!this.ready) return -Infinity;
    const v = this.outMeter.getValue();
    return typeof v === "number" ? v : Math.max(...v);
  }

  get contextState(): string {
    return this.ready ? this.ctx.state : "not started";
  }

  async resume(): Promise<void> {
    if (this.ready) await this.ctx.resume();
  }

  dispose(): void {
    this.timers.forEach(clearTimeout);
    if (this.restTimer) clearInterval(this.restTimer);
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    this.ready = false;
  }
}
