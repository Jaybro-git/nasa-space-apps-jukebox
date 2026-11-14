"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

type Announce = (message: string, politeness?: "polite" | "assertive") => void;
const Ctx = createContext<Announce>(() => {});

/**
 * Visually hidden ARIA live regions. Re-announcing identical text works because the
 * region is cleared first.
 */
export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const announce = useCallback<Announce>((message, politeness = "polite") => {
    const set = politeness === "assertive" ? setAssertive : setPolite;
    set("");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => set(message), 60);
  }, []);

  return (
    <Ctx.Provider value={announce}>
      {children}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {polite}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
        {assertive}
      </div>
    </Ctx.Provider>
  );
}

export const useAnnounce = () => useContext(Ctx);
