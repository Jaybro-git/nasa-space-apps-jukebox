"use client";

import type { IndexEntry } from "@/data/load";

export type TabId = "observe" | "notes";

export const TABS: { id: TabId; label: string }[] = [
  { id: "observe", label: "Observatory" },
  { id: "notes", label: "How it sounds" },
];

interface Props {
  tab: TabId;
  setTab: (t: TabId) => void;
  tracks: IndexEntry[];
  vizId: string | null;
  onPickViz: (id: string) => void;
  theme: "light" | "dark";
  toggleTheme: () => void;
  voiceOn: boolean;
  setVoiceOn: (v: boolean) => void;
  ad: boolean;
  toggleAD: () => void;
}

export function Header(p: Props) {
  const onTabKey = (e: React.KeyboardEvent, i: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    p.setTab(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  };
  return (
    <header className="site-header">
      <div className="brand">
        <span className="brand-disc" aria-hidden="true" />
        <div style={{ minWidth: 0 }}>
          <h1>Earth Information Jukebox</h1>
          <div className="brand-sub">NASA Earth data, sonified</div>
        </div>
      </div>

      <label className="viz-select">
        <span className="eyebrow">Visualization</span>
        <select value={p.vizId ?? ""} onChange={(e) => p.onPickViz(e.target.value)} aria-describedby="viz-keys">
          {p.tracks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
        <span id="viz-keys" className="sr-only">
          N and P switch visualizations from anywhere.
        </span>
      </label>

      <div role="tablist" aria-label="Sections" className="tabs">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            id={`tab-${t.id}`}
            role="tab"
            aria-selected={p.tab === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={p.tab === t.id ? 0 : -1}
            className="tab"
            onClick={() => p.setTab(t.id)}
            onKeyDown={(e) => onTabKey(e, i)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="header-end">
        <button type="button" className="toggle" aria-pressed={p.voiceOn} onClick={() => p.setVoiceOn(!p.voiceOn)} title="Voice guide (V)">
          <span aria-hidden="true">🗣</span> Voice guide
        </button>
        <button type="button" className="toggle" aria-pressed={p.ad} onClick={p.toggleAD} title="Spoken descriptions of data changes (D)">
          <span aria-hidden="true">≋</span> Descriptions
        </button>
        <button type="button" className="toggle icon-toggle" aria-pressed={p.theme === "dark"} onClick={p.toggleTheme} title="Night mode (M)" aria-label="Night mode">
          <span aria-hidden="true">{p.theme === "dark" ? "☾" : "☀"}</span>
        </button>
      </div>
    </header>
  );
}
