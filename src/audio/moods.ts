/**
 * Moods replace the old "records". A mood only chooses the musical key (scale) and the
 * instrument that plays the data; it never adds rhythm or time of its own. The background
 * pad (engine.ts) is a sustained, beat-free chord in the mood's key, so a listener can never
 * mistake it for data: every onset you hear comes from the data.
 */
import { SCALES, type MusicKey } from "./scale";

export type Lead = "piano" | "harp" | "flute" | "strings";

export interface Mood {
  id: "calm" | "deep" | "bright";
  title: string;
  description: string;
  key: MusicKey;
  lead: Lead;
  /** pad colour: "warm" = open chord, "deep" = root + fifth an octave lower */
  colour: "warm" | "deep";
  /** small swatch used on the mood buttons */
  swatch: string;
}

const NOTES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];

/** Data instruments use the pentatonic of the mood's key: always consonant, never tense. */
export function keyFrom(tonic: number, mode: "major" | "minor"): MusicKey {
  const root = 60 + tonic;
  return { name: `${NOTES[tonic]} ${mode}`, root: root > 66 ? root - 12 : root, steps: mode === "major" ? SCALES.majorPent : SCALES.minorPent };
}

export const MOODS: Mood[] = [
  {
    id: "calm",
    title: "Calm",
    description: "Soft piano over a warm pad, major pentatonic. The default: relaxed and clear.",
    key: keyFrom(2, "major"),
    lead: "piano",
    colour: "warm",
    swatch: "#f39a2e",
  },
  {
    id: "deep",
    title: "Deep",
    description: "Harp over a low, dark pad, minor pentatonic. Good for long, night-time listening.",
    key: keyFrom(9, "minor"),
    lead: "harp",
    colour: "deep",
    swatch: "#6a5acd",
  },
  {
    id: "bright",
    title: "Bright",
    description: "Flute over an open pad, major pentatonic. The airiest, easiest to hear on small speakers.",
    key: keyFrom(7, "major"),
    lead: "flute",
    colour: "warm",
    swatch: "#2a9c8c",
  },
];

export const moodById = (id: string) => MOODS.find((m) => m.id === id) ?? MOODS[0];
