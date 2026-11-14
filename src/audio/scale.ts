/** Scales, keys and helpers shared by every mood. Notes are always quantized to the
 *  current mood's scale, so data can never produce an out-of-key note. */

export interface MusicKey {
  name: string; // "D Dorian"
  root: number; // MIDI of the tonic around the middle register
  steps: number[]; // semitone offsets of one octave
}

export const SCALES = {
  dorian: [0, 2, 3, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  minorPent: [0, 3, 5, 7, 10],
  majorPent: [0, 2, 4, 7, 9],
};

/** Scale degree (any integer) -> MIDI note. */
export function degreeToMidi(key: MusicKey, degree: number, octaveOffset = 0): number {
  const n = key.steps.length;
  const oct = Math.floor(degree / n);
  const idx = ((degree % n) + n) % n;
  return key.root + 12 * (oct + octaveOffset) + key.steps[idx];
}

/** Snap any MIDI number to the nearest note of the key (ties go down). */
export function quantizeMidi(key: MusicKey, midi: number): number {
  const rel = midi - key.root;
  const oct = Math.floor(rel / 12);
  const pc = rel - 12 * oct;
  let best = key.steps[0];
  let bestD = Infinity;
  for (const s of [...key.steps, 12]) {
    const d = Math.abs(pc - s);
    if (d < bestD) {
      best = s;
      bestD = d;
    }
  }
  return key.root + 12 * oct + best;
}

/** 0..1 value -> integer degree in [low, high]. */
export function valueToDegree(u: number, low: number, high: number): number {
  const x = Math.min(1, Math.max(0, u));
  return Math.round(low + x * (high - low));
}

/** Chord on a scale-degree root: stacked every-other-degree (thirds in 7-note scales,
 *  open fourths/fifths in pentatonics). Bright = one extra upper voice, an octave up. */
export function chord(key: MusicKey, rootDegree: number, bright: number): number[] {
  const d = [rootDegree, rootDegree + 2, rootDegree + 4];
  if (bright > 0.5) d.push(rootDegree + 6);
  if (bright > 0.8) d.push(rootDegree + key.steps.length + 2);
  return d.map((x) => degreeToMidi(key, x, -1));
}

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

const NOTE_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
export function noteName(midi: number): string {
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

/**
 * Highest note data may reach: C6 (~1047 Hz). Sonification guidelines (Highcharts, Evershed
 * after Walker & Nees) put the accurate, comfortable range at roughly G3..C6.
 */
export const MAX_MIDI = 84;

/** Scale degrees [0, hi] used for a 0..1 value over `octaves` octaves, capped at MAX_MIDI. */
export function pitchSpan(key: MusicKey, octaves: number): number {
  let hi = Math.max(1, Math.round(octaves * key.steps.length));
  while (hi > 1 && degreeToMidi(key, hi) > MAX_MIDI) hi--;
  return hi;
}

/** 0..1 -> MIDI note on the scale (the data melody). */
export function valueToMidi(key: MusicKey, u: number, octaves: number): number {
  return degreeToMidi(key, valueToDegree(u, 0, pitchSpan(key, octaves)));
}

/** 0..1 -> continuous (unquantized) MIDI over the same span: the guide tone / explore voice. */
export function valueToMidiSmooth(key: MusicKey, u: number, octaves: number): number {
  const lo = degreeToMidi(key, 0);
  const hi = degreeToMidi(key, pitchSpan(key, octaves));
  return lo + (hi - lo) * Math.min(1, Math.max(0, u));
}
