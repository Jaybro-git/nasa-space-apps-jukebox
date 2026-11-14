import { getPath } from "./interpolate";
import type { Frame, Readout } from "./types";

export function formatValue(v: number | null, opts: { decimals?: number; unit?: string; format?: "percent" }): string {
  if (v == null) return "—";
  if (opts.format === "percent") return `${Math.round(v * 100)}%`;
  const s = v.toFixed(opts.decimals ?? 1);
  return opts.unit ? `${s}${opts.unit === "%" || opts.unit === "°" ? "" : " "}${opts.unit}` : s;
}

export const readoutValue = (r: Readout, frame: Frame | undefined) => formatValue(getPath(frame, r.feature), r);

export const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
