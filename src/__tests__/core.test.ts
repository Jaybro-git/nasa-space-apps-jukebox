import { describe, expect, it } from "vitest";
import { NEUTRAL, blend, evaluate, resolveMappings } from "@/audio/rules";
import { SCALES, chord, degreeToMidi, quantizeMidi, type MusicKey } from "@/audio/scale";
import { MOODS as RECORDS } from "@/audio/moods";
import { featureAt, frameIndexAt } from "@/data/interpolate";
import { fillTemplate, NarrationPlanner } from "@/narration/template";
import type { Frame, Rules } from "@/data/types";

const frames: Frame[] = [
  { t: 0, date: "2007-03-25", stats: { mean: 18 }, hotspot: { x: 0.8, y: 0.5, lat: 2, lon: 150, value: 30.2 } },
  { t: 10, date: "2007-06-15", stats: { mean: 19 }, hotspot: { x: 0.2, y: 0.4, lat: 12, lon: -110, value: 31 } },
  { t: 20, date: "2007-09-05", stats: { mean: 20 }, hotspot: { x: 0.5, y: 0.5, lat: 0, lon: 0, value: 29 } },
];

const rules: Rules = {
  readouts: [],
  legend: [],
  mappings: [
    { feature: "stats.mean", label: "", target: "pitch", in: "auto", why: "" },
    { feature: "hotspot.x", label: "", target: "pan", in: [0, 1], out: [-0.8, 0.8], why: "" },
  ],
  narration: [],
  explore: { valueLabel: "°C", decimals: 1, noData: "land" },
};

const inKey = (k: MusicKey, midi: number) => k.steps.includes((((midi - k.root) % 12) + 12) % 12);

describe("interpolate", () => {
  it("finds frames and interpolates", () => {
    expect(frameIndexAt(frames, -1)).toBe(-1);
    expect(frameIndexAt(frames, 10)).toBe(1);
    expect(frameIndexAt(frames, 99)).toBe(2);
    expect(featureAt(frames, "stats.mean", 5)).toBeCloseTo(18.5);
    expect(featureAt(frames, "stats.mean", 50)).toBe(20);
  });
});

describe("rules", () => {
  it("resolves auto ranges and maps", () => {
    const m = resolveMappings(rules, frames);
    expect(m[0].inRange).toEqual([18, 20]);
    const { values } = evaluate(m, frames, 10);
    expect(values.pitch).toBeCloseTo(0.5);
    expect(values.pan).toBeCloseTo(-0.48);
    expect(values.density).toBe(NEUTRAL.density); // undriven target stays neutral
  });
  it("blend 0 = record only, 1 = record + data", () => {
    const v = { ...NEUTRAL, pitch: 1 };
    expect(blend(v, 0).pitch).toBe(NEUTRAL.pitch);
    expect(blend(v, 1).pitch).toBe(1);
  });
});

describe("scale + moods", () => {
  it("every degree of every record is in its key", () => {
    for (const r of RECORDS) for (let d = -14; d < 21; d++) expect(inKey(r.key, degreeToMidi(r.key, d))).toBe(true);
  });
  it("quantizes to the key", () => {
    const k: MusicKey = { name: "D Dorian", root: 62, steps: SCALES.dorian };
    for (let m = 40; m < 90; m++) {
      const q = quantizeMidi(k, m);
      expect(Math.abs(q - m)).toBeLessThanOrEqual(1);
      expect(inKey(k, q)).toBe(true);
    }
  });
  it("brighter chords add voices, all in key", () => {
    const k = RECORDS[1].key;
    expect(chord(k, 0, 0.9).length).toBeGreaterThan(chord(k, 0, 0.1).length);
    for (const n of chord(k, 2, 1)) expect(inKey(k, n)).toBe(true);
  });
});

describe("description text", () => {
  it("fills templates from data only", () => {
    expect(fillTemplate("{date}: {stats.mean:1} degrees, {place:hotspot}.", frames[0])).toBe(
      "late March 2007: 18.0 degrees, in the western Pacific near 2° N, 150° E.",
    );
    expect(fillTemplate("{stats.max:1}", frames[0])).toBeNull(); // missing -> silent, never invented
  });
  it("describes only on meaningful change", () => {
    const p = new NarrationPlanner(
      [
        { atStart: true, template: "Start {stats.mean:0}" },
        { feature: "stats.mean", minDelta: 1.5, template: "Now {stats.mean:0}, {stats.mean:trend}" },
      ],
      0,
    );
    expect(p.next(frames[0], 0)).toBe("Start 18");
    expect(p.next(frames[1], 1)).toBeNull();
    expect(p.next(frames[2], 2)).toBe("Now 20, rises");
  });
});
