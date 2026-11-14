/**
 * The SCORE: a deterministic list of notes + automation computed from the data alone.
 * It is rendered offline into stems (render.ts) and cached, so playback needs almost no
 * real-time CPU (no crackle) and every play of the same data sounds identical.
 *
 * Design rule: every onset you hear is data. There is no beat, no filler melody and no
 * randomness, so a blind listener can trust that a change in rhythm IS a change in the data.
 *
 *   frame pulse -> one lead note per data sample (frames closer than MIN_PULSE are grouped),
 *                  so the steady pulse is the data's own sampling clock; silence = no data
 *   pitch       -> the pulse note's pitch, on the mood's pentatonic scale (north/warm/more = higher)
 *   density     -> 1..4 repeated notes inside the pulse: busier data = faster notes (max 8/s)
 *   luminance   -> 3 loudness steps + the lead's brightness (low-pass 800 Hz .. 3.5 kHz)
 *   pan         -> stereo position of the lead
 *   guide tone  -> a very quiet sine gliding to the EXACT value (detail finer than one scale step)
 *   change      -> big jump up: flute one step above, right ear; big drop: bass below, left ear
 *                  (change maps: gain / loss shares drive the same two voices)
 *   events      -> each detected event (lightning) is a pizzicato hit: pan = longitude,
 *                  pitch = latitude (north = higher), loudness = size (3 steps)
 *   time cues   -> soft bell at a new month, two bells at a new year, a chord at a new phase
 */
import { getPath } from "@/data/interpolate";
import { mapValue, type ResolvedMapping } from "./rules";
import { degreeToMidi, pitchSpan, valueToDegree, valueToMidiSmooth, type MusicKey } from "./scale";
import type { EventRule, Frame, Target } from "@/data/types";

export type Stem = "lead" | "guide" | "change" | "events" | "ticks";
export const STEMS: Stem[] = ["lead", "guide", "change", "events", "ticks"];

/** Instruments used inside each stem (sample folder names from public/samples). */
export type Inst = "piano" | "harp" | "flute" | "violin" | "contrabass" | "chime";

export interface NoteEv {
  stem: Stem;
  inst: Inst;
  time: number; // seconds of video time
  midi: number;
  dur: number; // seconds
  vel: number; // 0..1
  pan?: number; // -1..1 (events, change)
}

export interface AutoPoint {
  time: number;
  cutoff: number; // lead low-pass Hz
  leadPan: number;
  /** continuous guide-tone pitch, null = no data (guide fades out) */
  guideMidi: number | null;
}

export interface ScoreOptions {
  key: MusicKey;
  pitchOct: number;
  panWidth: number;
  lead: "piano" | "harp" | "flute" | "strings";
}

export interface Score {
  duration: number;
  notes: NoteEv[];
  auto: AutoPoint[];
}

/** Frames closer together than this are grouped into one pulse (max 4 pulses / s). */
export const MIN_PULSE = 0.25;
/** Minimum spacing between any two lead notes (max 8 notes / s, research: 1..8 / s). */
export const MIN_GAP = 0.125;
/** Minimum spacing between event hits. */
export const EVENT_GAP = 0.12;
/** A pitch jump (0..1 units) bigger than this between pulses plays a change cue. */
export const CHANGE_THRESHOLD = 0.12;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
/** 3 loudness steps only: listeners judge loudness poorly, so fewer, clearer levels. */
export const level3 = (u: number, steps: [number, number, number]) => steps[Math.min(2, Math.max(0, Math.floor(u * 3)))];
/** Roughly equal perceived loudness: ears are more sensitive near 1-4 kHz. */
const loudnessComp = (midi: number) => (midi >= 80 ? 0.8 : 1);

/** Data value of every mapped target for one frame; targets without data are absent. */
export function frameValues(frame: Frame, mappings: ResolvedMapping[]): Partial<Record<Target, number>> {
  const sum: Partial<Record<Target, number>> = {};
  const n: Partial<Record<Target, number>> = {};
  for (const m of mappings) {
    const v = getPath(frame, m.feature);
    if (v == null) continue;
    sum[m.target] = (sum[m.target] ?? 0) + mapValue(v, m);
    n[m.target] = (n[m.target] ?? 0) + 1;
  }
  const out: Partial<Record<Target, number>> = {};
  for (const t of Object.keys(sum) as Target[]) out[t] = sum[t]! / n[t]!;
  return out;
}

export interface Pulse {
  start: number;
  end: number;
  frames: number[];
}

/** Group consecutive frames so that every pulse lasts at least MIN_PULSE seconds. */
export function pulses(frames: Frame[], duration: number): Pulse[] {
  const out: Pulse[] = [];
  let cur: Pulse | null = null;
  for (let i = 0; i < frames.length; i++) {
    const end = i + 1 < frames.length ? frames[i + 1].t : duration;
    if (!cur) cur = { start: frames[i].t, end, frames: [i] };
    else {
      cur.frames.push(i);
      cur.end = end;
    }
    if (cur.end - cur.start >= MIN_PULSE - 1e-9) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) {
    const last = out[out.length - 1];
    // a short leftover joins the previous pulse rather than playing a rushed note
    if (last && cur.end - cur.start < MIN_PULSE / 2) {
      last.frames.push(...cur.frames);
      last.end = cur.end;
    } else out.push(cur);
  }
  return out;
}

/** How many notes a pulse plays: 1..4 with density, never closer than MIN_GAP. */
export function notesPerPulse(density: number | undefined, span: number): number {
  if (density == null) return 1;
  const want = 1 + Math.min(3, Math.floor(clamp(density, 0, 1) * 4));
  return Math.max(1, Math.min(want, Math.floor(span / MIN_GAP + 1e-9)));
}

function average(vals: Partial<Record<Target, number>>[]): Partial<Record<Target, number>> {
  const sum: Partial<Record<Target, number>> = {};
  const n: Partial<Record<Target, number>> = {};
  for (const v of vals)
    for (const t of Object.keys(v) as Target[]) {
      sum[t] = (sum[t] ?? 0) + v[t]!;
      n[t] = (n[t] ?? 0) + 1;
    }
  const out: Partial<Record<Target, number>> = {};
  for (const t of Object.keys(sum) as Target[]) out[t] = sum[t]! / n[t]!;
  return out;
}

const markOf = (f: Frame) => f.label ?? (f.date ? f.date.slice(0, 7) : null);
const yearOf = (f: Frame) => f.label ?? (f.date ? f.date.slice(0, 4) : null);

export function buildScore(
  frames: Frame[],
  mappings: ResolvedMapping[],
  duration: number,
  opt: ScoreOptions,
  events?: EventRule,
  sizeRange: [number, number] = [1, 2],
): Score {
  const notes: NoteEv[] = [];
  const auto: AutoPoint[] = [];
  const key = opt.key;
  const n = key.steps.length;
  const span = pitchSpan(key, opt.pitchOct);
  const leadInst: Inst = opt.lead === "strings" ? "violin" : opt.lead;
  const values = frames.map((f) => frameValues(f, mappings));
  // events carry the activity rhythm themselves; the lead then keeps one note per pulse
  const subdivide = !events;

  // ---- pulses: lead notes, change cues, automation ----
  let prevPitch: number | null = null;
  for (const p of pulses(frames, duration)) {
    const v = average(p.frames.map((i) => values[i]));
    const len = p.end - p.start;
    const pitch = v.pitch;
    auto.push({
      time: p.start,
      cutoff: v.luminance != null ? 800 * Math.pow(2, clamp(v.luminance, 0, 1) * 2.13) : 2000,
      leadPan: v.pan != null ? clamp(v.pan * opt.panWidth, -1, 1) : 0,
      guideMidi: pitch != null ? valueToMidiSmooth(key, pitch, opt.pitchOct) : null,
    });
    if (pitch == null) {
      prevPitch = null; // silence = no data here
      continue;
    }
    const deg = valueToDegree(pitch, 0, span);
    const midi = degreeToMidi(key, deg);
    const vel = (v.luminance != null ? level3(v.luminance, [0.38, 0.5, 0.62]) : 0.5) * loudnessComp(midi);
    const k = subdivide ? notesPerPulse(v.density, len) : 1;
    const step = len / k;
    for (let m = 0; m < k; m++) {
      notes.push({ stem: "lead", inst: leadInst, time: p.start + m * step, midi, dur: clamp(step * 0.9, 0.18, 0.7), vel: m === 0 ? vel : vel * 0.8 });
    }

    // change cue: gain/loss shares (change maps) or a big jump between pulses
    const up = v.gain != null || v.loss != null ? (v.gain ?? 0) >= 0.15 : prevPitch != null && pitch - prevPitch > CHANGE_THRESHOLD;
    const down = v.gain != null || v.loss != null ? (v.loss ?? 0) >= 0.15 : prevPitch != null && prevPitch - pitch > CHANGE_THRESHOLD;
    if (up) {
      const g = v.gain ?? Math.min(1, (pitch - (prevPitch ?? pitch)) * 3);
      notes.push({ stem: "change", inst: "flute", time: p.start, midi: degreeToMidi(key, deg + 1), dur: Math.min(0.6, len), vel: 0.25 + 0.3 * clamp(g, 0, 1), pan: 0.7 });
    }
    if (down) {
      const l = v.loss ?? Math.min(1, ((prevPitch ?? pitch) - pitch) * 3);
      notes.push({ stem: "change", inst: "contrabass", time: p.start, midi: degreeToMidi(key, deg - 1, -1), dur: Math.min(0.8, len), vel: 0.3 + 0.35 * clamp(l, 0, 1), pan: -0.7 });
    }
    prevPitch = pitch;
  }
  auto.push({ ...(auto[auto.length - 1] ?? { cutoff: 2000, leadPan: 0, guideMidi: null }), time: duration });

  // ---- per frame: time cues and events ----
  let lastMark: string | null = null;
  let lastYear: string | null = null;
  let lastPhase: string | undefined;
  let lastEvent = -Infinity;
  frames.forEach((f, i) => {
    const t = f.t;
    const mark = markOf(f);
    const year = yearOf(f);
    if (f.phase && lastPhase !== undefined && f.phase !== lastPhase) {
      for (const d of [0, 2, 4]) notes.push({ stem: "ticks", inst: "chime", time: t, midi: degreeToMidi(key, n + d), dur: 2.5, vel: 0.3 });
    } else if (year && lastYear !== null && year !== lastYear) {
      const top = degreeToMidi(key, 2 * n);
      notes.push({ stem: "ticks", inst: "chime", time: t, midi: top, dur: 1.5, vel: 0.3 });
      notes.push({ stem: "ticks", inst: "chime", time: t + 0.18, midi: top + 7, dur: 1.5, vel: 0.26 });
    } else if (mark && lastMark !== null && mark !== lastMark) {
      notes.push({ stem: "ticks", inst: "chime", time: t, midi: degreeToMidi(key, 2 * n), dur: 1.2, vel: 0.18 });
    }
    if (mark) lastMark = mark;
    if (year) lastYear = year;
    lastPhase = f.phase;

    if (events && f.events?.length) {
      const frameEnd = i + 1 < frames.length ? frames[i + 1].t : duration;
      const evs = f.events.filter((e) => e.size >= events.minSize).slice(0, events.maxPerFrame);
      const gap = Math.max(EVENT_GAP, (frameEnd - t) / Math.max(1, evs.length));
      evs.forEach((e, k) => {
        const time = Math.max(t + k * gap, lastEvent + EVENT_GAP);
        if (time >= frameEnd + EVENT_GAP || time >= duration) return; // too dense: drop, never crowd
        lastEvent = time;
        const u = Math.log(e.size / sizeRange[0]) / Math.log(sizeRange[1] / sizeRange[0]);
        const midi = degreeToMidi(key, valueToDegree(1 - e.y, 0, span));
        notes.push({ stem: "events", inst: "violin", time, midi, dur: 0.25, vel: level3(clamp(u, 0, 1), [0.3, 0.5, 0.7]) * loudnessComp(midi), pan: clamp(e.x * 2 - 1, -1, 1) });
      });
    }
  });

  notes.sort((a, b) => a.time - b.time);
  return { duration, notes, auto };
}
