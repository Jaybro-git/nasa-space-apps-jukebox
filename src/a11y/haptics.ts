/** Vibration API where supported (Android Chrome); silently ignored elsewhere (iOS, desktop). */
export const hapticsSupported = (): boolean => typeof navigator !== "undefined" && "vibrate" in navigator;

let enabled = true;
export const setHaptics = (on: boolean) => {
  enabled = on;
};

/** Pulse length scales with intensity 0..1. */
export function pulse(intensity: number): void {
  if (!enabled || !hapticsSupported()) return;
  const ms = Math.round(10 + Math.min(1, Math.max(0, intensity)) * 70);
  navigator.vibrate(ms);
}

export function pattern(p: number[]): void {
  if (enabled && hapticsSupported()) navigator.vibrate(p);
}
