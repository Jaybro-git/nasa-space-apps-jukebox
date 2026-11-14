"use client";

import type { Dataset, Frame } from "@/data/types";
import type { SoundEngine } from "@/audio/engine";
import type { Mood } from "@/audio/moods";
import { TOOLS, type Tool } from "@/audio/explore";
import { spokenDate } from "@/data/geo";
import { fmtTime, readoutValue } from "@/data/format";
import { Stage, type View } from "./Stage";
import { ZOOM_MAX, ZOOM_MIN } from "./Globe";
import { Tip } from "./Tip";

const KIND_TIP: Record<Dataset["meta"]["kind"], string> = {
  decoded: "This map has a colour legend, so every pixel is decoded back to its real value before it drives the sound.",
  color: "No legend with units: brightness and colour are the data.",
  events: "No legend with units: each detected flash is an event; how many and where drive the sound.",
  atlas: "A still map for exploring by ear: land, ocean and country borders.",
};

interface Props {
  ds: Dataset;
  mood: Mood;
  frame: Frame | undefined;
  frameIdx: number;
  time: number;
  note: string;
  meridian: number;
  onMeridian: (lon: number) => void;
  view: View;
  setView: (v: View) => void;
  video: HTMLVideoElement | null;
  onVideo: (v: HTMLVideoElement | null) => void;
  exploring: boolean;
  setExploring: (v: boolean) => void;
  tool: Tool;
  setTool: (t: Tool) => void;
  stepFrame: (d: number) => Frame | undefined;
  playing: boolean;
  engine: SoundEngine;
  ensureAudio: () => Promise<void>;
  hapticsOn: boolean;
  announce: (s: string) => void;
  ad: boolean;
  caption: string;
  legendRunning: boolean;
  onLegend: () => void;
  onStopLegend: () => void;
  zoom: number;
  setZoom: (z: number) => void;
  theme: "light" | "dark";
  hidden: boolean;
}

function legend(ds: Dataset): { css: string; min: string; max: string } {
  const cb = ds.meta.colorbar;
  if (cb) {
    return {
      css: `linear-gradient(90deg, ${cb.colors.filter((_, i) => i % 6 === 0).join(", ")})`,
      min: `${cb.values[0].toFixed(0)} ${cb.units}`,
      max: `${cb.values[cb.values.length - 1].toFixed(0)} ${cb.units}`,
    };
  }
  const lb = ds.rules.legendBar;
  return lb ? { css: `linear-gradient(90deg, ${lb.colors.join(", ")})`, min: lb.min, max: lb.max } : { css: "transparent", min: "", max: "" };
}

const fmtLon = (l: number) => `${Math.abs(Math.round(l))}°${l >= 0 ? "E" : "W"}`;

export function Observatory(p: Props) {
  const { ds, frame } = p;
  const m = ds.meta;
  const still = !!ds.atlas;
  const lg = legend(ds);
  const phase = m.phases?.find((x) => x.id === frame?.phase);
  // lightning has no dates on screen: show the position in the excerpt instead
  const when = frame?.label ?? (frame?.date ? spokenDate(frame.date) : `${fmtTime(p.time)} of ${fmtTime(m.video.duration)}`);
  const r0 = ds.rules.readouts[0];
  const extra = ds.rules.readouts.slice(1, 4);
  const zoomBy = (f: number) => p.setZoom(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, p.zoom * f)));
  return (
    <section id="panel-observe" role="tabpanel" aria-labelledby="tab-observe" className="panel-frame" hidden={p.hidden}>
      <div className={`observatory ${still ? "is-still" : ""}`}>
        <div className="obs-card">
          <div className="eyebrow">Now observing · {m.sourceLabel}</div>
          <h2 className="obs-title">{m.title}</h2>
          <Tip text={KIND_TIP[m.kind]}>
            <div className="obs-unit" tabIndex={0}>
              {m.kindLabel} ⓘ
            </div>
          </Tip>
          <p className="obs-desc">{m.description}</p>
          <dl className="kv">
            <dt>Source</dt>
            <dd>
              <a href={m.svsUrl} target="_blank" rel="noreferrer">
                {m.svsId ? `NASA SVS ${m.svsId}` : m.sourceLabel}
              </a>
            </dd>
            <dt>Coverage</dt>
            <dd>{m.period}</dd>
            <dt>Sound</dt>
            <dd>
              {p.mood.title} mood · {p.mood.key.name}
            </dd>
          </dl>
          {!still && (
            <>
              <div className="readouts" role="group" aria-label="Live readings">
                <Tip text="Longitude facing you on the globe (the orange needle).">
                  <div tabIndex={0}>
                    <div className="readout-k">Meridian</div>
                    <div className="readout-v">{p.view === "globe" ? fmtLon(p.meridian) : "flat"}</div>
                  </div>
                </Tip>
                <Tip text={phase ? phase.label : "Time shown in the visualization for the current data frame."}>
                  <div tabIndex={0}>
                    <div className="readout-k">{frame?.date ? "Date" : frame?.label ? "Year" : "Clip"}</div>
                    <div className="readout-v">{when}</div>
                  </div>
                </Tip>
                {r0 && (
                  <Tip text={`${r0.label}: measured from the current frame.`}>
                    <div tabIndex={0}>
                      <div className="readout-k">Reading</div>
                      <div className="readout-v">{readoutValue(r0, frame)}</div>
                    </div>
                  </Tip>
                )}
                <Tip text="The note the data plays right now, on the mood's scale.">
                  <div tabIndex={0}>
                    <div className="readout-k">Note</div>
                    <div className="readout-v">{p.playing ? p.note : "—"}</div>
                  </div>
                </Tip>
              </div>
              <div className="readouts readouts-sub">
                {extra.map((r) => (
                  <div key={r.label}>
                    <div className="readout-k">{r.label}</div>
                    <div className="readout-v">{readoutValue(r, frame)}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="obs-stage">
          <div className="stage-tools">
            <div className="seg-group compact" role="radiogroup" aria-label="View (G)">
              <button type="button" role="radio" aria-checked={p.view === "globe"} className="seg" onClick={() => p.setView("globe")}>
                Globe
              </button>
              <button type="button" role="radio" aria-checked={p.view === "flat"} className="seg" onClick={() => p.setView("flat")}>
                Flat
              </button>
            </div>
            <div className="seg-group compact" role="group" aria-label="Zoom">
              <button type="button" className="seg" onClick={() => zoomBy(1 / 1.5)} disabled={p.zoom <= ZOOM_MIN} aria-label="Zoom out (minus)">
                −
              </button>
              <button type="button" className="seg zoom-read" onClick={() => p.setZoom(1)} aria-label={`Zoom ${p.zoom.toFixed(1)} times. Reset (0)`}>
                {p.zoom.toFixed(1)}×
              </button>
              <button type="button" className="seg" onClick={() => zoomBy(1.5)} disabled={p.zoom >= ZOOM_MAX} aria-label="Zoom in (plus)">
                +
              </button>
            </div>
          </div>
          <Stage
            ds={ds}
            view={p.view}
            frameIdx={p.frameIdx}
            phase={frame?.phase}
            exploring={p.exploring}
            setExploring={p.setExploring}
            tool={p.tool}
            setTool={p.setTool}
            stepFrame={p.stepFrame}
            playing={p.playing}
            engine={p.engine}
            ensureAudio={p.ensureAudio}
            hapticsOn={p.hapticsOn}
            announce={p.announce}
            video={p.video}
            onVideo={p.onVideo}
            onMeridian={p.onMeridian}
            zoom={p.zoom}
            setZoom={p.setZoom}
            theme={p.theme}
          />
        </div>

        <div className="obs-bottom">
          {p.ad && (
            <div className="ad-box" aria-hidden="true">
              <div className="ad-box-k">Description · live</div>
              <p>{p.caption || "Press play. A short description appears here whenever the data changes meaningfully."}</p>
            </div>
          )}
          {p.exploring ? (
            <div className="timebar explore-bar" role="toolbar" aria-label="Explore tools">
              <span className="explore-tag">Explore · paused</span>
              <div className="seg-group" role="radiogroup" aria-label="Tool (keys 1 to 4)">
                {TOOLS.map((t) => (
                  <Tip key={t.id} text={`${t.help} (${t.key})`}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={p.tool === t.id}
                      className="seg"
                      onClick={() => {
                        p.setTool(t.id);
                        document.querySelector<HTMLElement>(".stage")?.focus();
                      }}
                    >
                      {t.key} {t.label}
                    </button>
                  </Tip>
                ))}
              </div>
              {p.tool === "box" && (
                <button type="button" className="pill-btn" onClick={() => document.querySelector<HTMLElement>(".stage")?.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }))}>
                  Whole map (A)
                </button>
              )}
              {!still && (
                <div className="row-btns">
                  <button type="button" className="pill-btn" onClick={() => p.stepFrame(-1)} aria-label="Previous frame ([)">
                    ◀ Frame
                  </button>
                  <span className="timebar-end">{when}</span>
                  <button type="button" className="pill-btn" onClick={() => p.stepFrame(1)} aria-label="Next frame (])">
                    Frame ▶
                  </button>
                </div>
              )}
              {!still && (
                <button type="button" className="pill-btn" aria-pressed={true} onClick={() => p.setExploring(false)}>
                  Done (Esc)
                </button>
              )}
            </div>
          ) : (
            <div className="timebar">
              <span className="timebar-end" aria-hidden="true">
                {fmtTime(p.time)}
              </span>
              <label htmlFor="seek" className="sr-only">
                Position in {m.title}
              </label>
              <input
                id="seek"
                type="range"
                min={0}
                max={m.video.duration}
                step={0.1}
                value={Math.min(p.time, m.video.duration)}
                aria-valuetext={`${fmtTime(p.time)} of ${fmtTime(m.video.duration)}, ${when}`}
                onChange={(e) => {
                  if (p.video) p.video.currentTime = Number(e.target.value);
                }}
              />
              <span className="timebar-end" aria-hidden="true">
                {fmtTime(m.video.duration)}
              </span>
              {lg.min && (
                <Tip text={m.colorbar ? "The published colorbar: each colour is decoded back to this value." : "What the colours mean in this visualization."}>
                  <div className="legend" role="img" aria-label={`Colour legend: ${lg.min} to ${lg.max}`} tabIndex={0}>
                    <span>{lg.min}</span>
                    <div className="legend-ramp" style={{ background: lg.css }} />
                    <span>{lg.max}</span>
                  </div>
                </Tip>
              )}
              <Tip text="Hear what each sound means, one short demo at a time (L).">
                <button type="button" className="pill-btn" aria-pressed={p.legendRunning} onClick={p.legendRunning ? p.onStopLegend : p.onLegend}>
                  {p.legendRunning ? "Stop legend" : "Sound legend"}
                </button>
              </Tip>
              <Tip text="Pause on this frame and explore it with Point, Row, Column and Box tools (E).">
                <button type="button" className="pill-btn" onClick={() => p.setExploring(true)}>
                  Explore
                </button>
              </Tip>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
