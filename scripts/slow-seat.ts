// Slow-seat check for flick couch (development only, not shipped).
// Two headless Chromium seats; seat B's network is throttled like a busy
// hotspot. Bug it guards: B fell behind while buffering, the drift loop
// seeked it ahead, the seek re-buffered, and B stalled every few seconds.
// Run with: node scripts/slow-seat.ts (needs rqbit and a global playwright-core)

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { pickEngine } from "../src/engines.ts";
import { Room } from "../src/room.ts";
import { openTunnel } from "../src/tunnel.ts";

const require = createRequire(import.meta.url);
const { chromium } = require(homedir() + "/.bun/install/global/node_modules/playwright-core");

const BBB = "magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const engine = pickEngine("rqbit");
const stream = await engine.open(BBB);
const room = new Room("slowseat01");
const port = await room.listen(0);
const tunnel = await openTunnel(port, "/r/slowseat01");
const link = `${tunnel.url}/r/slowseat01`;
room.setFilm({ id: "tt1254207", title: "Big Buck Bunny", year: 2008 }, stream.urlOf(stream.videos[0]), null);

const browsers: any[] = [];
async function seat(name: string, slow: boolean) {
  const browser = await chromium.launch();
  browsers.push(browser);
  const page = await browser.newPage();
  if (slow) {
    const cdp = await page.context().newCDPSession(page);
    // about 4 Mbit/s down with 300 ms latency: a seek costs seconds to refill
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 300, downloadThroughput: 500_000, uploadThroughput: 500_000 });
  }
  await page.goto(link);
  await page.fill("#name", name);
  await page.click("#sit");
  await page.waitForFunction(() => (document.getElementById("player") as HTMLVideoElement).readyState >= 1, null, { timeout: 60_000 });
  // count stalls and seeks on this seat
  await page.evaluate(`window.n = { waiting: 0, seeking: 0 }; const e = document.getElementById("player"); e.addEventListener("waiting", () => n.waiting++); e.addEventListener("seeking", () => n.seeking++); 1`);
  return page;
}

const A = await seat("A", false);
const B = await seat("B", true);
await A.evaluate(`document.getElementById("player").play()`);
await sleep(90_000);

const stats = (p: any) => p.evaluate(`(() => { const e = document.getElementById("player"); return { t: Math.round(e.currentTime), paused: e.paused, ...n }; })()`);
const a = await stats(A);
const b = await stats(B);
console.log("A", JSON.stringify(a));
console.log("B", JSON.stringify(b));
// B may stall while it first fills, but must not keep seeking itself
const ok = b.seeking <= 2 && Math.abs(a.t - b.t) <= 15;
console.log(ok ? "PASS slow seat keeps playing" : "FAIL slow seat loops");

for (const br of browsers) await br.close();
room.close();
tunnel.stop();
await stream.stop();
process.exit(ok ? 0 : 1);
