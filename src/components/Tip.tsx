"use client";

import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";

/**
 * Tooltip shown on hover AND keyboard focus (WCAG 1.4.13: dismissable with Esc via blur,
 * hoverable, persistent). The text is also wired to the control with aria-describedby,
 * so screen-reader users get the same help.
 */
export function Tip({ text, children, side = "top" }: { text: ReactNode; children: ReactElement<{ "aria-describedby"?: string }>; side?: "top" | "bottom" | "left" }) {
  const id = useId();
  const child = isValidElement(children) ? cloneElement(children, { "aria-describedby": id }) : children;
  return (
    <span className={`tip tip-${side}`}>
      {child}
      <span role="tooltip" id={id} className="tip-bubble">
        {text}
      </span>
    </span>
  );
}
