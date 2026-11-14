import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countryLookup, type CountriesFile } from "@/data/load";
import { plain, segments, SCRIPT } from "@/voice/guide";
import { TOOLS } from "@/audio/explore";

describe("region lookup (still maps)", () => {
  it("decodes the run-length raster", () => {
    // 4 x 2 world: west half = A, east half = B, bottom-right = none
    const c: CountriesFile = { w: 4, h: 2, names: ["A", "B"], labels: [], rle: [1, 2, 2, 2, 1, 2, 0, 2] };
    const at = countryLookup(c);
    expect(at(45, -135)).toBe("A");
    expect(at(45, 45)).toBe("B");
    expect(at(-45, 135)).toBeNull();
    expect(at(45, 225)).toBe("A"); // longitudes wrap: 225 E = 135 W
  });
  const file = "public/data/earth/countries.json";
  it.skipIf(!existsSync(file))("finds real countries in the Earth atlas", () => {
    const at = countryLookup(JSON.parse(readFileSync(file, "utf8")) as CountriesFile);
    expect(at(48.86, 2.35)).toBe("France");
    expect(at(-15.8, -47.9)).toBe("Brazil");
    expect(at(28.6, 77.2)).toBe("India");
    expect(at(0, -140)).toBeNull(); // Pacific
  });
});

describe("voice guide script", () => {
  it("splits inline reference tones out of the spoken text", () => {
    const s = segments("A low note {tone:low} and a high one. {tone:high} Done.");
    expect(s).toEqual([
      { text: "A low note", toneAfter: 0 },
      { text: "and a high one.", toneAfter: 1 },
      { text: "Done.", toneAfter: null },
    ]);
    expect(plain("A {tone:low} B")).toBe("A B");
  });
  it("has an intro, a key list and an Explore intro", () => {
    for (const id of ["intro", "keys", "explore"] as const) expect(SCRIPT[id].length).toBeGreaterThan(100);
  });
  it("every visualization in the index has its own spoken intro", () => {
    const idx = JSON.parse(readFileSync("public/data/index.json", "utf8")) as { datasets: { id: string }[] };
    for (const d of idx.datasets) expect(SCRIPT[`ds-${d.id}` as keyof typeof SCRIPT], d.id).toBeTruthy();
  });
  it("the key list mentions every Explore tool key", () => {
    for (const t of TOOLS) expect(SCRIPT.explore).toContain(t.label);
  });
});
