// Headless smoke test against a running dev server.  node scripts/smoke.mjs [url]
// Checks: start gate, Play starts audio (analyser sees signal), Explore freezes the video and
// Escape resumes it, wheel zoom, night mode, collapsed player does not overlap the stage,
// every visualization loads, no console errors. SHOT=out.png saves screenshots.
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:3000/";
const chrome = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const shot = process.env.SHOT;
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--use-gl=angle", "--window-size=1600,1000"] /* no autoplay override: the gate must unlock audio itself */ });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
// "glGetProgramiv: Program object expected": logged once per react-bits background (Galaxy,
// Topography) while their shaders compile under headless software GL; they render correctly.
const errors = [];
page.on("console", (m) => (m.type() === "error" || m.type() === "warn") && !/speechSynthesis|voice\/manifest|AudioContext was not allowed|glGetProgramiv: Program object expected/.test(m.text()) && errors.push(`${m.type()}: ${m.text()}`));
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const snap = async (name) => shot && (await page.screenshot({ path: shot.replace(".png", `-${name}.png`) }));
const results = {};
const check = (name, ok, detail = "") => {
  results[name] = ok ? "ok" : `FAIL ${detail}`;
};

await page.goto(url, { waitUntil: "networkidle0", timeout: 120000 });
await page.waitForSelector(".gate", { timeout: 60000 });
await snap("gate");
await page.click(".gate .pill-btn"); // start silently (no speech in CI)
await page.waitForSelector(".drawer .play-btn", { timeout: 60000 });
await page.click(".drawer .play-btn");
await page.waitForFunction(() => window.__jukebox?.hasStems, { timeout: 90000 });
await wait(4000);
const audio = await page.evaluate(() => {
  const e = window.__jukebox;
  let peak = 0;
  for (let i = 0; i < 10; i++) peak = Math.max(peak, ...(e?.spectrum?.(16) ?? [0]));
  return { playing: e?.playing, peak, ctx: e?.contextState, videoPaused: document.querySelector("video")?.paused };
});
check("audio plays", audio.playing && audio.peak > 0 && audio.ctx === "running" && !audio.videoPaused, JSON.stringify(audio));
await snap("light");

// Explore freezes the frame
await page.keyboard.press("e");
await wait(600);
const t0 = await page.evaluate(() => document.querySelector("video").currentTime);
await wait(1200);
const frozen = await page.evaluate(() => ({ t: document.querySelector("video").currentTime, paused: document.querySelector("video").paused, playing: window.__jukebox.playing }));
check("explore freezes", frozen.paused && !frozen.playing && Math.abs(frozen.t - t0) < 0.01, JSON.stringify(frozen));
await page.keyboard.press("2"); // row tool
await page.keyboard.press("Enter");
await wait(800);
check("row sweep sounds", await page.evaluate(() => window.__jukebox.sweeping));
await snap("explore");
await page.keyboard.press("Escape");
await wait(1200);
check("escape resumes", await page.evaluate(() => !document.querySelector("video").paused && window.__jukebox.playing));

// zoom with the wheel
const box = await page.$eval(".globe", (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.move(box.x, box.y);
for (let i = 0; i < 4; i++) await page.mouse.wheel({ deltaY: -200 });
await wait(400);
const zoom = await page.$eval(".globe", (el) => Number(el.dataset.zoom));
check("wheel zoom", zoom > 1.5, `zoom=${zoom}`);
await page.keyboard.press("0");

// night mode toggles (M), and the galaxy canvas only exists in dark mode
const theme0 = await page.evaluate(() => document.documentElement.dataset.theme);
await page.keyboard.press("m");
await wait(1500);
const theme1 = await page.evaluate(() => ({ t: document.documentElement.dataset.theme, galaxy: !!document.querySelector("canvas.galaxy") }));
check("night mode", theme1.t !== theme0 && theme1.galaxy === (theme1.t === "dark"), JSON.stringify({ theme0, theme1 }));
await snap(theme1.t);

// collapsed player: nothing overlaps the stage
await page.click(".drawer-head .round");
await wait(400);
const overlap = await page.evaluate(() => {
  const s = document.querySelector(".obs-stage").getBoundingClientRect();
  const hits = [];
  for (const el of document.querySelectorAll(".mini-player, .drawer, .site-header")) {
    const r = el.getBoundingClientRect();
    if (r.width && r.left < s.right && r.right > s.left && r.top < s.bottom && r.bottom > s.top) hits.push(el.className);
  }
  return hits;
});
check("collapsed: no overlap", overlap.length === 0, overlap.join(","));
await snap("collapsed");

// every visualization loads
const ids = await page.$$eval(".viz-select option", (o) => o.map((x) => x.value));
for (const id of ids) {
  await page.select(".viz-select select", id);
  await wait(2500);
  const ok = await page.evaluate(() => !!document.querySelector(".obs-title")?.textContent);
  check(`viz ${id}`, ok);
  await snap(`viz-${id}`);
}

console.log(JSON.stringify(results, null, 1));
console.log(errors.length ? errors.join("\n") : "no console errors");
await browser.close();
process.exit(Object.values(results).every((v) => v === "ok") && !errors.length ? 0 : 1);
