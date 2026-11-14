/**
 * Narration facts come ONLY from templates filled with extracted numbers.
 * Nothing here invents content: an unknown/missing value makes the whole sentence drop.
 *
 *   {date}                 spoken date of the frame
 *   {path}  {path:1}       number, optional decimals
 *   {path:%}               0..1 share as a percentage
 *   {path:abs1}            absolute value, 1 decimal
 *   {path:warmer|colder}   first word if >= 0 else second
 *   {place:hotspot}        "in the western Pacific near 5° N, 150° E" (ocean data)
 *   {region:hotspot}       "over Africa near 5° N, 20° E" (land-aware)
 *   {path:trend}           "rises" / "falls" vs. the value last spoken
 *   {label} / {phase}      frame label / phase label strings
 */
import { getPath } from "@/data/interpolate";
import { placeName, regionName, spokenDate } from "@/data/geo";
import type { Frame, NarrationRule } from "@/data/types";

const TOKEN = /\{([^}]+)\}/g;

export function fillTemplate(template: string, frame: Frame, phaseLabel?: string, prev?: Record<string, number>): string | null {
  let missing = false;
  const text = template.replace(TOKEN, (_, raw: string) => {
    const [path, fmt] = raw.split(":");
    if (path === "date") return spokenDate(frame.date);
    if (path === "label") return typeof frame.label === "string" ? frame.label : ((missing = true), "");
    if (path === "phase") return phaseLabel ?? ((missing = true), "");
    if (path === "place" || path === "region") {
      const spot = frame[fmt ?? "hotspot"] as { lat?: number | null; lon?: number | null } | undefined;
      if (!spot || spot.lat == null) missing = true;
      return path === "place" ? placeName(spot?.lat, spot?.lon) : regionName(spot?.lat, spot?.lon);
    }
    const v = getPath(frame, path);
    if (v == null) {
      missing = true;
      return "";
    }
    if (!fmt) return String(Math.round(v * 10) / 10);
    if (fmt === "%") return `${Math.round(v * 100)} percent`;
    if (fmt === "trend") {
      const before = prev?.[path];
      if (before == null) return ((missing = true), "");
      return v >= before ? "rises" : "falls";
    }
    if (fmt.includes("|")) {
      const [pos, neg] = fmt.split("|");
      return v >= 0 ? pos : neg;
    }
    const abs = fmt.startsWith("abs");
    const dec = Number(abs ? fmt.slice(3) || "0" : fmt);
    return (abs ? Math.abs(v) : v).toFixed(Number.isFinite(dec) ? dec : 1);
  });
  return missing ? null : text.replace(/\s+/g, " ").trim();
}

/**
 * Decides what to say. Speaks only when something meaningful changed:
 * a feature moved by >= minDelta since it was last spoken, or a new phase started.
 */
export class NarrationPlanner {
  private lastSpoken = new Map<number, number>();
  private lastPhase: string | undefined;
  private startedSaid = false;
  private lastAt = -Infinity;

  constructor(
    private rules: NarrationRule[],
    private minGapSec = 7,
  ) {}

  reset(): void {
    this.lastSpoken.clear();
    this.lastPhase = undefined;
    this.startedSaid = false;
    this.lastAt = -Infinity;
  }

  /** Returns a sentence to speak now, or null. `now` = wall-clock seconds. */
  next(frame: Frame, now: number, phaseLabel?: string): string | null {
    if (!this.startedSaid) {
      const start = this.rules.find((r) => r.atStart);
      this.startedSaid = true;
      this.rules.forEach((r, i) => r.feature && this.remember(i, frame, r.feature));
      this.lastPhase = frame.phase;
      if (start) {
        this.lastAt = now;
        return fillTemplate(start.template, frame, phaseLabel);
      }
    }
    if (now - this.lastAt < this.minGapSec) return null;

    if (frame.phase && frame.phase !== this.lastPhase) {
      this.lastPhase = frame.phase;
      const rule = this.rules.find((r) => r.phase === frame.phase);
      if (rule) {
        const s = fillTemplate(rule.template, frame, phaseLabel);
        if (s) {
          this.lastAt = now;
          return s;
        }
      }
    }

    for (let i = 0; i < this.rules.length; i++) {
      const r = this.rules[i];
      if (!r.feature || r.minDelta == null) continue;
      const v = getPath(frame, r.feature);
      const last = this.lastSpoken.get(i);
      if (v == null) continue;
      if (last == null) {
        this.lastSpoken.set(i, v); // feature just appeared: start tracking, don't speak
        continue;
      }
      if (Math.abs(v - last) >= r.minDelta) {
        const s = fillTemplate(r.template, frame, phaseLabel, { [r.feature]: last });
        this.lastSpoken.set(i, v);
        if (s) {
          this.lastAt = now;
          return s;
        }
      }
    }
    return null;
  }

  private remember(i: number, frame: Frame, feature: string): void {
    const v = getPath(frame, feature);
    if (v != null) this.lastSpoken.set(i, v);
  }
}

/** Full text transcript: every fact the planner would say over one pass, with times. */
export function transcript(rules: NarrationRule[], frames: Frame[], phaseLabel: (f: Frame) => string | undefined): { t: number; text: string }[] {
  const planner = new NarrationPlanner(rules, 0);
  const out: { t: number; text: string }[] = [];
  for (const f of frames) {
    const s = planner.next(f, f.t, phaseLabel(f));
    if (s) out.push({ t: f.t, text: s });
  }
  return out;
}
