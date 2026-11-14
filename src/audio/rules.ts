import { featureAt, featureRange } from "@/data/interpolate";
import type { Curve, Frame, Mapping, Rules, Target } from "@/data/types";

/** Value of a target that no mapping drives (shown in the UI; the score plays nothing for it). */
export const NEUTRAL: Record<Target, number> = {
  pitch: 0.5,
  density: 0.4,
  luminance: 0.5,
  pan: 0,
  gain: 0,
  loss: 0,
};

/** The four Data -> Sound channels shown as sliders in the Jukebox panel. */
export const CHANNELS: Target[] = ["pitch", "density", "luminance", "pan"];

export const TARGETS = Object.keys(NEUTRAL) as Target[];

export function applyCurve(u: number, curve: Curve = "linear"): number {
  const x = Math.min(1, Math.max(0, u));
  switch (curve) {
    case "sqrt":
      return Math.sqrt(x);
    case "square":
      return x * x;
    case "log":
      return Math.log1p(9 * x) / Math.log(10);
    default:
      return x;
  }
}

export interface ResolvedMapping extends Mapping {
  inRange: [number, number];
  outRange: [number, number];
}

/** Resolve "auto" ranges once per dataset. Mappings without data are dropped. */
export function resolveMappings(rules: Rules, frames: Frame[]): ResolvedMapping[] {
  const out: ResolvedMapping[] = [];
  for (const m of rules.mappings) {
    const inRange = m.in === "auto" ? featureRange(frames, m.feature) : m.in;
    if (!inRange) continue;
    const outRange: [number, number] = m.out ?? (m.target === "pan" ? [-1, 1] : [0, 1]);
    out.push({ ...m, inRange, outRange });
  }
  return out;
}

export function mapValue(v: number, m: ResolvedMapping): number {
  const [a, b] = m.inRange;
  const u = b === a ? 0.5 : (v - a) / (b - a);
  const c = applyCurve(u, m.curve);
  return m.outRange[0] + (m.outRange[1] - m.outRange[0]) * c;
}

/**
 * Target values at a video time. Several mappings may drive one target: they are averaged.
 * Targets nobody drives stay at NEUTRAL.
 */
export function evaluate(
  mappings: ResolvedMapping[],
  frames: Frame[],
  time: number,
): { values: Record<Target, number>; smooth: Record<Target, number> } {
  const sum: Partial<Record<Target, number>> = {};
  const n: Partial<Record<Target, number>> = {};
  const smooth: Record<Target, number> = Object.fromEntries(TARGETS.map((t) => [t, 0.6])) as Record<Target, number>;
  for (const m of mappings) {
    const v = featureAt(frames, m.feature, time);
    if (v == null) continue;
    sum[m.target] = (sum[m.target] ?? 0) + mapValue(v, m);
    n[m.target] = (n[m.target] ?? 0) + 1;
    if (m.smooth != null) smooth[m.target] = m.smooth;
  }
  const values = { ...NEUTRAL };
  for (const t of TARGETS) if (n[t]) values[t] = sum[t]! / n[t]!;
  return { values, smooth };
}

/** Crossfade between the neutral base track (mix 0) and the data-driven version (mix 1). */
export function blend(values: Record<Target, number>, mix: number): Record<Target, number> {
  const out = { ...NEUTRAL };
  for (const t of TARGETS) out[t] = NEUTRAL[t] + (values[t] - NEUTRAL[t]) * mix;
  return out;
}
