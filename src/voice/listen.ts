/**
 * Push-to-talk speech recognition (the browser's Web Speech API). One utterance per press:
 * it stops by itself after a short silence and returns up to five alternative transcripts,
 * which the command grammar (commands.ts) tries in order.
 *
 * Chrome and Edge recognise speech on Google / Microsoft servers; Safari supports it partly;
 * Firefox does not support it (supported() is false there).
 */

interface RecognitionAlternative {
  transcript: string;
}
interface RecognitionResultList {
  length: number;
  [i: number]: { length: number; [j: number]: RecognitionAlternative };
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: { results: RecognitionResultList }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

function ctor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const recognitionSupported = () => ctor() != null;

export type ListenResult = { ok: true; alternatives: string[] } | { ok: false; error: "no-speech" | "not-allowed" | "network" | "unsupported" | "aborted" | "other" };

let active: Recognition | null = null;

/** Listen for one utterance. Resolves when the speaker stops (or on error / abort). */
export function listenOnce(lang = "en-US"): Promise<ListenResult> {
  const C = ctor();
  if (!C) return Promise.resolve({ ok: false, error: "unsupported" });
  stopListening();
  return new Promise((resolve) => {
    const r = new C();
    active = r;
    r.lang = lang;
    r.continuous = false;
    r.interimResults = false;
    r.maxAlternatives = 5;
    let done = false;
    const finish = (res: ListenResult) => {
      if (done) return;
      done = true;
      if (active === r) active = null;
      resolve(res);
    };
    r.onresult = (e) => {
      const first = e.results[0];
      const alts: string[] = [];
      for (let k = 0; first && k < first.length; k++) alts.push(first[k].transcript);
      finish(alts.length ? { ok: true, alternatives: alts } : { ok: false, error: "no-speech" });
    };
    r.onerror = (e) => {
      const err = e.error === "no-speech" || e.error === "not-allowed" || e.error === "network" || e.error === "aborted" ? e.error : e.error === "service-not-allowed" ? "not-allowed" : "other";
      finish({ ok: false, error: err });
    };
    r.onend = () => finish({ ok: false, error: "no-speech" });
    try {
      r.start();
    } catch {
      finish({ ok: false, error: "other" });
    }
  });
}

/** Cancel listening (a second K press, Escape, or switching voice commands off). */
export function stopListening(): void {
  if (!active) return;
  const r = active;
  active = null;
  try {
    r.abort();
  } catch {
    /* already stopped */
  }
}

export const isListening = () => active != null;
