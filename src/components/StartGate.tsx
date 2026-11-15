"use client";

import { useEffect, useRef, type ComponentType } from "react";
import TopographyJs from "./reactbits/Topography";

// react-bits ships untyped JS: every prop is optional
const Topography = TopographyJs as unknown as ComponentType<Record<string, unknown>>;

/**
 * First screen. Browsers only allow sound after a user action, so one key press both unlocks
 * audio and chooses whether the voice guide speaks. Enter = with voice, Escape = silent.
 * The card's backdrop is the react-bits Topography field, tinted for the current theme.
 */
export function StartGate({ voiceOn, theme, onStart }: { voiceOn: boolean; theme: "light" | "dark"; onStart: (withVoice: boolean) => void }) {
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    btn.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onStart(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onStart]);
  const dark = theme === "dark";
  return (
    <div className="gate" role="dialog" aria-modal="true" aria-labelledby="gate-h" aria-describedby="gate-d">
      <div className="gate-card">
        <div className="gate-topo" aria-hidden="true">
          <Topography
            key={theme}
            lightMode={!dark}
            color={dark ? "#ff8f45" : "#c2570c"}
            lineCount={20}
            glow={dark ? 0.6 : 0.25}
            brightness={dark ? 0.9 : 1}
            speed={0.12}
            mouseInteraction={false}
            clickEffect="none"
            fog={dark ? 0.45 : 0.3}
          />
        </div>
        <div className="gate-body">
          <span className="brand-disc gate-disc" aria-hidden="true" />
          <h2 id="gate-h">The Earth Information Jukebox</h2>
          <p id="gate-d">
            NASA Earth data, turned into calm music you can explore by ear. Meet Jodi, your voice guide. Press <kbd>Enter</kbd> to start with Jodi, or <kbd>Escape</kbd> to start silently.
          </p>
          <div className="gate-btns">
            <button ref={btn} type="button" className="btn-primary" onClick={() => onStart(true)}>
              Start with voice guide
            </button>
            <button type="button" className="pill-btn" onClick={() => onStart(false)}>
              Start silently{voiceOn ? "" : " (last choice)"}
            </button>
          </div>
          <p className="gate-small">Headphones recommended: left and right carry meaning.</p>
        </div>
      </div>
    </div>
  );
}
