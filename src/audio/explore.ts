/**
 * Explore tools on a FROZEN frame (pure functions; the engine only plays what they return).
 *
 *   point  -> Hearing Hubble style: a plucked note per place (pitch = value) over a soft pad
 *   hline  -> playhead west -> east along one latitude: plucked values, pan follows longitude,
 *             a soft tick every 30 degrees and a distinct one at the prime meridian
 *   vline  -> sweep north -> south along one longitude: pitch = value, a tick every 30
 *             degrees and a distinct one at the equator
 *   box    -> NASA Chandra-style image scan of a rectangle: columns play left -> right over
 *             time, each row band is a note whose pitch is its latitude (north = higher)
 *             and whose loudness is the value; then a spoken summary
 */

export type Tool = "point" | "hline" | "vline" | "box";

export const TOOLS: { id: Tool; key: string; label: string; help: string }[] = [
  { id: "point", key: "1", label: "Point", help: "A harp note plays the value under the probe over a soft gliding tone. Higher = more. Silence = no data." },
  { id: "hline", key: "2", label: "Row", help: "A playhead sweeps this latitude west to east, plucking the values. Ticks every 30 degrees." },
  { id: "vline", key: "3", label: "Column", help: "A playhead sweeps this longitude north to south, plucking the values. Deeper tick at the equator." },
  { id: "box", key: "4", label: "Box", help: "Scan a rectangle left to right: north is higher, louder = higher value. Then hear a summary." },
];

/** Grid value -> 0..1 magnitude. Signed grids (change maps) use |v|. */
export function normalise(v: number, min: number, max: number): number {
  if (min < 0) return Math.min(1, Math.abs(v) / Math.max(Math.abs(min), Math.abs(max)));
  return Math.min(1, Math.max(0, (v - min) / (max - min || 1)));
}

/** Grid cell reader: 0..1 value (or real value, for stats), null = no data. */
export type Reader = (i: number, j: number) => number | null;

export interface Rect {
  i0: number;
  j0: number;
  i1: number;
  j1: number;
}

export interface LineSample {
  /** 0..1 position along the sweep (also its time) */
  t: number;
  value: number | null;
  pan: number;
  tick?: "minor" | "major";
}

/** Tick when moving from edge `from` to edge `to` reaches a multiple of `every`; "major" at `major`. */
function crossing(from: number, to: number, every: number, major: number): "minor" | "major" | undefined {
  const eps = 1e-9;
  // the line reached m when m lies in (from, to] (or [to, from) when walking backwards)
  const reached = (m: number) => (to > from ? m > from + eps && m <= to + eps : m >= to - eps && m < from - eps);
  if (reached(major)) return "major";
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  for (let m = Math.ceil(lo / every - eps) * every; m <= hi + eps; m += every) if (reached(m)) return "minor";
  return undefined;
}

/** Samples of one row (west -> east) or one column (north -> south) of the grid. */
export function lineSamples(read: Reader, w: number, h: number, axis: "row" | "col", index: number, every = 30): LineSample[] {
  const out: LineSample[] = [];
  if (axis === "row") {
    const j = Math.max(0, Math.min(h - 1, index));
    for (let i = 0; i < w; i++) {
      const edge = -180 + (i * 360) / w;
      const prev = -180 + ((i - 1) * 360) / w;
      out.push({ t: w > 1 ? i / (w - 1) : 0, value: read(i, j), pan: ((i + 0.5) / w) * 2 - 1, tick: i > 0 ? crossing(prev, edge, every, 0) : undefined });
    }
  } else {
    const i = ((index % w) + w) % w;
    const pan = ((i + 0.5) / w) * 2 - 1;
    for (let j = 0; j < h; j++) {
      // walking south: the top edge of cell j is 90 - j*180/h
      const edge = 90 - (j * 180) / h;
      const prev = 90 - ((j - 1) * 180) / h;
      out.push({ t: h > 1 ? j / (h - 1) : 0, value: read(i, j), pan, tick: j > 0 ? crossing(prev, edge, every, 0) : undefined });
    }
  }
  return out;
}

export interface BoxColumn {
  t: number;
  pan: number;
  /** one note per row band with data; pitch01 = 1 at the northern edge of the box */
  notes: { pitch01: number; gain: number }[];
}

/** Clamp a rectangle to the grid and order its corners. */
export function normRect(r: Rect, w: number, h: number): Rect {
  const c = (v: number, n: number) => Math.max(0, Math.min(n - 1, Math.round(v)));
  return { i0: c(Math.min(r.i0, r.i1), w), i1: c(Math.max(r.i0, r.i1), w), j0: c(Math.min(r.j0, r.j1), h), j1: c(Math.max(r.j0, r.j1), h) };
}

/** Rectangle of half-size (rw, rh) cells centred on a probe cell. */
export function rectAround(i: number, j: number, rw: number, rh: number, w: number, h: number): Rect {
  return normRect({ i0: i - rw, i1: i + rw, j0: j - rh, j1: j + rh }, w, h);
}

/**
 * Chandra-style scan of a box: columns left -> right (grouped into at most `maxCols` time
 * steps, so a whole-map scan stays short); rows grouped into at most `bands` pitch bands
 * (north = high); band loudness = mean value; near-empty bands stay silent.
 */
export function boxScan(read: Reader, rect: Rect, w: number, bands = 8, floor = 0.04, maxCols = 48): BoxColumn[] {
  const rows = rect.j1 - rect.j0 + 1;
  const cols = rect.i1 - rect.i0 + 1;
  const nb = Math.max(1, Math.min(bands, rows));
  const nc = Math.max(1, Math.min(maxCols, cols));
  const out: BoxColumn[] = [];
  for (let c = 0; c < nc; c++) {
    const ia = rect.i0 + Math.floor((c * cols) / nc);
    const ib = rect.i0 + Math.floor(((c + 1) * cols) / nc);
    const notes: BoxColumn["notes"] = [];
    for (let b = 0; b < nb; b++) {
      const ja = rect.j0 + Math.floor((b * rows) / nb);
      const jb = rect.j0 + Math.floor(((b + 1) * rows) / nb);
      let sum = 0;
      let n = 0;
      for (let i = ia; i < ib; i++)
        for (let j = ja; j < jb; j++) {
          const v = read(i, j);
          if (v == null) continue;
          sum += v;
          n++;
        }
      // mean over the whole band (no-data cells count as zero), so sparse bands are quieter
      const mean = sum / ((ib - ia) * (jb - ja));
      if (!n || mean < floor) continue;
      notes.push({ pitch01: nb > 1 ? 1 - b / (nb - 1) : 0.5, gain: mean });
    }
    out.push({ t: nc > 1 ? c / (nc - 1) : 0, pan: (((ia + ib) / 2) / w) * 2 - 1, notes });
  }
  return out;
}

export interface BoxStats {
  cells: number;
  dataCells: number;
  mean: number | null;
  min: number | null;
  max: number | null;
  maxAt: { i: number; j: number } | null;
  minAt: { i: number; j: number } | null;
}

/** Summary of real values inside a box (for the spoken summary). */
export function boxStats(read: Reader, rect: Rect): BoxStats {
  let sum = 0;
  let n = 0;
  let cells = 0;
  let min: number | null = null;
  let max: number | null = null;
  let minAt: BoxStats["minAt"] = null;
  let maxAt: BoxStats["maxAt"] = null;
  for (let j = rect.j0; j <= rect.j1; j++)
    for (let i = rect.i0; i <= rect.i1; i++) {
      cells++;
      const v = read(i, j);
      if (v == null) continue;
      sum += v;
      n++;
      if (max == null || v > max) {
        max = v;
        maxAt = { i, j };
      }
      if (min == null || v < min) {
        min = v;
        minAt = { i, j };
      }
    }
  return { cells, dataCells: n, mean: n ? sum / n : null, min, max, maxAt, minAt };
}
