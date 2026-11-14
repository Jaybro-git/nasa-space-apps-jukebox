import type { Frame } from "./types";

/** Read a dotted path ("stats.mean", "hotspot.x", "shares.gain") as a finite number. */
export function getPath(frame: Frame | undefined, path: string): number | null {
  let cur: unknown = frame;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  if (path === "events" && Array.isArray(cur)) return cur.length;
  return typeof cur === "number" && Number.isFinite(cur) ? cur : null;
}

/** Index of the last frame with t <= time (binary search). -1 before the first frame. */
export function frameIndexAt(frames: Frame[], time: number): number {
  let lo = 0;
  let hi = frames.length - 1;
  if (!frames.length || time < frames[0].t) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid].t <= time) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Linear interpolation of one feature at a video time; holds the ends. */
export function featureAt(frames: Frame[], path: string, time: number): number | null {
  if (!frames.length) return null;
  const i = frameIndexAt(frames, time);
  if (i < 0) return getPath(frames[0], path);
  if (i >= frames.length - 1) return getPath(frames[frames.length - 1], path);
  const a = frames[i];
  const b = frames[i + 1];
  const va = getPath(a, path);
  const vb = getPath(b, path);
  if (va == null) return vb;
  if (vb == null) return va;
  const span = b.t - a.t;
  const u = span > 0 ? (time - a.t) / span : 0;
  return va + (vb - va) * Math.min(1, Math.max(0, u));
}

/** Min/max of a feature over all frames (for "auto" input ranges). */
export function featureRange(frames: Frame[], path: string): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const f of frames) {
    const v = getPath(f, path);
    if (v == null) continue;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return Number.isFinite(lo) ? [lo, hi] : null;
}
