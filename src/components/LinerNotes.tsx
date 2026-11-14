"use client";

import { useMemo } from "react";
import type { ResolvedMapping } from "@/audio/rules";
import type { Dataset, Frame, Target } from "@/data/types";
import type { Mood } from "@/audio/moods";
import { formatValue } from "@/data/format";
import { getPath } from "@/data/interpolate";
import { transcript } from "@/narration/template";

const SOUND: Record<Target, string> = {
  pitch: "Pitch of the data note (one per sample)",
  density: "How often the note repeats (1-4 times)",
  luminance: "Loudness + brightness of the note",
  pan: "Left / right position",
  gain: "Flute above, right ear",
  loss: "Bass below, left ear",
};

interface Props {
  ds: Dataset;
  frame: Frame | undefined;
  mappings: ResolvedMapping[];
  log: { id: number; tag: string; text: string }[];
  mood: Mood;
}

export function LinerNotes({ ds, frame, mappings, log, mood }: Props) {
  const m = ds.meta;
  const full = useMemo(
    () => transcript(ds.rules.narration, ds.features.frames, (f) => m.phases?.find((x) => x.id === f.phase)?.label),
    [ds, m.phases],
  );
  return (
    <div className="notes">
      <div>
        <div className="eyebrow">
          SVS {m.svsId} · {m.kindLabel}
        </div>
        <h2 className="big-title">How it sounds</h2>
      </div>
      <div className="notes-grid">
        <section className="note-card" aria-labelledby="about-h">
          <h3 id="about-h">About this data</h3>
          <div style={{ fontFamily: "var(--serif)", fontSize: 20, lineHeight: 1.2 }}>{m.title}</div>
          <p>{m.description}</p>
          <dl className="kv" style={{ fontSize: 13 }}>
            <dt>Source</dt>
            <dd>
              <a href={m.svsUrl} target="_blank" rel="noreferrer">
                {m.sourceLabel} · SVS {m.svsId}
              </a>
            </dd>
            <dt>Span</dt>
            <dd>{m.period}</dd>
            <dt>Values</dt>
            <dd>{m.kindLabel}</dd>
            <dt>Mood</dt>
            <dd>
              {mood.title} · {mood.key.name} pentatonic · synthesized pad
            </dd>
          </dl>
          <h3 style={{ marginTop: 18, fontSize: 18 }}>Caveats</h3>
          <ul className="caveats">
            {m.caveats.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <h3 style={{ marginTop: 18, fontSize: 18 }}>Credits</h3>
          <p className="credits">
            Data and visualizations: NASA&apos;s{" "}
            <a href="https://svs.gsfc.nasa.gov/" target="_blank" rel="noreferrer">
              Scientific Visualization Studio
            </a>{" "}
            /{" "}
            <a href="https://svs.gsfc.nasa.gov/gallery/earth-information-center/" target="_blank" rel="noreferrer">
              Earth Information Center
            </a>
            ; Blue Marble Next Generation (NASA Earth Observatory); clouds: NASA MODIS via GIBS; elevation: NOAA ETOPO1; borders: Natural Earth; night sky: NASA SVS Deep Star Maps
            2020 and the react-bits Galaxy and Topography components. Samples: Salamander Grand Piano (A. Holm) and tonejs-instruments (N. Brosowsky), CC BY 3.0. Voice: Fish Audio.
          </p>
          <p className="credits">NASA does not endorse any non-U.S. Government entity and is not responsible for information contained on non-U.S. Government websites.</p>
        </section>

        <section className="note-card" aria-labelledby="pressed-h">
          <h3 id="pressed-h">What each sound means</h3>
          <p className="note-lede">
            Video time is music time, and every onset you hear is data: one note for each data sample (silence means no data), on a calm pentatonic scale. The background pad never changes and has no beat. A soft bell marks each new month, two bells a new year. In Explore, the picture pauses and you can scan it: Point, Row (west to east), Column (north to south) and Box (left to right, north = higher).
          </p>
          {mappings.map((mp, i) => (
            <div className="map-row" key={i}>
              <span className="map-row-visual">{mp.label}</span>
              <span className="map-row-sound">→ {SOUND[mp.target]}</span>
              <span className="map-row-live">{formatValue(getPath(frame, mp.feature), { decimals: mp.decimals ?? 2, unit: mp.unit === "%" ? undefined : mp.unit, format: mp.unit === "%" ? "percent" : undefined })}</span>
              <details>
                <summary>Why</summary>
                {mp.why}
              </details>
            </div>
          ))}
          {ds.rules.events && (
            <div className="map-row">
              <span className="map-row-visual">New detected events</span>
              <span className="map-row-sound">→ Plucked hits (where + how big)</span>
              <span className="map-row-live">{frame?.eventCount ?? "—"}</span>
              <details>
                <summary>Why</summary>
                {ds.rules.events.why}
              </details>
            </div>
          )}
        </section>

        <section className="note-card log-card" aria-labelledby="log-h">
          <h3 id="log-h">Description transcript</h3>
          <p className="note-lede">Text lines appear when the data changes meaningfully. With Descriptions on (D), they are spoken. Every line is filled from measured numbers, nothing else.</p>
          <ol className="log" aria-live="off">
            {log.length === 0 && <li style={{ display: "block", color: "#C9BFB4" }}>Press play (Space). Descriptions appear here.</li>}
            {log.map((l) => (
              <li key={l.id}>
                <span className="tag">{l.tag}</span>
                <span>{l.text}</span>
              </li>
            ))}
          </ol>
          <details>
            <summary>Full text transcript of this track</summary>
            <ol>
              {full.map((l) => (
                <li key={l.t}>
                  {l.t.toFixed(1)} s · {l.text}
                </li>
              ))}
            </ol>
          </details>
        </section>
      </div>
    </div>
  );
}
