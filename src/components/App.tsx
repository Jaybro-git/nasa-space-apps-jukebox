"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadDataset, loadIndex, type IndexEntry } from "@/data/load";
import type { Dataset } from "@/data/types";
import type { Tool } from "@/audio/explore";
import { usePlayer } from "@/hooks/usePlayer";
import { useAnnounce } from "@/a11y/Announcer";
import { setHaptics } from "@/a11y/haptics";
import { SCRIPT, VoiceGuide, plain, type ClipId } from "@/voice/guide";
import { matchPlace, vizName, type Command } from "@/voice/commands";
import { useVoiceCommands } from "@/voice/useVoiceCommands";
import { Header, type TabId } from "./Header";
import { Observatory } from "./Observatory";
import { LinerNotes } from "./LinerNotes";
import { Drawer } from "./Drawer";
import { StartGate } from "./StartGate";
import { GalaxyBackground } from "./GalaxyBackground";
import { ZOOM_MAX, ZOOM_MIN } from "./Globe";
import type { View } from "./Stage";

export type Theme = "light" | "dark";

const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode: the choice just isn't remembered */
    }
  },
};

export function App() {
  const announce = useAnnounce();
  const [tab, setTab] = useState<TabId>("observe");
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [tracks, setTracks] = useState<IndexEntry[]>([]);
  const [vizId, setVizId] = useState<string | null>(null);
  const [ds, setDs] = useState<Dataset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [exploring, setExploringState] = useState(false);
  const [tool, setTool] = useState<Tool>("point");
  const [view, setView] = useState<View>("globe");
  const [zoom, setZoomState] = useState(1);
  const [meridian, setMeridian] = useState(0);
  const [shortcutsOn, setShortcutsOn] = useState(true);
  const [theme, setThemeState] = useState<Theme>("dark");
  const [voiceOn, setVoiceOnState] = useState(true);
  const [started, setStarted] = useState(false);
  const [voiceCaption, setVoiceCaption] = useState("");
  const guide = useMemo(() => new VoiceGuide(), []);
  const heardExplore = useRef(false);
  const prefs = useRef({ voiceOn, started });
  prefs.current = { voiceOn, started };

  const lastSpoken = useRef("");
  /** One channel for dynamic messages: the voice guide when on, else the screen-reader live region. */
  const speak = useCallback(
    (text: string) => {
      lastSpoken.current = text;
      if (prefs.current.voiceOn && prefs.current.started) void guide.say(text);
      else announce(text);
    },
    [guide, announce],
  );
  const player = usePlayer(ds, video, speak);

  const clip = useCallback(
    (id: ClipId) => {
      lastSpoken.current = plain(SCRIPT[id]);
      if (prefs.current.voiceOn && prefs.current.started) return guide.clip(id);
      announce(plain(SCRIPT[id]));
      return Promise.resolve(true);
    },
    [guide, announce],
  );

  // ---- theme: night mode by default; a saved choice (M / the moon button) wins ----
  useEffect(() => {
    const saved = store.get("jukebox-theme") as Theme | null;
    setThemeState(saved === "light" ? "light" : "dark");
    const v = store.get("jukebox-voice");
    if (v) setVoiceOnState(v === "on");
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const toggleTheme = () => {
    const t = theme === "dark" ? "light" : "dark";
    setThemeState(t);
    store.set("jukebox-theme", t);
    announce(t === "dark" ? "Night mode on." : "Night mode off.");
  };

  const setVoiceOn = useCallback(
    (on: boolean) => {
      setVoiceOnState(on);
      store.set("jukebox-voice", on ? "on" : "off");
      if (!on) guide.cancel();
      announce(on ? "Voice guide on." : "Voice guide off.");
    },
    [guide, announce],
  );

  // the voice guide ducks the music and plays reference notes inline
  useEffect(() => {
    guide.onDuck = (on) => player.engine.duck(on);
    guide.onTone = (u) => player.engine.refNote(u);
    guide.onCaption = setVoiceCaption;
  }, [guide, player.engine]);

  useEffect(() => {
    loadIndex()
      .then((t) => {
        setTracks(t);
        setVizId((c) => c ?? t[0]?.id ?? null);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!vizId) return;
    let live = true;
    loadDataset(vizId)
      .then((d) => live && setDs(d))
      .catch((e) => setError(String(e)));
    return () => {
      live = false;
    };
  }, [vizId]);

  useEffect(() => setHaptics(player.hapticsOn), [player.hapticsOn]);

  const setZoom = useCallback((z: number) => setZoomState(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z))), []);

  const focusStage = () => setTimeout(() => document.querySelector<HTMLElement>(".stage")?.focus(), 50);

  const setExploring = useCallback(
    (on: boolean) => {
      if (on === exploring) return;
      if (!on && ds?.atlas) return; // a still map has no timeline: it stays in Explore
      setExploringState(on);
      player.freeze(on);
      if (on) {
        focusStage();
        if (!heardExplore.current && prefs.current.voiceOn) {
          heardExplore.current = true;
          void clip("explore");
        } else speak("Explore. Paused on this frame. Keys 1 to 4 choose a tool. Escape to leave.");
      } else {
        const a = document.activeElement as HTMLElement | null;
        if (a?.classList.contains("stage")) a.blur();
        speak("Explore off.");
      }
    },
    [exploring, ds, player, clip, speak],
  );

  // a still map (Earth atlas) has no timeline: it opens straight into Explore
  useEffect(() => {
    if (!ds) return;
    if (ds.atlas) {
      setExploringState(true);
      setTool("point");
      focusStage();
    }
    if (prefs.current.started) {
      const id = `ds-${ds.meta.id}` as ClipId;
      if (SCRIPT[id]) void clip(id);
      else speak(`${ds.meta.title}. ${ds.meta.kindLabel}.`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ds]);

  const pickViz = useCallback(
    (id: string) => {
      if (id === vizId) return;
      if (exploring) {
        setExploringState(false);
        player.freeze(false);
      }
      player.pause();
      setZoomState(1);
      setVizId(id);
    },
    [vizId, exploring, player],
  );
  const stepViz = (d: number) => {
    if (!tracks.length) return;
    const i = (tracks.findIndex((t) => t.id === vizId) + d + tracks.length) % tracks.length;
    pickViz(tracks[i].id);
  };

  const toggleAD = () => {
    const on = !player.ad;
    player.setAd(on);
    speak(on ? "Spoken descriptions on: changes in the data will be described." : "Spoken descriptions off.");
  };

  const start = async (withVoice: boolean) => {
    setStarted(true);
    prefs.current.started = true;
    setVoiceOnState(withVoice);
    prefs.current.voiceOn = withVoice;
    store.set("jukebox-voice", withVoice ? "on" : "off");
    await player.ensureAudio(); // inside the user's key press / click: audio may start
    if (withVoice) {
      const heard = await guide.clip("intro");
      if (heard && ds) {
        const id = `ds-${ds.meta.id}` as ClipId;
        if (SCRIPT[id]) void guide.clip(id);
      }
    } else announce("Earth Information Jukebox. Press H to hear the keys, Space to play.");
  };

  // ---- voice commands (push-to-talk, K): every command maps to an existing action ----
  /** Send a key to the Explore map (entering Explore first if needed), as the keyboard would. */
  const stageKey = (key: string, shift = false, repeat = 1) => {
    const send = () => {
      const el = document.querySelector<HTMLElement>(".stage");
      for (let k = 0; k < repeat; k++) setTimeout(() => el?.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey: shift, bubbles: true })), k * 60);
    };
    if (!exploring) {
      setExploring(true);
      setTimeout(send, 250);
    } else send();
  };

  const zoomBy = (step: 1 | -1 | 0) => {
    const z = step === 0 ? 1 : Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * (step < 0 ? 1 / 1.5 : 1.5)));
    setZoom(z);
    speak(`Zoom ${Math.round(z * 10) / 10} times`);
  };

  /** "go to France": find the country on the Earth map (switching to it first if needed). */
  const gotoPlace = async (spoken: string) => {
    const earth = await loadDataset("earth").catch(() => null);
    const labels = earth?.atlas?.labels ?? [];
    const name = matchPlace(spoken, labels.map((l) => l.name));
    const label = labels.find((l) => l.name === name);
    if (!label) return speak(`I could not find ${spoken} on the map.`);
    const fire = () => document.querySelector(".stage")?.dispatchEvent(new CustomEvent("jukebox:goto", { detail: { lat: label.lat, lon: label.lon } }));
    if (vizId !== "earth") {
      pickViz("earth");
      setTimeout(fire, 2500); // after the Earth map has loaded and its intro has started
    } else {
      if (!exploring) setExploring(true);
      setTimeout(fire, exploring ? 0 : 250);
    }
  };

  const SPEEDS = [0.5, 1, 1.5] as const;
  const runCommand = (c: Command) => {
    switch (c.kind) {
      case "play":
        if (exploring) stageKey("Enter");
        else void player.play();
        return;
      case "pause":
        guide.cancel();
        player.pause();
        return;
      case "resume":
        if (exploring) setExploring(false);
        else void player.play();
        return;
      case "vizStep":
        return stepViz(c.step);
      case "viz":
        if (c.id === vizId) return speak(`${vizName(c.id)} is already open.`);
        if (!tracks.some((t) => t.id === c.id)) return speak(`${vizName(c.id)} is not available.`);
        return pickViz(c.id);
      case "explore":
        return setExploring(c.on);
      case "tool":
        return stageKey(String(["point", "hline", "vline", "box"].indexOf(c.tool) + 1));
      case "wholeMap":
        stageKey("4");
        setTimeout(() => stageKey("a"), 300);
        return;
      case "run":
        return stageKey("Enter");
      case "move": {
        const key = { north: "ArrowUp", south: "ArrowDown", east: "ArrowRight", west: "ArrowLeft" }[c.dir];
        const fives = Math.floor(c.steps / 5);
        if (fives) stageKey(key, true, fives);
        if (c.steps % 5) setTimeout(() => stageKey(key, false, c.steps % 5), fives * 60);
        return;
      }
      case "frame":
        return stageKey(c.step > 0 ? "]" : "[");
      case "zoom":
        return zoomBy(c.step);
      case "volume": {
        const v = Math.max(0, Math.min(1, Math.round((player.volume + 0.15 * c.step) * 20) / 20));
        player.setVolume(v);
        return speak(`Volume ${Math.round(v * 100)} percent.`);
      }
      case "speed": {
        const i = SPEEDS.indexOf(player.controls.speed);
        const next = c.step === 0 ? 1 : SPEEDS[Math.max(0, Math.min(2, i + c.step))];
        player.setControls({ speed: next });
        return speak(next === 1 ? "Normal speed." : next < 1 ? "Slow speed." : "Fast speed.");
      }
      case "legend":
        return void player.playLegend();
      case "describe":
        if (c.on !== player.ad) toggleAD();
        else speak(c.on ? "Descriptions are already on." : "Descriptions are already off.");
        return;
      case "theme":
        if ((theme === "dark") !== c.dark) toggleTheme();
        return;
      case "where":
        return stageKey("i");
      case "goto":
        return void gotoPlace(c.place);
      case "repeat":
        return speak(lastSpoken.current || "Nothing to repeat yet.");
      case "help":
        return void clip("voice-help");
      case "ambiguous":
        return speak(c.question);
    }
  };
  const commandRef = useRef(runCommand);
  commandRef.current = runCommand;
  const onCommand = useCallback((c: Command) => commandRef.current(c), []);
  const quietGuide = useCallback(() => guide.cancel(), [guide]);
  const voice = useVoiceCommands({ engine: player.engine, ensureAudio: player.ensureAudio, quietGuide, speak, onCommand });

  // Global single-key shortcuts (can be switched off: WCAG 2.1.4).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Control or Escape silences the voice guide (as screen readers do)
      if (e.key === "Control" || e.key === "Escape") guide.cancel();
      if (!shortcutsOn || !started) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement;
      const tag = el?.tagName ?? "";
      const k = e.key.toLowerCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.getAttribute?.("role") === "listbox") return;
      // inside the Explore map only the keys it does not use itself pass through
      if (el?.getAttribute?.("role") === "application" && !"emvhgnpldk?".includes(k)) return;
      if (k === " ") {
        if (tag === "BUTTON" || tag === "SUMMARY" || tag === "A") return;
        e.preventDefault();
        if (exploring) setExploring(false);
        else void player.togglePlay();
      } else if (k === "n") stepViz(1);
      else if (k === "p") stepViz(-1);
      else if (k === "d") toggleAD();
      else if (k === "e") setExploring(!exploring);
      else if (k === "l") void (player.legendStep != null ? player.stopLegend() : player.playLegend());
      else if (k === "g") {
        const v = view === "globe" ? "flat" : "globe";
        setView(v);
        speak(v === "globe" ? "Globe view." : "Flat map view.");
      } else if (k === "m") toggleTheme();
      else if (k === "v") setVoiceOn(!voiceOn);
      else if (k === "h" || k === "?") void clip("keys");
      else if (k === "k") {
        e.preventDefault();
        void voice.toggle();
      }
      else if (k === "+" || k === "=" || k === "-" || k === "_" || k === "0") {
        const z = k === "0" ? 1 : Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * (k === "-" || k === "_" ? 1 / 1.5 : 1.5)));
        setZoom(z);
        speak(`Zoom ${Math.round(z * 10) / 10} times`);
      } else if (k === "escape" && exploring) setExploring(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (error) return <p role="alert">Could not load data: {error}. Run the data pipeline first (see README).</p>;

  const current = tracks.find((t) => t.id === vizId);

  return (
    <div className="app">
      {theme === "dark" && <GalaxyBackground />}
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Header
        tab={tab}
        setTab={setTab}
        tracks={tracks}
        vizId={vizId}
        onPickViz={pickViz}
        theme={theme}
        toggleTheme={toggleTheme}
        voiceOn={voiceOn}
        setVoiceOn={setVoiceOn}
        ad={player.ad}
        toggleAD={toggleAD}
        listening={voice.listening}
        onMic={() => void voice.toggle()}
      />
      {(voice.listening || voice.heard) && (
        <div className={`voice-toast ${voice.listening ? "is-listening" : ""}`} aria-hidden="true" key={voice.heard || "listening"}>
          <span className="voice-dot" />
          {voice.listening ? "Listening… say a command" : `Heard: “${voice.heard}”`}
        </div>
      )}
      <main id="main" className={`main ${drawerOpen ? "drawer-open" : "drawer-closed"}`}>
        {ds ? (
          <>
            <div className="content">
            <Observatory
              ds={ds}
              mood={player.mood}
              frame={player.frame}
              frameIdx={player.frameIdx}
              time={player.time}
              note={player.note}
              meridian={meridian}
              onMeridian={(lon) => setMeridian((prev) => (Math.abs(prev - lon) >= 1 ? Math.round(lon) : prev))}
              view={view}
              setView={setView}
              video={video}
              onVideo={setVideo}
              exploring={exploring}
              setExploring={setExploring}
              tool={tool}
              setTool={setTool}
              stepFrame={player.stepFrame}
              playing={player.playing}
              engine={player.engine}
              ensureAudio={player.ensureAudio}
              hapticsOn={player.hapticsOn}
              announce={speak}
              ad={player.ad}
              caption={voiceCaption && guide.speaking ? voiceCaption : player.caption}
              legendRunning={player.legendStep != null}
              onLegend={player.playLegend}
              onStopLegend={player.stopLegend}
              zoom={zoom}
              setZoom={setZoom}
              theme={theme}
              hidden={tab !== "observe"}
            />
            {tab === "notes" && (
              <section id="panel-notes" role="tabpanel" aria-labelledby="tab-notes" className="panel-frame">
                <LinerNotes ds={ds} frame={player.frame} mappings={player.mappings} log={player.log} mood={player.mood} />
              </section>
            )}
            </div>
              <Drawer
                ds={ds}
                open={drawerOpen}
                setOpen={setDrawerOpen}
                engine={player.engine}
                playing={player.playing}
                audioState={player.audioState}
                outputDb={player.outputDb}
                pressing={player.pressing}
                time={player.time}
                togglePlay={player.togglePlay}
                mood={player.mood}
                setMood={(id) => {
                  player.setMood(id);
                  speak(`${id} mood.`);
                }}
                controls={player.controls}
                setControls={player.setControls}
                style={player.style}
                setStyle={player.setStyle}
                volume={player.volume}
                setVolume={player.setVolume}
                ad={player.ad}
                toggleAD={toggleAD}
                legendRunning={player.legendStep != null}
                onLegend={player.playLegend}
                onStopLegend={player.stopLegend}
                layers={player.layers}
                setLayer={player.setLayer}
                hapticsOn={player.hapticsOn}
                setHapticsOn={player.setHapticsOn}
                shortcutsOn={shortcutsOn}
                setShortcutsOn={setShortcutsOn}
              />
          </>
        ) : (
          <p style={{ padding: 24 }}>Loading…</p>
        )}
      </main>
      {!started && <StartGate voiceOn={voiceOn} theme={theme} onStart={(v) => void start(v)} />}
    </div>
  );
}
