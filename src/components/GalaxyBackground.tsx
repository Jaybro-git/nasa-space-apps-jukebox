"use client";

import type { ComponentType } from "react";
import GalaxyJs from "./reactbits/Galaxy";

// react-bits ships untyped JS: every prop is optional
const Galaxy = GalaxyJs as unknown as ComponentType<Record<string, unknown>>;

/**
 * Night-mode backdrop, three slow layers (purely decorative, behind everything):
 *  1. the real Milky Way (NASA SVS Deep Star Maps 2020) drifting very slowly,
 *  2. a few soft nebula clouds floating across it (CSS animation, screen-blended),
 *  3. the react-bits Galaxy star field on top (transparent, no mouse effects, calm speed).
 * Under prefers-reduced-motion every layer stands still.
 */
export function GalaxyBackground() {
  return (
    <div className="night-sky" aria-hidden="true">
      <div className="night-milkyway" />
      <div className="night-clouds">
        <i className="cloud c1" />
        <i className="cloud c2" />
        <i className="cloud c3" />
        <i className="cloud c4" />
      </div>
      <div className="night-stars">
        <Galaxy
          transparent
          mouseInteraction={false}
          mouseRepulsion={false}
          clickWarp={false}
          density={1.1}
          glowIntensity={0.28}
          saturation={0.35}
          hueShift={215}
          twinkleIntensity={0.35}
          speed={0.35}
          starSpeed={0.15}
          rotationSpeed={0.015}
        />
      </div>
    </div>
  );
}
