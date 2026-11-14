"use client";

import { useEffect, useRef } from "react";
import { LAYERS, STYLES, type Controls, type LayerId, type SoundEngine, type SoundStyle, type Speed } from "@/audio/engine";
import { MOODS, type Lead, type Mood } from "@/audio/moods";
import type { LayerState } from "@/hooks/usePlayer";
import type { Dataset } from "@/data/types";
import { hapticsSupported } from "@/a11y/haptics";
import { Tip } from "./Tip";

interface Props {
  ds: Dataset;
  open: boolean;
  setOpen: (v: boolean) => void;
  engine: SoundEngine;
  playing: boolean;
  audioState: string;
  outputDb: number;
  pressing: string;
  time: number;
  togglePlay: () => void;
  mood: Mood;
  setMood: (id: string) => void;
  controls: Controls;
  setControls: (c: Partial<Controls>) => void;
  style: SoundStyle;
  setStyle: (s: SoundStyle) => void;
  volume: number;
  setVolume: (v: number) => void;
  ad: boolean;
  toggleAD: () => void;
  legendRunning: boolean;
  onLegend: () => void;
  onStopLegend: () => void;
  layers: Record<LayerId, LayerState>;
  setLayer: (id: LayerId, patch: Partial<LayerState>) => void;
  hapticsOn: boolean;
  setHapticsOn: (v: boolean) => void;
  shortcutsOn: boolean;
  setShortcutsOn: (v: boolean) => void;
}

const LEADS: [Lead, string][] = [
  ["piano", "Piano"],
  ["harp", "Harp"],
  ["flute", "Flute"],
  ["strings", "Strings"],
];

const SPEEDS: [Speed, string][] = [
  [0.5, "Slow"],
  [1, "Normal"],
  [1.5, "Fast"],
];

/** Engine-independent beep: isolates "browser/OS output" problems from app problems. */
function testSpeakers() {
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ac = new AC();
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.frequency.value = 660;
  g.gain.setValueAtTime(0.0001, ac.currentTime);
  g.gain.exponentialRampToValueAtTime(0.4, ac.currentTime + 0.05);
  g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 1);
  o.connect(g).connect(ac.destination);
  o.start();
  o.stop(ac.currentTime + 1.05);
  o.onended = () => void ac.close();
}

function PlayIcon({ playing }: { playing: boolean }) {
  return playing ? (
    <>
      <span className="ico-pause" />
      <span className="ico-pause" />
    </>
  ) : (
    <span className="ico-play" />
  );
}

/** EQ bars read the real Tone.js analyser (frozen when reduced motion is preferred). */
function Eq({ engine, playing }: { engine: SoundEngine; playing: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const vals = new Array(16).fill(0.06);
    const loop = () => {
      const data = playing ? engine.spectrum(16) : [];
      const bars = ref.current?.children;
      if (bars)
        for (let i = 0; i < bars.length; i++) {
          vals[i] += ((data[i] ?? 0.06) - vals[i]) * 0.3;
          (bars[i] as HTMLElement).style.height = `${8 + vals[i] * 92}%`;
        }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [engine, playing]);
  return (
    <div ref={ref} className="eq" aria-hidden="true">
      {Array.from({ length: 16 }, (_, i) => (
        <i key={i} />
      ))}
    </div>
  );
}

/** A labelled group of mutually exclusive buttons (radio semantics). */
function Choice<T extends string | number>({ label, help, value, options, onPick }: { label: string; help?: string; value: T; options: [T, string][]; onPick: (v: T) => void }) {
  return (
    <div className="choice">
      <div className="choice-label" id={`ch-${label}`}>
        {label}
      </div>
      <div className="seg-group" role="radiogroup" aria-labelledby={`ch-${label}`} aria-describedby={help ? `chh-${label}` : undefined}>
        {options.map(([v, l]) => (
          <button key={String(v)} type="button" role="radio" aria-checked={value === v} className="seg" onClick={() => onPick(v)}>
            {l}
          </button>
        ))}
      </div>
      {help && (
        <div className="choice-help" id={`chh-${label}`}>
          {help}
        </div>
      )}
    </div>
  );
}

export function Drawer(p: Props) {
  const m = p.ds.meta;
  const still = !!p.ds.atlas;
  const ctl = p.controls;
  const years = m.period.match(/\d{4}/g) ?? [];
  const pitchMap = p.ds.rules.mappings.find((x) => x.target === "pitch");
  const styleDef = STYLES.find((s) => s.id === p.style)!;
  const playLabel = p.playing ? "Pause" : "Play";

  // collapsed: a slim rail inside the main area (never over the map)
  if (!p.open) {
    return (
      <aside className="drawer-rail" aria-label="The Jukebox (collapsed)">
        <button type="button" className="round rail-open" onClick={() => p.setOpen(true)} aria-label="Show player" aria-expanded={false} title="Show player">
          <span aria-hidden="true">‹</span>
        </button>
        <div className={`rail-disc ${p.playing ? "spinning" : ""}`} aria-hidden="true">
          <i style={{ background: p.mood.swatch }} />
        </div>
        {!still && (
          <button type="button" className="play-btn play-sm" onClick={p.togglePlay} aria-label={playLabel} title={`${playLabel} (Space)`}>
            <PlayIcon playing={p.playing} />
          </button>
        )}
        <span className="rail-title" aria-hidden="true">
          {m.title}
        </span>
      </aside>
    );
  }

  return (
    <aside className="drawer" aria-label="The Jukebox player">
      <div className="drawer-head">
        <h2>The Jukebox</h2>
        <button type="button" className="round" onClick={() => p.setOpen(false)} aria-label="Hide player" aria-expanded={true} title="Hide player">
          <span aria-hidden="true">›</span>
        </button>
      </div>

      <div className="turntable">
        <div className="deck" aria-hidden="true">
          <div className="platter" />
          <div className={`vinyl ${p.playing ? "spinning" : ""}`}>
            <div className="vinyl-label" style={{ background: p.mood.swatch }}>
              <span>{p.mood.title}</span>
              <i />
            </div>
          </div>
          <div className="vinyl-sheen" />
          <div className="tonearm-base" />
          <div className="tonearm" style={{ transform: `rotate(${p.playing ? 26 : 3}deg)` }}>
            <i />
          </div>
        </div>
        <div className="deck-side">
          {!still ? (
            <button type="button" className="play-btn" onClick={p.togglePlay} aria-label={playLabel} title={`${playLabel} (Space)`}>
              <PlayIcon playing={p.playing} />
            </button>
          ) : (
            <span className="deck-note">Still map: explore by ear</span>
          )}
          <Eq engine={p.engine} playing={p.playing} />
        </div>
      </div>

      <div>
        <div className="np-title">{m.title}</div>
        <div className="np-sub">
          {pitchMap ? `Higher note = higher ${pitchMap.label.toLowerCase()}` : still ? (p.ds.atlas?.terrainAt ? "Explore by ear: surf, deep ocean, land, wind, ice" : "Explore by ear: higher = more") : m.kindLabel}
        </div>
      </div>
      {!still && (
        <>
          <div className="progress" aria-hidden="true">
            <span>{years[0] ?? "start"}</span>
            <div className="progress-bar">
              <div style={{ width: `${Math.min(100, (p.time / m.video.duration) * 100)}%` }} />
            </div>
            <span>{years[years.length - 1] ?? "end"}</span>
          </div>
        </>
      )}

      <section className="sound-card" aria-labelledby="snd-h">
        <h3 id="snd-h">Sound</h3>
        {!still && <Choice label="Speed" value={ctl.speed} options={SPEEDS} onPick={(v) => p.setControls({ speed: v })} />}
        <div className="slider">
          <div className="slider-top">
            <label htmlFor="vol" className="choice-label">
              Volume
            </label>
            <span className="slider-val">{Math.round(p.volume * 100)}%</span>
          </div>
          <input id="vol" type="range" min={0} max={1} step={0.05} value={p.volume} onChange={(e) => p.setVolume(Number(e.target.value))} aria-valuetext={`${Math.round(p.volume * 100)} percent`} />
        </div>
        <Choice label="Style" help={styleDef.help} value={p.style} options={STYLES.map((s) => [s.id, s.label])} onPick={p.setStyle} />
        <Choice label="Mood" help={p.mood.description} value={p.mood.id} options={MOODS.map((x) => [x.id, x.title])} onPick={p.setMood} />
        <div className="row-btns">
          <button type="button" className="pill-btn grow" aria-pressed={p.legendRunning} onClick={p.legendRunning ? p.onStopLegend : p.onLegend}>
            {p.legendRunning ? "Stop legend" : "Sound legend (L)"}
          </button>
          <button type="button" className="pill-btn grow" aria-pressed={p.ad} onClick={p.toggleAD}>
            Descriptions (D)
          </button>
        </div>

        <details className="layers">
          <summary>Advanced</summary>
          <div className="slider">
            <div className="slider-top">
              <label htmlFor="sl-oct" className="choice-label">
                Pitch range
              </label>
              <span className="slider-val">{ctl.pitchOct} octaves</span>
            </div>
            <input id="sl-oct" type="range" min={1} max={3} step={1} value={ctl.pitchOct} onChange={(e) => p.setControls({ pitchOct: Number(e.target.value) })} aria-valuetext={`${ctl.pitchOct} octaves`} />
            <div className="choice-help">Wider = bigger jumps between low and high values.</div>
          </div>
          <div className="slider">
            <div className="slider-top">
              <label htmlFor="sl-pan" className="choice-label">
                Stereo width
              </label>
              <span className="slider-val">{Math.round(ctl.panWidth * 100)}%</span>
            </div>
            <input id="sl-pan" type="range" min={0} max={1} step={0.1} value={ctl.panWidth} onChange={(e) => p.setControls({ panWidth: Number(e.target.value) })} aria-valuetext={`${Math.round(ctl.panWidth * 100)} percent`} />
            <div className="choice-help">How far left and right the data notes move.</div>
          </div>
          <Choice label="Instrument" value={ctl.lead} options={LEADS} onPick={(v) => p.setControls({ lead: v })} />
          <div className="choice-label" style={{ marginTop: 8 }}>
            Layers
          </div>
          {LAYERS.map((def) => {
            const st = p.layers[def.id];
            return (
              <div className="layer" key={def.id}>
                <Tip text={def.description}>
                  <span className="layer-name" id={`layer-${def.id}`} tabIndex={0}>
                    {def.label}
                  </span>
                </Tip>
                <button type="button" className="chip" aria-pressed={st.mute} aria-label={`Mute ${def.label}`} onClick={() => p.setLayer(def.id, { mute: !st.mute })}>
                  M
                </button>
                <button type="button" className="chip" aria-pressed={st.solo} aria-label={`Solo ${def.label}`} onClick={() => p.setLayer(def.id, { solo: !st.solo })}>
                  S
                </button>
                <input
                  type="range"
                  min={-24}
                  max={6}
                  step={1}
                  value={st.volume}
                  aria-labelledby={`layer-${def.id}`}
                  aria-valuetext={`${st.volume >= 0 ? "+" : ""}${st.volume} decibels`}
                  onChange={(e) => p.setLayer(def.id, { volume: Number(e.target.value) })}
                />
              </div>
            );
          })}
          <label className="check">
            <input type="checkbox" checked={p.shortcutsOn} onChange={(e) => p.setShortcutsOn(e.target.checked)} />
            Single-key shortcuts
          </label>
          {hapticsSupported() && (
            <label className="check">
              <input type="checkbox" checked={p.hapticsOn} onChange={(e) => p.setHapticsOn(e.target.checked)} />
              Vibration in Explore
            </label>
          )}
          <div className="audio-status">
            {p.pressing && <span className="pressing">{p.pressing}</span>}
            <span role="status">
              {p.audioState === "running" ? (
                <span className="ok">
                  ● Audio running{p.playing ? "" : " · paused"} · output {Number.isFinite(p.outputDb) ? `${Math.round(p.outputDb)} dB` : "silent"}
                </span>
              ) : p.audioState === "not started" ? (
                "Audio starts when you press Play (browsers block autoplay)."
              ) : (
                <button type="button" className="pill-btn" onClick={() => void p.engine.resume()}>
                  Audio is {p.audioState}: click to enable sound
                </button>
              )}
            </span>
            <button type="button" className="pill-btn" onClick={testSpeakers}>
              Test speakers
            </button>
          </div>
        </details>
      </section>
      {p.pressing && !p.playing && <div className="hint">{p.pressing}</div>}
      {p.shortcutsOn && <div className="hint">Space play · N/P next · E explore · L legend · H all keys</div>}
    </aside>
  );
}
