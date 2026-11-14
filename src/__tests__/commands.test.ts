import { describe, expect, it } from "vitest";
import { matchPlace, normalise, parseAlternatives, parseCommand } from "@/voice/commands";

const kind = (s: string) => parseCommand(s);

describe("voice commands", () => {
  it("playback", () => {
    expect(kind("play")).toEqual({ kind: "play" });
    expect(kind("Pause, please")).toEqual({ kind: "pause" });
    expect(kind("stop")).toEqual({ kind: "pause" });
    expect(kind("next")).toEqual({ kind: "vizStep", step: 1 });
    expect(kind("go back")).toEqual({ kind: "vizStep", step: -1 });
    expect(kind("resume")).toEqual({ kind: "resume" });
  });
  it("visualizations by name, with misheard words", () => {
    expect(kind("ocean")).toEqual({ kind: "viz", id: "sst" });
    expect(kind("show me the night lights")).toEqual({ kind: "viz", id: "nightlights" });
    expect(kind("lightening")).toEqual({ kind: "viz", id: "lightning" });
    expect(kind("go to aerosols")).toEqual({ kind: "viz", id: "aerosols" });
    expect(kind("Earth")).toEqual({ kind: "viz", id: "earth" });
    expect(kind("light").kind).toBe("ambiguous");
  });
  it("specific phrases win over short words", () => {
    expect(kind("stop exploring")).toEqual({ kind: "explore", on: false });
    expect(kind("night mode")).toEqual({ kind: "theme", dark: true });
    expect(kind("light mode")).toEqual({ kind: "theme", dark: false });
    expect(kind("next frame")).toEqual({ kind: "frame", step: 1 });
    expect(kind("previous frame")).toEqual({ kind: "frame", step: -1 });
  });
  it("explore tools and movement", () => {
    expect(kind("explore")).toEqual({ kind: "explore", on: true });
    expect(kind("explorer")).toEqual({ kind: "explore", on: true });
    expect(kind("row")).toEqual({ kind: "tool", tool: "hline" });
    expect(kind("column")).toEqual({ kind: "tool", tool: "vline" });
    expect(kind("box")).toEqual({ kind: "tool", tool: "box" });
    expect(kind("whole map")).toEqual({ kind: "wholeMap" });
    expect(kind("scan")).toEqual({ kind: "run" });
    expect(kind("north")).toEqual({ kind: "move", dir: "north", steps: 1 });
    expect(kind("far west")).toEqual({ kind: "move", dir: "west", steps: 5 });
    expect(kind("go south three")).toEqual({ kind: "move", dir: "south", steps: 3 });
  });
  it("view and sound", () => {
    expect(kind("zoom in")).toEqual({ kind: "zoom", step: 1 });
    expect(kind("zoom out")).toEqual({ kind: "zoom", step: -1 });
    expect(kind("reset zoom")).toEqual({ kind: "zoom", step: 0 });
    expect(kind("louder")).toEqual({ kind: "volume", step: 1 });
    expect(kind("turn it down")).toEqual({ kind: "volume", step: -1 });
    expect(kind("slower")).toEqual({ kind: "speed", step: -1 });
    expect(kind("legend")).toEqual({ kind: "legend" });
    expect(kind("describe")).toEqual({ kind: "describe", on: true });
    expect(kind("descriptions off")).toEqual({ kind: "describe", on: false });
  });
  it("where, go to, repeat, help", () => {
    expect(kind("where am I")).toEqual({ kind: "where" });
    expect(kind("go to France")).toEqual({ kind: "goto", place: "france" });
    expect(kind("take me to Niger")).toEqual({ kind: "goto", place: "niger" });
    expect(kind("repeat that")).toEqual({ kind: "repeat" });
    expect(kind("what can I say")).toEqual({ kind: "help" });
    expect(kind("banana").kind).toBe("unknown");
  });
  it("uses the first recognizer alternative that matches", () => {
    expect(parseAlternatives(["zoo min", "zoom in"]).command).toEqual({ kind: "zoom", step: 1 });
  });
  it("normalises filler and punctuation", () => {
    expect(normalise("Um, zoom IN please!")).toBe("zoom in");
  });
  it("matches spoken places to country names", () => {
    const names = ["France", "United States of America", "United Kingdom", "Niger", "Nigeria", "India"];
    expect(matchPlace("france", names)).toBe("France");
    expect(matchPlace("america", names)).toBe("United States of America");
    expect(matchPlace("england", names)).toBe("United Kingdom");
    expect(matchPlace("niger", names)).toBe("Niger");
    expect(matchPlace("nigeria", names)).toBe("Nigeria");
    expect(matchPlace("indiaa", names)).toBe("India");
    expect(matchPlace("atlantis", names)).toBeNull();
  });
});
