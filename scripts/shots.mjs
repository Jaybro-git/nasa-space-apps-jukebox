// UI screenshots for layout review: node scripts/shots.mjs <out-dir> [url]
// Captures the start gate (both themes), observatory light/dark, jukebox open/collapsed,
// "How it sounds", Explore, the zoomed Earth atlas and a phone-width view.
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const out = process.argv[2] ?? "shots";
const url = process.argv[3] ?? "http://localhost:3000/";
mkdirSync(out, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--use-gl=angle"] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
const shot = (n) => page.screenshot({ path: `${out}/${n}.png` });
const theme = async (t) => {
  await page.evaluate((t) => localStorage.setItem("jukebox-theme", t), t);
};

await page.goto(url, { waitUntil: "networkidle0" });
for (const t of ["light", "dark"]) {
  await theme(t);
  await page.reload({ waitUntil: "networkidle0" });
  await wait(3500);
  await shot(`gate-${t}`);
}
await page.click(".gate .pill-btn");
await wait(2500);
await shot("dark-observatory");
await page.keyboard.press("m");
await wait(1500);
await shot("light-observatory");
await page.click(".drawer-head .round");
await wait(800);
await shot("light-collapsed");
await page.click(".rail-open");
await wait(500);
await page.click("#tab-notes");
await wait(1200);
await shot("light-notes");
await page.keyboard.press("m");
await wait(1500);
await shot("dark-notes");
await page.click("#tab-observe");
await page.keyboard.press("e");
await wait(1500);
await shot("dark-explore");
await page.keyboard.press("Escape");
await page.select(".viz-select select", "earth");
await wait(2500);
for (let i = 0; i < 4; i++) await page.keyboard.press("+");
await wait(2500);
await shot("dark-earth-zoom");
await page.setViewport({ width: 390, height: 844, isMobile: true });
await wait(1500);
await shot("mobile");
const sw = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
console.log("mobile scrollWidth/innerWidth", sw);
await browser.close();
