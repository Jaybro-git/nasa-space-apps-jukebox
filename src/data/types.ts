/** Shapes of the files written by scripts/ into public/data/<id>/ (plus hand-authored rules.json). */

export type DatasetKind = "decoded" | "color" | "events" | "atlas";

export interface DatasetMeta {
  id: string;
  title: string;
  svsId: number;
  svsUrl: string;
  kind: DatasetKind;
  kindLabel: string;
  /** One-paragraph plain description (liner notes, crate, info card). */
  description: string;
  /** Short source label, e.g. "ECCO2 model". */
  sourceLabel: string;
  units: string;
  range: [number, number];
  period: string;
  projection: "equirectangular" | "relative";
  aspect: number;
  video: { src: string; width: number; height: number; duration: number; fps: number; poster?: string };
  colorbar?: { src: string; units: string; values: number[]; colors: string[] };
  caveats: string[];
  grid: { w: number; h: number; min: number; max: number; noData: number; label?: string };
  /** Still maps (no timeline): image files + region lookup, explored by ear. */
  still?: {
    image: string;
    imageHi?: string;
    /** country / region outlines: {lines: [[[lon, lat], ...]]} */
    borders?: string;
    /** region raster (CountriesFile format): countries, aerosol types... */
    regions?: string;
    /** what a region is called when spoken: "country", "aerosol type" */
    regionWord: string;
    /** land / ocean map: ocean is silent and the value is not spoken */
    landMap?: boolean;
    /** elevation / depth + ice grid (TerrainFile): turns Explore into a soundscape */
    terrain?: string;
  };
  /** Named time spans inside the video, e.g. night-lights "annual" vs "change". */
  phases?: { id: string; label: string; start: number; end: number }[];
}

export interface Hotspot {
  x: number;
  y: number;
  lat: number | null;
  lon: number | null;
  value: number | null;
}

export interface FrameEvent {
  x: number;
  y: number;
  size: number;
}

/** One analysed frame. Extra numeric fields are allowed; rules address them by dotted path. */
export interface Frame {
  t: number;
  date?: string;
  label?: string;
  phase?: string;
  stats?: Record<string, number | null>;
  bands?: Record<string, number | null>;
  hotspot?: Hotspot;
  coldspot?: Hotspot;
  gradient?: number | null;
  change?: number | null;
  shares?: Record<string, number | null>;
  events?: FrameEvent[];
  eventCount?: number;
  [key: string]: unknown;
}

export interface Features {
  frames: Frame[];
}

export interface GridData {
  frames: number[][];
}

/** What data can drive (see score.ts for the sound of each). */
export type Target =
  | "pitch" // 0..1  main value -> pitch of the data notes (range set by Pitch range, in octaves)
  | "density" // 0..1  how much of the map is "active" -> 1..4 repeated notes per pulse
  | "luminance" // 0..1  intensity -> loudness (3 steps) + brightness of the data notes
  | "pan" // -1..1 position (latitude / longitude / year) -> stereo pan
  | "gain" // 0..1  "more" voice: flute, right ear (change maps)
  | "loss"; // 0..1  "less" voice: bass, left ear

/** What an audio-legend item demonstrates. */
export type DemoKind = Target | "events" | "ticks" | "scape";

export type Curve = "linear" | "sqrt" | "square" | "log";

export interface Mapping {
  feature: string; // dotted path into Frame, e.g. "stats.mean"
  /** Human label of the visual/data side, e.g. "Mean sea temperature". */
  label: string;
  /** Unit + decimals for the live value in the liner notes. */
  unit?: string;
  decimals?: number;
  target: Target;
  /** Input range; "auto" = min/max of that feature over all frames. */
  in: [number, number] | "auto";
  out?: [number, number];
  curve?: Curve;
  /** Seconds for the 1-2 s parameter glide. */
  smooth?: number;
  why: string; // shown in the UI / METHODS: every mapping must say why
}

export interface EventRule {
  layer: "events";
  maxPerFrame: number;
  minSize: number;
  /** Event size range mapped to velocity 0.2..1 */
  sizeRange: [number, number] | "auto";
  why: string;
}

export interface NarrationRule {
  /** Template with {path} or {path:1} (decimals) or {place:hotspot} or {date}. */
  template: string;
  /** Speak when the feature moved at least this much since it was last spoken. */
  feature?: string;
  minDelta?: number;
  /** Speak whenever the phase changes to this id. */
  phase?: string;
  /** Speak once at the start of the track. */
  atStart?: boolean;
}

export interface Readout {
  label: string;
  feature: string;
  decimals?: number;
  unit?: string;
  /** "percent" = 0..1 share shown as %. */
  format?: "percent";
}

export interface Rules {
  /** Up to 4 live numbers shown on the Observatory card. */
  readouts: Readout[];
  /** Legend bar when the dataset has no decoded colorbar. */
  legendBar?: { colors: string[]; min: string; max: string };
  legend: { text: string; demo?: { target: DemoKind; from: number; to: number } }[];
  mappings: Mapping[];
  events?: EventRule;
  narration: NarrationRule[];
  explore: {
    valueLabel: string;
    decimals: number;
    noData: string;
    /** Per-phase wording with {v} {abs} {dir} tokens (datasets whose grid meaning changes by phase). */
    format?: Record<string, string>;
  };
}

/** Extra layers of a still map (meta.still): imagery, outlines, region lookup. */
export interface Atlas {
  image: string;
  imageHi?: string;
  borders: number[][][] | null;
  labels: { name: string; lat: number; lon: number; rank: number }[] | null;
  regionAt: (lat: number, lon: number) => string | null;
  regionWord: string;
  landMap: boolean;
  /** elevation in metres (negative = ocean depth) and whether the place is ice; null = no terrain data */
  terrainAt: ((lat: number, lon: number) => Terrain) | null;
}

export interface Terrain {
  elev: number;
  ice: boolean;
}

export interface Dataset {
  meta: DatasetMeta;
  features: Features;
  grid: GridData;
  rules: Rules;
  atlas?: Atlas;
}
