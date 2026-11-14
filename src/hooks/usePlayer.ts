"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SoundEngine, type Controls, type LayerId, type SoundStyle } from "@/audio/engine";
import { NEUTRAL, evaluate, resolveMappings } from "@/audio/rules";
import { MOODS, moodById, type Mood } from "@/audio/moods";
import { buildScore } from "@/audio/score";
import { loadManifest, renderStems } from "@/audio/render";
import { noteName, valueToMidi } from "@/audio/scale";
import { frameIndexAt } from "@/data/interpolate";
import type { Dataset, Frame, Target } from "@/data/types";
import { NarrationPlanner } from "@/narration/template";

let sharedEngine: SoundEngine | null = null;
export const getEngine = () => {
  sharedEngine ??= new SoundEngine();
  if (typeof window !== "undefined") (window as unknown as { __jukebox?: SoundEngine }).__jukebox = sharedEngine;
  return sharedEngine;
};

export interface LayerState {
  mute: boolean;
  solo: boolean;
  volume: number;
}

const TICK_MS = 100;
const UI_MS = 250;
const LAYER_IDS: LayerId[] = ["bed", "lead", "guide", "change", "events", "ticks", "explore"];

function eventSizeRange(ds: Dataset): [number, number] {
  const r = ds.rules.events?.sizeRange;
  if (r && r !== "auto") return r;
  let lo = Infinity;
  let hi = -Infinity;
  for (const f of ds.features.frames)
    for (const e of f.events ?? []) {
      lo = Math.min(lo, e.size);
      hi = Math.max(hi, e.size);
    }
  return Number.isFinite(lo) ? [lo, Math.max(lo + 1, hi)] : [1, 2];
}

/**
 * Glue: data -> score -> offline-rendered stems (cached) -> playback synced to the video.
 * The live engine only plays buffers + the pad + Explore, so the audio stays clean.
 */
export function usePlayer(ds: Dataset | null, video: HTMLVideoElement | null, onAnnounce: (s: string) => void) {
  const engine = getEngine();
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [mood, setMoodState] = useState<Mood>(MOODS[0]);
  const [controls, setControlsState] = useState<Controls>(engine.controls);
  const [style, setStyleState] = useState<SoundStyle>("calm");
  const [volume, setVolumeState] = useState(0.8);
  const [ad, setAd] = useState(false);
  const [hapticsOn, setHapticsOn] = useState(true);
  const [legendStep, setLegendStep] = useState<number | null>(null);
  const [caption, setCaption] = useState("");
  const [log, setLog] = useState<{ id: number; tag: string; text: string }[]>([]);
  const [targets, setTargets] = useState<Record<Target, number>>({ ...NEUTRAL });
  const [pressing, setPressing] = useState<string>("");
  const [audioState, setAudioState] = useState("not started");
  const [outputDb, setOutputDb] = useState(-Infinity);
  const logId = useRef(0);
  const [layers, setLayers] = useState<Record<LayerId, LayerState>>(
    () => Object.fromEntries(LAYER_IDS.map((l) => [l, { mute: false, solo: false, volume: 0 }])) as Record<LayerId, LayerState>,
  );

  const legendRunning = useRef(false);
  const lastFrame = useRef(-1);
  const resumeAfterFreeze = useRef(false);
  const pendingStems = useRef<{ stems: Awaited<ReturnType<typeof renderStems>>; duration: number } | null>(null);
  const planner = useMemo(() => (ds ? new NarrationPlanner(ds.rules.narration, 6) : null), [ds]);
  const mappings = useMemo(() => (ds ? resolveMappings(ds.rules, ds.features.frames) : []), [ds]);
  const prefs = useRef({ ad, style, volume });
  prefs.current = { ad, style, volume };
  const hasVideo = !!ds && !ds.meta.still;

  const phaseLabel = useCallback((f: Frame | undefined) => ds?.meta.phases?.find((p) => p.id === f?.phase)?.label, [ds]);

  const describe = useCallback(
    (text: string, tag: string) => {
      setCaption(text);
      setLog((l) => [{ id: ++logId.current, tag, text }, ...l].slice(0, 60));
      if (prefs.current.ad) onAnnounce(text);
    },
    [onAnnounce],
  );

  useEffect(() => {
    void loadManifest();
  }, []);

  // ---- press (render) the soundtrack whenever data / mood / sound settings change ----
  const scoreKey = ds && hasVideo ? `${ds.meta.id}|${mood.id}|${controls.pitchOct}|${controls.panWidth}|${controls.lead}` : "";
  useEffect(() => {
    if (!ds || !hasVideo) return;
    let live = true;
    const timer = setTimeout(async () => {
      const manifest = await loadManifest();
      const score = buildScore(ds.features.frames, mappings, ds.meta.video.duration, { key: mood.key, ...controls }, ds.rules.events, eventSizeRange(ds));
      setPressing("Preparing the sound… 0%");
      const stems = await renderStems(scoreKey, score, manifest, (d, n) => live && setPressing(`Preparing the sound… ${Math.round((100 * d) / n)}%`));
      if (!live) return;
      setPressing("");
      if (engine.ready) engine.setStems(stems, ds.meta.video.duration);
      else pendingStems.current = { stems, duration: ds.meta.video.duration };
    }, 350);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoreKey]);

  // ---- new visualization ----
  useEffect(() => {
    lastFrame.current = -1;
    planner?.reset();
    setCaption("");
    setTime(0);
    if (ds) setLog((l) => [{ id: ++logId.current, tag: "◉", text: `${ds.meta.title} selected.` }, ...l].slice(0, 60));
  }, [ds, planner]);

  // ---- sync loop: keep the soundtrack on the video clock; narration; light UI updates ----
  useEffect(() => {
    if (!ds || !video || !hasVideo) return;
    const frames = ds.features.frames;
    let lastUi = 0;
    let strikes = 0;
    const id = setInterval(() => {
      const t = video.currentTime;
      const i = Math.max(0, frameIndexAt(frames, t));
      if (engine.playing && !video.paused && engine.hasStems) {
        const d = ds.meta.video.duration;
        let drift = Math.abs(engine.position() - t);
        drift = Math.min(drift, d - drift);
        // video clocks wobble: only correct real drift (> 0.6 s, three checks in a row)
        strikes = drift > 0.6 ? strikes + 1 : 0;
        if (strikes >= 3) {
          engine.seek(t);
          strikes = 0;
        }
      }
      const now = performance.now();
      if (now - lastUi > UI_MS) {
        lastUi = now;
        setTime(t);
        setTargets(evaluate(mappings, frames, t).values);
        setAudioState(engine.contextState);
        setOutputDb(engine.outputDb);
      }
      if (i !== lastFrame.current && !video.paused && planner) {
        lastFrame.current = i;
        const f = frames[i];
        const s = planner.next(f, now / 1000, phaseLabel(f));
        if (s) describe(s, f.label ?? (f.date ? f.date.slice(0, 7) : `${Math.floor(t)} s`));
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [ds, video, hasVideo, engine, mappings, planner, phaseLabel, describe]);

  // video events -> soundtrack
  useEffect(() => {
    if (!video) return;
    if (engine.playing && video.paused) void video.play().catch(() => {});
    const onSeeked = () => {
      setTime(video.currentTime);
      if (Math.abs(engine.position() - video.currentTime) > 0.3) engine.seek(video.currentTime);
    };
    video.addEventListener("seeked", onSeeked);
    return () => video.removeEventListener("seeked", onSeeked);
  }, [video, engine]);

  const ensureAudio = useCallback(async () => {
    if (!engine.ready) {
      await engine.init(loadManifest()); // AudioContext is created synchronously in here
      Object.entries(layers).forEach(([lid, s]) => engine.setLayer(lid as LayerId, s));
      engine.setStyle(prefs.current.style);
      engine.setVolume(prefs.current.volume);
      if (pendingStems.current) {
        engine.setStems(pendingStems.current.stems, pendingStems.current.duration);
        pendingStems.current = null;
      }
      setReady(true);
    }
  }, [engine, layers]);

  const play = useCallback(async () => {
    await ensureAudio();
    if (engine.playing || !hasVideo) return;
    await engine.resume();
    engine.play(video?.currentTime ?? 0);
    setPlaying(true);
    void video?.play().catch(() => {});
  }, [video, ensureAudio, engine, hasVideo]);

  const pause = useCallback(() => {
    engine.pause();
    setPlaying(false);
    video?.pause();
  }, [video, engine]);

  const togglePlay = useCallback(async () => {
    if (engine.playing) pause();
    else await play();
  }, [engine, play, pause]);

  /** Explore freezes the frame: pause on enter, resume on leave if it was playing. */
  const freeze = useCallback(
    (on: boolean) => {
      if (on) {
        resumeAfterFreeze.current = engine.playing;
        if (engine.playing) pause();
      } else if (resumeAfterFreeze.current) {
        resumeAfterFreeze.current = false;
        void play();
      }
    },
    [engine, play, pause],
  );

  /** Step the frozen frame back / forward; returns the new frame (for announcing). */
  const stepFrame = useCallback(
    (d: number): Frame | undefined => {
      if (!ds || !video || !hasVideo) return undefined;
      const frames = ds.features.frames;
      const cur = Math.max(0, frameIndexAt(frames, video.currentTime + 1e-3));
      const i = Math.max(0, Math.min(frames.length - 1, cur + d));
      video.currentTime = frames[i].t + 0.01;
      setTime(frames[i].t + 0.01);
      return frames[i];
    },
    [ds, video, hasVideo],
  );

  const setMood = useCallback(
    (id: string) => {
      const m = moodById(id);
      engine.setMood(m);
      setMoodState(m);
      setControlsState({ ...engine.controls });
    },
    [engine],
  );

  const setControls = useCallback(
    (patch: Partial<Controls>) => {
      engine.setControls(patch);
      setControlsState({ ...engine.controls });
    },
    [engine],
  );

  const setStyle = useCallback(
    (s: SoundStyle) => {
      setStyleState(s);
      engine.setStyle(s);
    },
    [engine],
  );

  const setVolume = useCallback(
    (v: number) => {
      setVolumeState(v);
      engine.setVolume(v);
    },
    [engine],
  );

  useEffect(() => {
    if (video) video.playbackRate = controls.speed;
  }, [video, controls.speed]);

  const setLayer = useCallback(
    (lid: LayerId, patch: Partial<LayerState>) => {
      setLayers((prev) => ({ ...prev, [lid]: { ...prev[lid], ...patch } }));
      engine.setLayer(lid, patch);
    },
    [engine],
  );

  /** Audio legend: reference tones (lowest / highest), then each rule as a short live demo. */
  const playLegend = useCallback(async () => {
    if (!ds) return;
    await ensureAudio();
    legendRunning.current = true;
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const ref = "Reference: this is the lowest note… and this is the highest.";
    setCaption(ref);
    onAnnounce(ref);
    engine.referenceTones();
    await wait(3500);
    for (let k = 0; k < ds.rules.legend.length && legendRunning.current; k++) {
      const item = ds.rules.legend[k];
      setLegendStep(k);
      setCaption(item.text);
      onAnnounce(item.text);
      await wait(Math.min(4000, 600 + item.text.length * 45)); // let the sentence be read first
      if (!legendRunning.current) break;
      if (item.demo) engine.demo(item.demo.target, item.demo.from, item.demo.to, 4);
      await wait(4800);
    }
    legendRunning.current = false;
    setLegendStep(null);
  }, [ds, ensureAudio, engine, onAnnounce]);

  const stopLegend = useCallback(() => {
    legendRunning.current = false;
    setLegendStep(null);
  }, []);

  const frameIdx = ds ? Math.max(0, frameIndexAt(ds.features.frames, time)) : 0;
  const note = noteName(valueToMidi(mood.key, targets.pitch, controls.pitchOct));

  return {
    engine,
    ready,
    audioState,
    outputDb,
    pressing,
    playing,
    time,
    frameIdx,
    frame: ds?.features.frames[frameIdx],
    targets,
    mood,
    setMood,
    controls,
    setControls,
    style,
    setStyle,
    volume,
    setVolume,
    note,
    ad,
    setAd,
    hapticsOn,
    setHapticsOn,
    layers,
    setLayer,
    caption,
    log,
    legendStep,
    playLegend,
    stopLegend,
    togglePlay,
    play,
    pause,
    freeze,
    stepFrame,
    ensureAudio,
    mappings,
  };
}
