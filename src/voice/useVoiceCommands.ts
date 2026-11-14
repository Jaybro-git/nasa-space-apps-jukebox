"use client";

import { useCallback, useRef, useState } from "react";
import type { SoundEngine } from "@/audio/engine";
import { parseAlternatives, type Command } from "./commands";
import { isListening, listenOnce, recognitionSupported, stopListening } from "./listen";

interface Options {
  engine: SoundEngine;
  ensureAudio: () => Promise<void>;
  /** silence the voice guide so the microphone does not hear it */
  quietGuide: () => void;
  speak: (text: string) => void;
  onCommand: (cmd: Command, heard: string) => void;
}

/**
 * Push-to-talk (K): rising chime + music ducked while listening, falling chime when a command
 * is understood, two low pips when not. The transcript is shown on screen; the outcome is spoken.
 */
export function useVoiceCommands({ engine, ensureAudio, quietGuide, speak, onCommand }: Options) {
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState("");
  const busy = useRef(false);

  const toggle = useCallback(async () => {
    if (isListening() || busy.current) {
      stopListening();
      return;
    }
    if (!recognitionSupported()) {
      speak("Voice commands need Chrome, Edge or Safari. All commands also work from the keyboard: press H to hear the keys.");
      return;
    }
    busy.current = true;
    await ensureAudio();
    quietGuide();
    engine.duck(true);
    engine.earcon("listen");
    setHeard("");
    setListening(true);
    await new Promise((r) => setTimeout(r, 250)); // let the chime finish before the mic opens
    const res = await listenOnce();
    setListening(false);
    engine.duck(false);
    busy.current = false;
    if (!res.ok) {
      if (res.error === "aborted") return;
      engine.earcon("fail");
      speak(
        res.error === "not-allowed"
          ? "The microphone is blocked. Allow it for this site to use voice commands."
          : res.error === "network"
            ? "Voice commands need an internet connection."
            : "I did not hear a command. Press K and try again, or say help.",
      );
      return;
    }
    const { command, heard: text } = parseAlternatives(res.alternatives);
    setHeard(text);
    if (command.kind === "unknown") {
      engine.earcon("fail");
      speak(`I heard: ${text}. Say help to hear the commands.`);
      return;
    }
    engine.earcon("done");
    onCommand(command, text);
  }, [engine, ensureAudio, quietGuide, speak, onCommand]);

  return { listening, heard, toggle, supported: recognitionSupported };
}
