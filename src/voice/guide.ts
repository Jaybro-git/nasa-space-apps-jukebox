/**
 * The voice guide: speaks ONLY the platform intro, the key list, each visualization's intro
 * and the Explore intro (never during playback). Fixed texts are pre-recorded neural-voice
 * clips (scripts/voice.mjs, Fish Audio, generated at build time: no API key ever reaches the
 * browser); anything dynamic, or any clip that is missing, uses the browser's own
 * speechSynthesis. Texts may contain {tone:low} / {tone:high} markers where the lowest /
 * highest data note is played between two spoken segments.
 *
 * While it speaks the music is ducked (about -8 dB), and any new message cancels the last.
 */
import script from "./script.json";

export type ClipId = keyof typeof script;
export const SCRIPT = script as Record<ClipId, string>;

interface Manifest {
  voice?: string;
  clips: Record<string, { file: string; hash: string }>;
}

/** Split a script text into spoken segments and the tones between them. */
export function segments(text: string): { text: string; toneAfter: number | null }[] {
  const parts = text.split(/\{tone:(low|high)\}/);
  const out: { text: string; toneAfter: number | null }[] = [];
  for (let k = 0; k < parts.length; k += 2) {
    const tone = parts[k + 1];
    out.push({ text: parts[k].trim(), toneAfter: tone == null ? null : tone === "low" ? 0 : 1 });
  }
  return out.filter((s) => s.text || s.toneAfter != null);
}

/** Text with the tone markers removed (for captions and live regions). */
export const plain = (text: string) => text.replace(/\s*\{tone:(low|high)\}\s*/g, " ").replace(/\s+/g, " ").trim();

export class VoiceGuide {
  private manifest: Manifest | null = null;
  private manifestP: Promise<void> | null = null;
  private audio: HTMLAudioElement | null = null;
  private run = 0;
  speaking = false;
  /** duck the music while speaking */
  onDuck: (on: boolean) => void = () => {};
  /** play reference note u (0 = lowest, 1 = highest) */
  onTone: (u: number) => void = () => {};
  /** caption of what is being said (shown on screen) */
  onCaption: (text: string) => void = () => {};

  private load(): Promise<void> {
    this.manifestP ??= fetch("/voice/manifest.json")
      .then((r) => (r.ok ? (r.json() as Promise<Manifest>) : null))
      .then((m) => {
        this.manifest = m;
      })
      .catch(() => {
        this.manifest = null;
      });
    return this.manifestP;
  }

  /** Stop speaking immediately (any key press, a new message, or voice off). */
  cancel(): void {
    this.run++;
    if (this.audio) {
      this.audio.pause();
      this.audio = null;
    }
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    if (this.speaking) this.onDuck(false);
    this.speaking = false;
  }

  /** Speak one of the fixed script texts (pre-recorded when available). True if it finished. */
  async clip(id: ClipId): Promise<boolean> {
    const text = SCRIPT[id];
    if (!text) return false;
    this.cancel();
    const run = this.run;
    await this.load();
    if (run !== this.run) return false;
    this.begin(plain(text));
    const segs = segments(text);
    for (let k = 0; k < segs.length; k++) {
      if (run !== this.run) return false;
      const s = segs[k];
      if (s.text) {
        const file = this.manifest?.clips[`${id}#${k}`]?.file;
        const ok = file ? await this.playFile(file, run) : false;
        if (!ok && run === this.run) await this.utter(s.text, run);
      }
      if (run !== this.run) return false;
      if (s.toneAfter != null) {
        this.onTone(s.toneAfter);
        await new Promise((r) => setTimeout(r, 1300));
      }
    }
    if (run !== this.run) return false;
    this.end();
    return true;
  }

  /** Speak dynamic text with the browser voice (e.g. a box summary, a country name). */
  async say(text: string): Promise<void> {
    this.cancel();
    const run = this.run;
    this.begin(text);
    await this.utter(text, run);
    if (run === this.run) this.end();
  }

  private begin(text: string): void {
    this.speaking = true;
    this.onDuck(true);
    this.onCaption(text);
  }

  private end(): void {
    this.speaking = false;
    this.onDuck(false);
  }

  private playFile(src: string, run: number): Promise<boolean> {
    return new Promise((resolve) => {
      const a = new Audio(src);
      this.audio = a;
      a.onended = () => resolve(true);
      a.onerror = () => resolve(false);
      a.play().catch(() => resolve(false));
      // cancelled: pause() fires no "ended", so poll for the run changing
      const id = setInterval(() => {
        if (run !== this.run) {
          clearInterval(id);
          resolve(true);
        }
      }, 100);
      a.addEventListener("ended", () => clearInterval(id));
      a.addEventListener("error", () => clearInterval(id));
    });
  }

  private utter(text: string, run: number): Promise<void> {
    if (typeof speechSynthesis === "undefined") return Promise.resolve();
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      const voices = speechSynthesis.getVoices();
      // prefer a natural / neural English voice when the system has one
      u.voice = voices.find((v) => /en/i.test(v.lang) && /natural|neural|online/i.test(v.name)) ?? voices.find((v) => /^en/i.test(v.lang)) ?? null;
      u.rate = 1;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      speechSynthesis.speak(u);
      const id = setInterval(() => {
        if (run !== this.run) {
          clearInterval(id);
          resolve();
        }
      }, 100);
      u.addEventListener("end", () => clearInterval(id));
    });
  }
}
