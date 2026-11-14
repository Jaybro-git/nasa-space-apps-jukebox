"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { Dataset, Frame } from "@/data/types";
import { gridValue } from "@/data/load";
import { cellLatLon, formatLat, formatLon, spokenDate, spokenLatLon } from "@/data/geo";
import type { SoundEngine } from "@/audio/engine";
import { TOOLS, boxScan, boxStats, lineSamples, normRect, normalise, rectAround, type Rect, type Tool } from "@/audio/explore";
import { pulse } from "@/a11y/haptics";
import { terrainSound, terrainWords, type ScapeParams } from "@/audio/soundscape";
import { Globe, ZOOM_MAX, ZOOM_MIN, type LatLon, type Overlay } from "./Globe";

export type View = "globe" | "flat";

interface Props {
  ds: Dataset;
  view: View;
  frameIdx: number;
  phase?: string;
  exploring: boolean;
  setExploring: (v: boolean) => void;
  tool: Tool;
  setTool: (t: Tool) => void;
  playing: boolean;
  engine: SoundEngine;
  ensureAudio: () => Promise<void>;
  hapticsOn: boolean;
  announce: (s: string) => void;
  stepFrame: (d: number) => Frame | undefined;
  video: HTMLVideoElement | null;
  onVideo: (v: HTMLVideoElement | null) => void;
  onMeridian: (lon: number) => void;
  zoom: number;
  setZoom: (z: number) => void;
  theme: "light" | "dark";
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

function where(ds: Dataset, i: number, j: number): string {
  const { w, h } = ds.meta.grid;
  if (ds.meta.projection === "equirectangular") {
    const { lat, lon } = cellLatLon(i, j, w, h);
    return spokenLatLon(lat, lon);
  }
  const col = ["far west", "west", "centre-west", "centre", "centre-east", "east", "far east"][Math.min(6, Math.floor((i / w) * 7))];
  const row = ["top", "upper middle", "middle", "lower middle", "bottom"][Math.min(4, Math.floor((j / h) * 5))];
  return `${col}, ${row} of the map`;
}

/** Spoken value of a cell in real units ("27.4 °C", "brighter, strength 40 of 100", "France"). */
function valueText(ds: Dataset, v: number | null, phase: string | undefined, ll: LatLon | null): string {
  if (ds.atlas && ll) {
    const r = ds.atlas.regionAt(ll.lat, ll.lon);
    if (ds.atlas.landMap) return r ?? (v == null || v < 0.5 ? "ocean" : "land");
    if (v == null) return ds.rules.explore.noData;
    return `${r ?? ds.rules.explore.noData}, ${v.toFixed(ds.rules.explore.decimals)} ${ds.rules.explore.valueLabel}`.trim();
  }
  const ex = ds.rules.explore;
  const fmt = phase ? ex.format?.[phase] : undefined;
  if (v == null) return ex.noData;
  if (fmt)
    return fmt
      .replace("{v}", v.toFixed(ex.decimals))
      .replace("{abs}", Math.abs(v).toFixed(ex.decimals))
      .replace("{dir}", v > 2 ? "brighter" : v < -2 ? "darker" : "no change");
  return `${v.toFixed(ex.decimals)} ${ex.valueLabel}`.trim();
}

/**
 * The visualization. The <video> is the single source of time; in globe view it is hidden
 * and used as the sphere's texture. Explore freezes the current frame and offers four tools
 * (Point, Row, Column, Box), by keyboard and by pointer, in both views.
 */
export function Stage(p: Props) {
  const { ds, view, frameIdx, phase, exploring, tool, engine, ensureAudio, hapticsOn, announce } = p;
  const { w, h, min, max } = ds.meta.grid;
  const geo = ds.meta.projection === "equirectangular";
  const [probe, setProbe] = useState({ i: Math.floor(w / 2), j: Math.floor(h / 2) });
  const [rect, setRect] = useState<Rect>(() => rectAround(Math.floor(w / 2), Math.floor(h / 2), 4, 3, w, h));
  const [follow, setFollow] = useState(true);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const announceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sweepRaf = useRef(0);
  const anchor = useRef<{ i: number; j: number } | null>(null);
  const lastCountry = useRef<string | null>(null);
  const [clouds, setClouds] = useState(true);

  // new dataset: reset probe and box to the centre of its grid
  useEffect(() => {
    setProbe({ i: Math.floor(w / 2), j: Math.floor(h / 2) });
    setRect(rectAround(Math.floor(w / 2), Math.floor(h / 2), Math.round(w / 18), Math.round(h / 12), w, h));
  }, [ds.meta.id, w, h]);

  const unit = useCallback((v: number | null) => (v == null ? null : normalise(v, min, max)), [min, max]);
  const raw = useCallback((i: number, j: number) => gridValue(ds, frameIdx, i, j), [ds, frameIdx]);
  const norm = useCallback((i: number, j: number) => unit(gridValue(ds, frameIdx, i, j)), [ds, frameIdx, unit]);
  const llOf = useCallback((i: number, j: number) => (geo ? cellLatLon(i, j, w, h) : null), [geo, w, h]);

  const say = useCallback(
    (text: string, delay = 180) => {
      if (announceTimer.current) clearTimeout(announceTimer.current);
      announceTimer.current = setTimeout(() => announce(text), delay);
    },
    [announce],
  );

  /** Point tool: glide to the value under the probe and say where we are. */
  const readCell = useCallback(
    async (i: number, j: number, speak: boolean | "accent" = true, exact?: LatLon) => {
      await ensureAudio();
      const v = raw(i, j);
      const u = unit(v);
      const ll = exact ?? llOf(i, j);
      const terrain = ds.atlas?.terrainAt && ll ? ds.atlas.terrainAt(ll.lat, ll.lon) : null;
      if (terrain) engine.scapeAt(terrainSound(terrain), (i + 0.5) / w);
      else engine.exploreAt(u, (i + 0.5) / w, speak === "accent");
      if (hapticsOn && u != null) pulse(u);
      if (ds.atlas && ll) {
        // still map: a soft tick when crossing into another region, its name after a short pause
        const c = ds.atlas.regionAt(ll.lat, ll.lon);
        if (c !== lastCountry.current) {
          if (lastCountry.current && c) engine.tickNow(false);
          lastCountry.current = c;
          if (c) say(c, 300);
        }
        if (speak === "accent") say(`${valueText(ds, v, phase, ll)}. ${terrain ? `${terrainWords(terrain)}. ` : ""}${spokenLatLon(ll.lat, ll.lon)}`, 0);
        return;
      }
      if (!speak) return;
      say(`${where(ds, i, j)}: ${valueText(ds, v, phase, ll)}`);
    },
    [ds, phase, engine, ensureAudio, hapticsOn, unit, raw, llOf, w, say],
  );

  // the frozen frame changed under a resting probe ([ / ]): glide to the new value
  useEffect(() => {
    if (exploring && tool === "point") void readCell(probe.i, probe.j, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameIdx]);

  useEffect(() => {
    if (!exploring) {
      cancelAnimationFrame(sweepRaf.current);
      setPlayhead(null);
      engine.explore(false);
      lastCountry.current = null;
    }
  }, [exploring, engine]);

  const animatePlayhead = (seconds: number) => {
    cancelAnimationFrame(sweepRaf.current);
    if (!seconds) return;
    const t0 = performance.now() + 80;
    const step = () => {
      const u = (performance.now() - t0) / (seconds * 1000);
      if (u >= 1) return setPlayhead(null);
      setPlayhead(Math.max(0, u));
      sweepRaf.current = requestAnimationFrame(step);
    };
    sweepRaf.current = requestAnimationFrame(step);
  };

  const sweepLine = useCallback(
    async (axis: "row" | "col", at = probe) => {
      await ensureAudio();
      const samples = lineSamples(norm, w, h, axis, axis === "row" ? at.j : at.i);
      const tAt = ds.atlas?.terrainAt;
      let seconds: number;
      if (tAt && geo) {
        // Earth: the soundscape walks along the line (every 8th cell, plus every gridline)
        const steps = samples
          .map((smp, k) => ({ smp, k }))
          .filter(({ smp, k }) => k % 8 === 0 || smp.tick)
          .map(({ smp, k }) => {
            const ll = axis === "row" ? cellLatLon(k, at.j, w, h) : cellLatLon(at.i, k, w, h);
            return { t: smp.t, p: terrainSound(tAt(ll.lat, ll.lon)), pan: smp.pan, tick: smp.tick };
          });
        seconds = engine.playScape(steps, 8);
      } else seconds = engine.playLine(samples, 6);
      animatePlayhead(seconds); // no speech here: it would mask the sweep
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, ensureAudio, norm, w, h, probe],
  );

  const boxSummary = useCallback(
    (r: Rect): string => {
      const a = llOf(r.i0, r.j0);
      const b = llOf(r.i1, r.j1);
      const area = a && b ? `Box ${formatLat(a.lat)} to ${formatLat(b.lat)}, ${formatLon(a.lon)} to ${formatLon(b.lon)}` : "Box";
      if (ds.atlas?.landMap && a && b) {
        const names = new Set<string>();
        let land = 0;
        let cells = 0;
        for (let j = r.j0; j <= r.j1; j++)
          for (let i = r.i0; i <= r.i1; i++) {
            cells++;
            const ll = llOf(i, j)!;
            const c = ds.atlas.regionAt(ll.lat, ll.lon);
            if (c) names.add(c);
            if ((raw(i, j) ?? 0) >= 0.5) land++;
          }
        const list = [...names].slice(0, 6);
        let terr = "";
        const tAt = ds.atlas.terrainAt;
        if (tAt) {
          let hi: { e: number; ll: LatLon } | null = null;
          let lo: { e: number; ll: LatLon } | null = null;
          let iceCells = 0;
          for (let j = r.j0; j <= r.j1; j++)
            for (let i = r.i0; i <= r.i1; i++) {
              const ll = llOf(i, j)!;
              const t = tAt(ll.lat, ll.lon);
              if (!hi || t.elev > hi.e) hi = { e: t.elev, ll };
              if (!lo || t.elev < lo.e) lo = { e: t.elev, ll };
              if (t.ice) iceCells++;
            }
          if (hi && hi.e > 0) terr += ` Highest about ${Math.round(hi.e / 10) * 10} metres, near ${formatLat(hi.ll.lat)}, ${formatLon(hi.ll.lon)}.`;
          if (lo && lo.e < 0) terr += ` Deepest about ${Math.round(-lo.e / 10) * 10} metres.`;
          if (iceCells) terr += ` ${Math.round((100 * iceCells) / cells)} percent ice.`;
        }
        return `${area}: ${Math.round((100 * land) / cells)} percent land.${terr}${list.length ? ` Countries: ${list.join(", ")}${names.size > list.length ? `, and ${names.size - list.length} more` : ""}.` : ""}`;
      }
      const st = boxStats(raw, r);
      if (st.mean == null || st.max == null || !st.maxAt) return `${area}: ${ds.rules.explore.noData} everywhere.`;
      const ex = ds.rules.explore;
      const fmt = (v: number) => `${v.toFixed(ex.decimals)} ${ex.valueLabel}`.trim();
      const top = llOf(st.maxAt.i, st.maxAt.j);
      const cover = st.dataCells < st.cells ? ` Data in ${Math.round((100 * st.dataCells) / st.cells)} percent of the box.` : "";
      let kinds = "";
      if (ds.atlas && a && b) {
        // still maps with regions (aerosol types): which ones dominate the box
        const count = new Map<string, number>();
        for (let j = r.j0; j <= r.j1; j++)
          for (let i = r.i0; i <= r.i1; i++) {
            if (raw(i, j) == null) continue;
            const ll = llOf(i, j)!;
            const k = ds.atlas.regionAt(ll.lat, ll.lon);
            if (k) count.set(k, (count.get(k) ?? 0) + 1);
          }
        const top2 = [...count.entries()].sort((x, y) => y[1] - x[1]).slice(0, 2).map(([k]) => k.toLowerCase());
        if (top2.length) kinds = ` Mostly ${top2.join(", then ")}.`;
      }
      return `${area}: average ${fmt(st.mean)}, highest ${fmt(st.max)}${top ? ` near ${formatLat(top.lat)}, ${formatLon(top.lon)}` : ""}.${kinds}${cover}`;
    },
    [ds, raw, llOf],
  );

  const scanBox = useCallback(
    async (r: Rect) => {
      await ensureAudio();
      const wide = r.i1 - r.i0 + 1 > 40;
      const tAt = ds.atlas?.terrainAt;
      let seconds: number;
      if (tAt && geo) {
        // Earth: walk the soundscape west -> east through the box, one step per column group
        const cols = r.i1 - r.i0 + 1;
        const n = Math.min(40, cols);
        const steps: { t: number; p: ScapeParams; pan: number }[] = [];
        for (let c = 0; c < n; c++) {
          const i = r.i0 + Math.floor(((c + 0.5) * cols) / n);
          let elev = 0;
          let ice = 0;
          let k = 0;
          for (let j = r.j0; j <= r.j1; j++) {
            const ll = cellLatLon(i, j, w, h);
            const t = tAt(ll.lat, ll.lon);
            elev += t.elev;
            ice += t.ice ? 1 : 0;
            k++;
          }
          steps.push({ t: n > 1 ? c / (n - 1) : 0, p: terrainSound({ elev: elev / k, ice: ice > k / 2 }), pan: ((i + 0.5) / w) * 2 - 1 });
        }
        seconds = engine.playScape(steps, wide ? 12 : 6);
      } else seconds = engine.playBox(boxScan(norm, r, w), wide ? 12 : 5);
      animatePlayhead(seconds);
      const text = boxSummary(r);
      setTimeout(() => announce(text), seconds * 1000 + 250);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, ensureAudio, norm, w, boxSummary, announce],
  );

  /** Run the current tool at the probe (Enter / click). */
  const run = (at = probe) => {
    if (tool === "point") void readCell(at.i, at.j, "accent");
    else if (tool === "hline") void sweepLine("row", at);
    else if (tool === "vline") void sweepLine("col", at);
    else void scanBox(rect);
  };

  // ---- flat view overlay: probe, line, box, playhead ----
  useEffect(() => {
    const c = canvas.current;
    if (!c || view !== "flat") return;
    const ctx = c.getContext("2d")!;
    const r = c.getBoundingClientRect();
    c.width = Math.round((r.width / (p.zoom || 1)) * devicePixelRatio);
    c.height = Math.round((r.height / (p.zoom || 1)) * devicePixelRatio);
    ctx.clearRect(0, 0, c.width, c.height);
    if (!exploring) return;
    const cw = c.width / w;
    const ch = c.height / h;
    const dpr = devicePixelRatio;
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = "#e85d04";
    if (tool === "hline") {
      ctx.beginPath();
      ctx.moveTo(0, (probe.j + 0.5) * ch);
      ctx.lineTo(c.width, (probe.j + 0.5) * ch);
      ctx.stroke();
    } else if (tool === "vline") {
      ctx.beginPath();
      ctx.moveTo((probe.i + 0.5) * cw, 0);
      ctx.lineTo((probe.i + 0.5) * cw, c.height);
      ctx.stroke();
    } else if (tool === "box") {
      ctx.lineWidth = 3 * dpr;
      ctx.strokeRect(rect.i0 * cw, rect.j0 * ch, (rect.i1 - rect.i0 + 1) * cw, (rect.j1 - rect.j0 + 1) * ch);
    } else {
      ctx.strokeStyle = "rgba(255,255,255,0.45)";
      ctx.beginPath();
      ctx.moveTo((probe.i + 0.5) * cw, 0);
      ctx.lineTo((probe.i + 0.5) * cw, c.height);
      ctx.moveTo(0, (probe.j + 0.5) * ch);
      ctx.lineTo(c.width, (probe.j + 0.5) * ch);
      ctx.stroke();
      ctx.strokeStyle = "#e85d04";
      ctx.lineWidth = 3 * dpr;
      ctx.strokeRect(probe.i * cw, probe.j * ch, cw, ch);
    }
    if (playhead != null) {
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      if (tool === "hline") ctx.arc(playhead * c.width, (probe.j + 0.5) * ch, 6 * dpr, 0, 6.283);
      else if (tool === "vline") ctx.arc((probe.i + 0.5) * cw, playhead * c.height, 6 * dpr, 0, 6.283);
      else if (tool === "box") {
        const x = (rect.i0 + playhead * (rect.i1 - rect.i0 + 1)) * cw;
        ctx.moveTo(x, rect.j0 * ch);
        ctx.lineTo(x, (rect.j1 + 1) * ch);
        ctx.stroke();
      }
      ctx.fill();
    }
  }, [probe, rect, tool, exploring, playhead, w, h, view, p.zoom]);

  // ---- keyboard ----
  const onKey = (e: KeyboardEvent) => {
    if (!exploring) return;
    const k = e.key;
    if (k === "Escape") {
      e.preventDefault();
      p.setExploring(false);
      return;
    }
    const t = TOOLS.find((x) => x.key === k);
    if (t) {
      e.preventDefault();
      p.setTool(t.id);
      if (t.id === "box") setRect(rectAround(probe.i, probe.j, Math.max(1, (rect.i1 - rect.i0) >> 1), Math.max(1, (rect.j1 - rect.j0) >> 1), w, h));
      announce(`${t.label} tool. ${t.help} Press Enter to play.`);
      return;
    }
    if (k === "[" || k === "]") {
      e.preventDefault();
      const f = p.stepFrame(k === "]" ? 1 : -1);
      if (f) announce(`Frame: ${f.label ?? (f.date ? spokenDate(f.date) : `${Math.round(f.t)} seconds into the clip`)}`);
      return;
    }
    if ((k === "a" || k === "A") && tool === "box") {
      e.preventDefault();
      setRect({ i0: 0, j0: 0, i1: w - 1, j1: h - 1 });
      setProbe({ i: w >> 1, j: h >> 1 });
      announce("Whole map selected. Press Enter to scan it from west to east.");
      return;
    }
    if (k === "Enter" || k === " ") {
      e.preventDefault();
      run();
      return;
    }
    if (k === "r" || k === "R" || k === "c" || k === "C") {
      e.preventDefault();
      void sweepLine(k.toLowerCase() === "r" ? "row" : "col");
      return;
    }
    if (k === "+" || k === "=" || k === "-" || k === "_" || k === "0") {
      e.preventDefault();
      const z = k === "0" ? 1 : clamp(p.zoom * (k === "-" || k === "_" ? 1 / 1.5 : 1.5), ZOOM_MIN, ZOOM_MAX);
      p.setZoom(z);
      announce(`Zoom ${Math.round(z * 10) / 10} times`);
      return;
    }
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const d = arrows[k];
    if (!d) return;
    e.preventDefault();
    if (tool === "box") {
      let r = { ...rect };
      if (e.shiftKey) {
        // Shift+arrows resize: right/down grow, left/up shrink
        r.i1 = Math.max(r.i0, r.i1 + d[0]);
        r.j1 = Math.max(r.j0, r.j1 + d[1]);
      } else r = { i0: r.i0 + d[0], i1: r.i1 + d[0], j0: r.j0 + d[1], j1: r.j1 + d[1] };
      if (r.i0 < 0 || r.j0 < 0 || r.i1 >= w || r.j1 >= h) return;
      setRect(r);
      const c = { i: (r.i0 + r.i1) >> 1, j: (r.j0 + r.j1) >> 1 };
      setProbe(c);
      setFollow(true);
      const a = llOf(r.i0, r.j0);
      const b = llOf(r.i1, r.j1);
      say(a && b ? `Box ${formatLat(a.lat)} to ${formatLat(b.lat)}, ${formatLon(a.lon)} to ${formatLon(b.lon)}` : `Box ${r.i1 - r.i0 + 1} by ${r.j1 - r.j0 + 1} cells`);
      return;
    }
    const step = e.shiftKey ? 5 : 1;
    const i = (probe.i + d[0] * step + w) % w;
    const j = clamp(probe.j + d[1] * step, 0, h - 1);
    setProbe({ i, j });
    setFollow(true);
    if (tool === "point") void readCell(i, j);
    else {
      const ll = llOf(i, j);
      void readCell(i, j, false);
      if (ll) say(tool === "hline" ? `Row at ${formatLat(ll.lat)}` : `Column at ${formatLon(ll.lon)}`);
    }
  };

  // ---- pointer: hover = point probe, click = run tool, drag = draw box ----
  const cellFromLL = useCallback((ll: LatLon) => ({ i: clamp(Math.floor(((ll.lon + 180) / 360) * w), 0, w - 1), j: clamp(Math.floor(((90 - ll.lat) / 180) * h), 0, h - 1) }), [w, h]);

  const onCell = (c: { i: number; j: number }, kind: "move" | "down" | "up", buttons: number, exact?: LatLon) => {
    if (!exploring) return;
    setFollow(false);
    if (tool === "box") {
      if (kind === "down") anchor.current = c;
      if (anchor.current && (buttons || kind === "up")) {
        const r = normRect({ i0: anchor.current.i, j0: anchor.current.j, i1: c.i, j1: c.j }, w, h);
        setRect(r);
        setProbe({ i: (r.i0 + r.i1) >> 1, j: (r.j0 + r.j1) >> 1 });
        if (kind === "up") {
          anchor.current = null;
          void scanBox(r);
        }
      }
      return;
    }
    if (c.i !== probe.i || c.j !== probe.j) {
      setProbe(c);
      if (tool === "point" || !engine.sweeping) void readCell(c.i, c.j, tool === "point" && kind !== "move", exact);
    } else if (ds.atlas && exact) void readCell(c.i, c.j, false, exact);
    if (kind === "down" && tool !== "point") run(c);
  };

  const onFlatPointer = (e: PointerEvent<HTMLDivElement>, kind: "move" | "down" | "up") => {
    if (!exploring || view !== "flat") return;
    const r = (inner.current ?? e.currentTarget).getBoundingClientRect();
    const u = (e.clientX - r.left) / r.width;
    const v = (e.clientY - r.top) / r.height;
    if (u < 0 || u > 1 || v < 0 || v > 1) return;
    const c = { i: clamp(Math.floor(u * w), 0, w - 1), j: clamp(Math.floor(v * h), 0, h - 1) };
    onCell(c, kind, e.buttons, geo ? { lat: 90 - v * 180, lon: -180 + u * 360 } : undefined);
  };

  const onWheel = (e: React.WheelEvent) => {
    if (view !== "flat") return;
    p.setZoom(clamp(p.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), ZOOM_MIN, ZOOM_MAX));
  };

  const probeLL = exploring && geo ? cellLatLon(probe.i, probe.j, w, h) : null;
  const overlay = useMemo<Overlay | null>(() => {
    if (!exploring || !geo) return null;
    if (tool === "hline") return { kind: "hline", lat: cellLatLon(0, probe.j, w, h).lat };
    if (tool === "vline") return { kind: "vline", lon: cellLatLon(probe.i, 0, w, h).lon };
    if (tool === "box") {
      const a = cellLatLon(rect.i0, rect.j0, w, h);
      const b = cellLatLon(rect.i1, rect.j1, w, h);
      const hw = 180 / w;
      const hh = 90 / h;
      return { kind: "box", lat0: a.lat + hh, lat1: b.lat - hh, lon0: a.lon - hw, lon1: b.lon + hw };
    }
    return null;
  }, [exploring, geo, tool, probe, rect, w, h]);

  const flat = view === "flat";
  const hasVideo = !ds.atlas;
  const origin = exploring ? `${((probe.i + 0.5) / w) * 100}% ${((probe.j + 0.5) / h) * 100}%` : "50% 50%";
  const toolDef = TOOLS.find((t) => t.id === tool)!;

  return (
    <div
      className={`stage ${flat ? "stage-flat" : "stage-globe"} ${exploring ? "is-exploring" : ""}`}
      style={flat ? { aspectRatio: `${ds.meta.video.width} / ${ds.meta.video.height}` } : undefined}
      tabIndex={exploring ? 0 : -1}
      role={exploring ? "application" : undefined}
      aria-roledescription={exploring ? "explorable map" : undefined}
      aria-label={
        exploring
          ? `${ds.meta.title}, paused for exploring. ${toolDef.label} tool. Keys 1 to 4 change tool: Point, Row, Column, Box. Arrow keys move, Shift moves faster${tool === "box" ? " and resizes the box" : ""}. Enter plays. Left and right square brackets step through frames. Plus and minus zoom. Escape leaves Explore.`
          : undefined
      }
      onKeyDown={onKey}
      onPointerDown={(e) => onFlatPointer(e, "down")}
      onPointerMove={(e) => onFlatPointer(e, "move")}
      onPointerUp={(e) => onFlatPointer(e, "up")}
      onWheel={onWheel}
    >
      <div ref={inner} className="stage-inner" style={flat ? { transform: `scale(${p.zoom})`, transformOrigin: origin } : undefined}>
        {hasVideo ? (
          <video
            key={ds.meta.id}
            ref={p.onVideo}
            className="stage-video"
            src={ds.meta.video.src}
            poster={ds.meta.video.poster}
            muted
            loop
            playsInline
            crossOrigin="anonymous"
            preload="auto"
            aria-hidden="true"
            tabIndex={-1}
          />
        ) : (
          flat && ds.atlas && <img className="stage-video" src={ds.atlas.image} alt="" aria-hidden="true" />
        )}
        {flat && <canvas ref={canvas} className="stage-overlay" aria-hidden="true" />}
      </div>
      {!flat && (
        <Globe
          video={hasVideo ? p.video : null}
          image={ds.atlas?.image ?? null}
          imageHi={ds.atlas?.imageHi ?? null}
          borders={ds.atlas?.borders ?? null}
          labels={ds.atlas?.labels ?? null}
          clouds={ds.atlas?.landMap && clouds ? "/clouds/clouds.jpg" : null}
          playing={p.playing}
          probe={probeLL}
          follow={follow}
          overlay={overlay}
          playhead={playhead}
          zoom={p.zoom}
          onZoom={p.setZoom}
          lockDrag={exploring && tool === "box"}
          onPick={(ll, kind) => onCell(cellFromLL(ll), kind, kind === "move" ? (anchor.current ? 1 : 0) : 1, ll)}
          onMeridian={p.onMeridian}
          theme={p.theme}
          label={`Globe showing ${ds.meta.title}. Drag to turn it, scroll or pinch to zoom. Use Explore to hear values.`}
        />
      )}
      {!flat && ds.atlas?.landMap && (
        <button type="button" className="pill-btn clouds-btn" aria-pressed={clouds} onClick={() => setClouds((c) => !c)} title="Real clouds from NASA MODIS, 15 July 2024">
          Clouds
        </button>
      )}
      {exploring && (
        <span className="stage-hint" aria-hidden="true">
          {toolDef.label} · arrows move · Enter play{hasVideo ? " · [ ] frame · Esc exit" : tool === "box" ? " · A whole map" : ""}
        </span>
      )}
    </div>
  );
}
