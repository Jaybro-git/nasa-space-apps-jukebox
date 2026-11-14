import { describe, expect, it } from "vitest";
import { buildScore, frameValues, notesPerPulse, pulses, MIN_GAP, MIN_PULSE, EVENT_GAP } from "@/audio/score";
import { boxScan, boxStats, lineSamples, normalise, normRect, rectAround } from "@/audio/explore";
import { MOODS, keyFrom } from "@/audio/moods";
import { degreeToMidi, midiToFreq, pitchSpan, MAX_MIDI } from "@/audio/scale";
import { resolveMappings } from "@/audio/rules";
import type { Frame, Rules } from "@/data/types";

const rules = (mappings: Rules["mappings"]): Rules => ({ readouts: [], legend: [], mappings, narration: [], explore: { valueLabel: "", decimals: 0, noData: "" } });
const opt = { key: MOODS[0].key, pitchOct: 2, panWidth: 0.8, lead: "piano" as const };

/** frames every `dt` s with value(i) on "v" and density(i) on "d" */
function series(n: number, dt: number, v: (i: number) => number | null, d?: (i: number) => number) {
  const frames: Frame[] = Array.from({ length: n }, (_, i) => ({ t: i * dt, v: v(i), d: d?.(i) }) as Frame);
  const m: Rules["mappings"] = [{ feature: "v", label: "v", target: "pitch", in: [0, 1], why: "" }];
  if (d) m.push({ feature: "d", label: "d", target: "density", in: [0, 1], why: "" });
  return { frames, mappings: resolveMappings(rules(m), frames), duration: n * dt };
}

describe("score: every onset is data", () => {
  it("is deterministic (no randomness)", () => {
    const s = series(20, 1, (i) => (i % 7) / 6, (i) => (i % 3) / 2);
    expect(buildScore(s.frames, s.mappings, s.duration, opt)).toEqual(buildScore(s.frames, s.mappings, s.duration, opt));
  });
  it("plays exactly one lead note per data frame when there is no density", () => {
    const s = series(12, 1, (i) => i / 11);
    const lead = buildScore(s.frames, s.mappings, s.duration, opt).notes.filter((n) => n.stem === "lead");
    expect(lead.length).toBe(12);
    expect(lead.map((n) => n.time)).toEqual(s.frames.map((f) => f.t));
  });
  it("higher value = higher note", () => {
    const s = series(10, 1, (i) => i / 9);
    const lead = buildScore(s.frames, s.mappings, s.duration, opt).notes.filter((n) => n.stem === "lead");
    for (let i = 1; i < lead.length; i++) expect(lead[i].midi).toBeGreaterThanOrEqual(lead[i - 1].midi);
    expect(lead[lead.length - 1].midi).toBeGreaterThan(lead[0].midi);
  });
  it("frames without data stay silent", () => {
    const s = series(6, 1, (i) => (i === 2 || i === 3 ? null : 0.5));
    const lead = buildScore(s.frames, s.mappings, s.duration, opt).notes.filter((n) => n.stem === "lead");
    expect(lead.map((n) => n.time)).toEqual([0, 1, 4, 5]);
  });
  it("more density = more notes per pulse, never closer than MIN_GAP", () => {
    expect(notesPerPulse(undefined, 2)).toBe(1);
    const counts = [0, 0.3, 0.6, 0.99].map((d) => notesPerPulse(d, 2));
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThan(counts[i - 1]);
    expect(notesPerPulse(1, 0.25)).toBe(2); // 0.25 s pulse fits only 2 notes at 8/s
    const s = series(30, 0.5, () => 0.5, (i) => i / 29);
    const lead = buildScore(s.frames, s.mappings, s.duration, opt).notes.filter((n) => n.stem === "lead");
    for (let i = 1; i < lead.length; i++) expect(lead[i].time - lead[i - 1].time).toBeGreaterThanOrEqual(MIN_GAP - 1e-9);
    expect(lead.filter((n) => n.time >= 10).length).toBeGreaterThan(lead.filter((n) => n.time < 5).length);
  });
  it("fast frames are grouped into pulses of at least MIN_PULSE", () => {
    const frames = Array.from({ length: 60 }, (_, i) => ({ t: i / 6 }) as Frame);
    const ps = pulses(frames, 10);
    for (const p of ps) expect(p.end - p.start).toBeGreaterThanOrEqual(MIN_PULSE - 1e-9);
    expect(ps.flatMap((p) => p.frames)).toEqual(frames.map((_, i) => i));
  });
  it("stays inside the comfortable pitch range (<= C6)", () => {
    for (const m of MOODS)
      for (const oct of [1, 2, 3, 4]) {
        const top = degreeToMidi(m.key, pitchSpan(m.key, oct));
        expect(top).toBeLessThanOrEqual(MAX_MIDI);
        expect(midiToFreq(degreeToMidi(m.key, 0))).toBeGreaterThan(180);
      }
    const s = series(10, 1, (i) => i / 9);
    const notes = buildScore(s.frames, s.mappings, s.duration, { ...opt, pitchOct: 4 }).notes;
    for (const n of notes.filter((x) => x.stem !== "ticks")) expect(n.midi).toBeLessThanOrEqual(MAX_MIDI);
  });
  it("big jumps play a change cue: up = right, down = left", () => {
    const s = series(4, 1, (i) => [0.2, 0.8, 0.8, 0.1][i]);
    const change = buildScore(s.frames, s.mappings, s.duration, opt).notes.filter((n) => n.stem === "change");
    expect(change.map((n) => [n.time, Math.sign(n.pan!)])).toEqual([
      [1, 1],
      [3, -1],
    ]);
  });
  it("events are spaced at least EVENT_GAP apart", () => {
    const frames: Frame[] = Array.from({ length: 30 }, (_, i) => ({ t: i / 6, events: [{ x: 0.2, y: 0.3, size: 9 }, { x: 0.8, y: 0.6, size: 4 }, { x: 0.5, y: 0.5, size: 5 }] }));
    const ev = { layer: "events" as const, maxPerFrame: 3, minSize: 1, sizeRange: [1, 10] as [number, number], why: "" };
    const notes = buildScore(frames, [], 5, opt, ev, [1, 10]).notes.filter((n) => n.stem === "events");
    expect(notes.length).toBeGreaterThan(0);
    for (let i = 1; i < notes.length; i++) expect(notes[i].time - notes[i - 1].time).toBeGreaterThanOrEqual(EVENT_GAP - 1e-9);
  });
  it("frameValues only reports targets that have data", () => {
    const s = series(1, 1, () => null);
    expect(frameValues(s.frames[0], s.mappings)).toEqual({});
  });
});

describe("explore tools", () => {
  const w = 72;
  const h = 36;
  const read = (i: number, j: number) => (i === 10 ? null : (i + j) / (w + h));

  it("row sweep runs west -> east with a tick every 30 degrees and a major one at 0", () => {
    const s = lineSamples(read, w, h, "row", 5);
    expect(s.length).toBe(w);
    expect(s[0].pan).toBeLessThan(0);
    expect(s[w - 1].pan).toBeGreaterThan(0);
    expect(s[10].value).toBeNull();
    const ticks = s.filter((x) => x.tick);
    expect(ticks.length).toBe(11); // -150 .. 150
    expect(s.filter((x) => x.tick === "major").length).toBe(1);
    expect(s[36].tick).toBe("major"); // cell starting at 0 degrees
  });
  it("column sweep runs north -> south with a major tick at the equator", () => {
    const s = lineSamples(read, w, h, "col", 3);
    expect(s.length).toBe(h);
    expect(s.filter((x) => x.tick).length).toBe(5); // 60, 30, 0, -30, -60
    expect(s[18].tick).toBe("major");
  });
  it("box scan plays columns left -> right, north = higher, silence where empty", () => {
    const r = rectAround(10, 18, 2, 2, w, h);
    expect(r).toEqual({ i0: 8, i1: 12, j0: 16, j1: 20 });
    const cols = boxScan(read, r, w);
    expect(cols.length).toBe(5);
    expect(cols[2].notes.length).toBe(0); // the no-data column
    expect(cols[0].notes[0].pitch01).toBe(1);
    expect(cols[0].pan).toBeLessThan(cols[4].pan);
  });
  it("box stats find the extremes", () => {
    const st = boxStats(read, normRect({ i0: 12, j0: 20, i1: 8, j1: 16 }, w, h));
    expect(st.cells).toBe(25);
    expect(st.dataCells).toBe(20);
    expect(st.maxAt).toEqual({ i: 12, j: 20 });
  });
  it("signed grids use magnitude", () => {
    expect(normalise(-50, -100, 100)).toBeCloseTo(0.5);
    expect(normalise(16, 0, 32)).toBeCloseTo(0.5);
  });
});

describe("moods", () => {
  it("every mood is pentatonic so data notes stay consonant", () => {
    for (const m of MOODS) expect(m.key.steps.length).toBe(5);
  });
  it("keyFrom keeps the root in a middle register", () => {
    for (let t = 0; t < 12; t++) {
      const root = degreeToMidi(keyFrom(t, "minor"), 0);
      expect(root).toBeGreaterThanOrEqual(54);
      expect(root).toBeLessThanOrEqual(66);
    }
  });
});

describe("earth soundscape", () => {
  it("separates shallow sea, deep ocean, land, mountains and ice", async () => {
    const { terrainSound, terrainWords } = await import("@/audio/soundscape");
    const shallow = terrainSound({ elev: -50, ice: false });
    const deep = terrainSound({ elev: -5000, ice: false });
    const low = terrainSound({ elev: 100, ice: false });
    const high = terrainSound({ elev: 4000, ice: false });
    const ice = terrainSound({ elev: 2000, ice: true });
    // water: surf, deeper = darker, slower, more rumble, lower rumble
    expect(shallow.surf).toBeGreaterThan(deep.surf);
    expect(shallow.surfCutoff).toBeGreaterThan(deep.surfCutoff);
    expect(shallow.waveRate).toBeGreaterThan(deep.waveRate);
    expect(deep.deep).toBeGreaterThan(shallow.deep);
    expect(shallow.land + shallow.wind + shallow.ice).toBe(0);
    // land: higher = higher tone and more wind; ice shimmers
    expect(low.surf + low.deep).toBe(0);
    expect(high.height).toBeGreaterThan(low.height);
    expect(high.wind).toBeGreaterThan(low.wind);
    expect(ice.ice).toBeGreaterThan(0);
    expect(low.ice).toBe(0);
    expect(terrainWords({ elev: -5000, ice: false })).toMatch(/deep ocean/);
    expect(terrainWords({ elev: 3000, ice: false })).toMatch(/high mountains/);
  });
});
