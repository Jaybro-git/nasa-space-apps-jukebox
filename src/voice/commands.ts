/**
 * Voice commands: a small, fixed keyword grammar (push-to-talk, K). Pure functions, so the
 * matching is unit-tested; App turns a Command into the same actions the keyboard uses.
 *
 * The recognizer's transcript is normalised (lower case, no punctuation, filler words
 * removed, near-misses corrected to the nearest keyword), then matched by ordered rules:
 * specific phrases first ("stop exploring" before "stop", "night mode" before "night lights").
 */

export type VizId = "sst" | "nightlights" | "lightning" | "aerosols" | "earth";
export type ToolId = "point" | "hline" | "vline" | "box";
export type Dir = "north" | "south" | "east" | "west";

export type Command =
  | { kind: "play" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "vizStep"; step: 1 | -1 }
  | { kind: "viz"; id: VizId }
  | { kind: "explore"; on: boolean }
  | { kind: "tool"; tool: ToolId }
  | { kind: "wholeMap" }
  | { kind: "run" }
  | { kind: "move"; dir: Dir; steps: number }
  | { kind: "frame"; step: 1 | -1 }
  | { kind: "zoom"; step: 1 | -1 | 0 }
  | { kind: "volume"; step: 1 | -1 }
  | { kind: "speed"; step: 1 | -1 | 0 }
  | { kind: "legend" }
  | { kind: "describe"; on: boolean }
  | { kind: "theme"; dark: boolean }
  | { kind: "where" }
  | { kind: "goto"; place: string }
  | { kind: "repeat" }
  | { kind: "help" }
  | { kind: "ambiguous"; options: Command[]; question: string }
  | { kind: "unknown" };

/** Words the recognizer often adds that never change the meaning. */
const FILLER = new Set(["please", "um", "uh", "erm", "hmm", "okay", "ok", "hey", "jukebox", "now", "just", "the", "a", "an", "and"]);

const NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, once: 1, twice: 2 };

/** Dataset names and what people call them. */
export const VIZ_WORDS: [VizId, string[]][] = [
  ["nightlights", ["night lights", "nightlights", "night light", "city lights", "lights at night", "lights"]],
  ["lightning", ["lightning", "lightening", "storms", "storm", "thunder", "flashes"]],
  ["aerosols", ["aerosols", "aerosol", "smoke", "dust", "air quality", "pollution"]],
  ["earth", ["earth", "countries", "country map", "blue marble", "world map", "atlas", "world"]],
  ["sst", ["ocean", "oceans", "sea temperature", "sea surface temperature", "ocean temperature", "temperature", "ocean currents", "sea"]],
];

const VIZ_NAMES: Record<VizId, string> = { sst: "ocean temperature", nightlights: "night lights", lightning: "lightning", aerosols: "aerosols", earth: "Earth" };
export const vizName = (id: VizId) => VIZ_NAMES[id];

/** Every keyword the grammar knows, for correcting near-misses ("explorer" -> "explore"). */
const VOCAB = [
  ...new Set(
    [
      "help", "repeat", "again", "where", "explore", "exploring", "done", "exit", "leave", "whole", "entire", "map", "point", "probe", "row", "horizontal", "column",
      "vertical", "box", "area", "rectangle", "scan", "sweep", "listen", "next", "previous", "back", "frame", "north", "south", "east", "west", "up", "down", "left",
      "right", "far", "zoom", "closer", "reset", "louder", "quieter", "softer", "volume", "faster", "slower", "speed", "normal", "legend", "describe", "descriptions",
      "night", "dark", "day", "light", "mode", "play", "pause", "stop", "start", "resume", "continue", "go", "show", "find", "take",
      ...VIZ_WORDS.flatMap(([, w]) => w.flatMap((p) => p.split(" "))),
    ].filter((w) => w.length >= 4),
  ),
];

/** Levenshtein distance (small strings only). */
export function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Lower case, no punctuation, no filler, near-miss words snapped to the vocabulary. */
export function normalise(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !FILLER.has(w));
  return words
    .map((w) => {
      if (w.length < 4 || VOCAB.includes(w)) return w;
      let best = w;
      let bestD = w.length >= 7 ? 2 : 1;
      for (const v of VOCAB) {
        const dd = distance(w, v);
        if (dd <= bestD && (dd < bestD || best === w)) {
          best = v;
          bestD = dd;
        }
      }
      return best;
    })
    .join(" ");
}

const has = (t: string, re: RegExp) => re.test(t);

function findViz(t: string): VizId | null {
  for (const [id, words] of VIZ_WORDS) for (const w of words) if (new RegExp(`\\b${w}\\b`).test(t)) return id;
  return null;
}

function steps(t: string): number {
  const n = t.match(/\b(\d+)\b/);
  if (n) return Math.min(20, Math.max(1, Number(n[1])));
  for (const [w, v] of Object.entries(NUMBERS)) if (new RegExp(`\\b${w}\\b`).test(t) && w !== "a") return v;
  return /\b(far|fast|lot|big)\b/.test(t) ? 5 : 1;
}

/** One transcript -> one command. */
export function parseCommand(raw: string): Command {
  const t = normalise(raw);
  if (!t) return { kind: "unknown" };

  if (has(t, /\b(help|what can i say|commands|what do i say)\b/)) return { kind: "help" };
  if (has(t, /\b(repeat|again|say that again|what did you say)\b/)) return { kind: "repeat" };
  if (has(t, /\b(where am i|where is this|whats here|what is here|what is this|location)\b/)) return { kind: "where" };

  // "go to France", "take me to India", "show me Brazil" (a dataset name wins: "go to lightning").
  // The place comes from the raw words: near-miss correction must not turn "Niger" into "night".
  const GO = /^(?:go|take me|jump|fly|move|show me|find|show)(?: me)?(?: to| over to)? (.+)$/;
  const go = t.match(GO);
  if (go && !/\b(north|south|east|west|up|down|left|right|next|previous|back|frame)\b/.test(go[1])) {
    const id = findViz(go[1]);
    if (id) return { kind: "viz", id };
    const rawWords = raw.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().split(" ").filter((w) => !FILLER.has(w));
    const place = rawWords.join(" ").match(GO)?.[1] ?? go[1];
    return { kind: "goto", place: place.trim() };
  }

  if (has(t, /\b(stop exploring|done exploring|done|exit explore|exit|leave explore|leave|close explore|back to playback)\b/)) return { kind: "explore", on: false };
  if (has(t, /\b(resume|continue|keep playing)\b/)) return { kind: "resume" };
  if (has(t, /\b(explore|exploring|exploration)\b/)) return { kind: "explore", on: true };

  if (has(t, /\b(whole map|entire map|whole world|everything)\b/)) return { kind: "wholeMap" };
  if (has(t, /\b(point|probe|dot)\b/)) return { kind: "tool", tool: "point" };
  if (has(t, /\b(row|horizontal)\b/)) return { kind: "tool", tool: "hline" };
  if (has(t, /\b(column|vertical)\b/)) return { kind: "tool", tool: "vline" };
  if (has(t, /\b(box|area|rectangle|square)\b/)) return { kind: "tool", tool: "box" };

  if (has(t, /\b(next|forward) (frame|date|month|year|step)\b/)) return { kind: "frame", step: 1 };
  if (has(t, /\b(previous|last|back) (frame|date|month|year|step)\b/)) return { kind: "frame", step: -1 };

  const dir = t.match(/\b(north|south|east|west|up|down|left|right)\b/);
  if (dir && !has(t, /\b(turn it|volume|zoom|speed)\b/)) {
    const map: Record<string, Dir> = { north: "north", up: "north", south: "south", down: "south", east: "east", right: "east", west: "west", left: "west" };
    return { kind: "move", dir: map[dir[1]], steps: steps(t) };
  }

  if (has(t, /\b(reset zoom|zoom reset|normal size|zoom normal)\b/)) return { kind: "zoom", step: 0 };
  if (has(t, /\b(zoom in|closer|bigger|magnify|enlarge)\b/)) return { kind: "zoom", step: 1 };
  if (has(t, /\b(zoom out|further|smaller|farther)\b/)) return { kind: "zoom", step: -1 };

  if (has(t, /\b(louder|volume up|turn it up|increase volume|more volume)\b/)) return { kind: "volume", step: 1 };
  if (has(t, /\b(quieter|softer|volume down|turn it down|decrease volume|less volume|lower volume)\b/)) return { kind: "volume", step: -1 };
  if (has(t, /\b(normal speed|reset speed)\b/)) return { kind: "speed", step: 0 };
  if (has(t, /\b(faster|speed up)\b/)) return { kind: "speed", step: 1 };
  if (has(t, /\b(slower|slow down)\b/)) return { kind: "speed", step: -1 };

  if (has(t, /\b(legend|what do the sounds mean|sound key)\b/)) return { kind: "legend" };
  if (has(t, /\b(describe|descriptions?|describing)\b/)) return { kind: "describe", on: !has(t, /\b(off|stop|no)\b/) };
  if (has(t, /\b(night mode|dark mode|dark theme|night theme)\b/)) return { kind: "theme", dark: true };
  if (has(t, /\b(day mode|light mode|light theme|day theme)\b/)) return { kind: "theme", dark: false };

  if (has(t, /\b(scan|sweep|listen|play it|play that|play tool)\b/)) return { kind: "run" };

  if (t === "light") {
    return { kind: "ambiguous", options: [{ kind: "viz", id: "nightlights" }, { kind: "viz", id: "lightning" }], question: "Did you mean night lights, or lightning?" };
  }
  const id = findViz(t);
  if (id) return { kind: "viz", id };

  if (has(t, /\b(next)\b/)) return { kind: "vizStep", step: 1 };
  if (has(t, /\b(previous|back|last)\b/)) return { kind: "vizStep", step: -1 };
  if (has(t, /\b(play|start)\b/)) return { kind: "play" };
  if (has(t, /\b(pause|stop|hold|wait|quiet)\b/)) return { kind: "pause" };
  return { kind: "unknown" };
}

/** Try every alternative transcript the recognizer offers; the first one that matches wins. */
export function parseAlternatives(alternatives: string[]): { command: Command; heard: string } {
  for (const a of alternatives) {
    const c = parseCommand(a);
    if (c.kind !== "unknown") return { command: c, heard: a };
  }
  return { command: { kind: "unknown" }, heard: alternatives[0] ?? "" };
}

/** Common names people use for countries, mapped to Natural Earth's English names. */
const PLACE_ALIASES: Record<string, string> = {
  america: "United States of America",
  usa: "United States of America",
  us: "United States of America",
  "united states": "United States of America",
  states: "United States of America",
  uk: "United Kingdom",
  britain: "United Kingdom",
  "great britain": "United Kingdom",
  england: "United Kingdom",
  scotland: "United Kingdom",
  holland: "Netherlands",
  "south korea": "South Korea",
  korea: "South Korea",
  "north korea": "North Korea",
  "ivory coast": "Ivory Coast",
  czech: "Czech Republic",
  "czech republic": "Czech Republic",
  burma: "Myanmar",
  persia: "Iran",
  "sri lanka": "Sri Lanka",
  congo: "Democratic Republic of the Congo",
};

/** Fuzzy-match a spoken place to one of the known names; null if nothing is close enough. */
export function matchPlace(spoken: string, names: string[]): string | null {
  const s = spoken.toLowerCase().replace(/[^a-z ]+/g, "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  const alias = PLACE_ALIASES[s];
  const lower = names.map((n) => n.toLowerCase());
  if (alias) {
    const k = lower.indexOf(alias.toLowerCase());
    if (k >= 0) return names[k];
  }
  const exact = lower.indexOf(s);
  if (exact >= 0) return names[exact];
  const starts = lower.findIndex((n) => n.startsWith(s) || s.startsWith(n));
  if (starts >= 0 && s.length >= 4) return names[starts];
  let best: string | null = null;
  let bestD = Math.max(1, Math.floor(s.length / 4));
  lower.forEach((n, k) => {
    const d = distance(s, n);
    if (d <= bestD) {
      best = names[k];
      bestD = d;
    }
  });
  return best;
}

/** Spoken help: the commands, short. */
export const HELP_TEXT =
  "Press K, then say a command. Play, pause, next, or previous. A visualization: ocean, night lights, lightning, aerosols, or Earth. Explore, and done. Point, row, column, box, whole map, and scan. North, south, east, west, or far north. Next frame, previous frame. Zoom in, zoom out, reset zoom. Louder, quieter, faster, slower. Legend, describe, night mode, day mode. Where am I. On the Earth map, go to a country, like go to France. Repeat, and help.";
