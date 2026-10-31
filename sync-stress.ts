// Sync stress test for flick couch (development only, not shipped).
// Runs a real room through a quick tunnel, with Big Buck Bunny as the film,
// and two or three headless Chromium browsers acting on it.
// Run with: node sync-stress.ts

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { pickEngine } from "./src/engines.ts";
import { Room } from "./src/room.ts";
import { openTunnel } from "./src/tunnel.ts";

const require = createRequire(import.meta.url);
const { chromium } = require(homedir() + "/.bun/install/global/node_modules/playwright-core");

const BBB = "magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const engine = pickEngine("rqbit");
const stream = await engine.open(BBB);
const room = new Room("syncstress01");
const port = await room.listen(0);
const tunnel = await openTunnel(port, "/r/syncstress01");
const link = `${tunnel.url}/r/syncstress01`;
room.setFilm({ id: "tt1254207", title: "Big Buck Bunny", year: 2008 }, stream.urlOf(stream.videos[0]), null);
console.log("room:", link);

const LOG = `window.acts = []; ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.type === "state" && m.action) window.acts.push(m.action + " by " + m.by + " @" + Math.round(m.state.time)); }); 1`;
const browser = await chromium.launch();
async function seat(name: string) {
  const page = await browser.newPage();
  await page.goto(link);
  await page.fill("#name", name);
  await page.click("#sit");
  await page.waitForFunction(() => (document.getElementById("player") as HTMLVideoElement).readyState >= 1, null, { timeout: 30_000 });
  await page.evaluate(LOG);
  return page;
}
const v = (page: any) =>
  page.evaluate(() => {
    const el = document.getElementById("player") as HTMLVideoElement;
    return { t: el.currentTime, paused: el.paused };
  });
const run = (page: any, js: string) => page.evaluate(js);

let failures = 0;
/** A seek must stick: the room is where the jump plus the time played since
 *  says it should be (within 3 s), not dragged back by anyone. */
function stuck(name: string, target: number, jumpedAt: number) {
  const now = room.state.playing ? room.state.time + (Date.now() - room.state.at) / 1000 : room.state.time;
  const expected = target + (room.state.playing ? (Date.now() - jumpedAt) / 1000 : 0);
  if (Math.abs(now - expected) <= 3) console.log(`PASS ${name}: room at ${now.toFixed(1)} s, expected ~${expected.toFixed(1)} s`);
  else {
    failures++;
    console.log(`FAIL ${name}: room at ${now.toFixed(1)} s, expected ~${expected.toFixed(1)} s`);
  }
}
let jumpedAt = 0;
/** Wait until every page agrees with the room (paused or playing) and with
 *  each other on position, within `tolerance` seconds. Reports how long it took. */
async function converged(name: string, pages: any[], tolerance: number, within = 12_000) {
  const start = Date.now();
  let last: any[] = [];
  while (Date.now() - start < within) {
    last = await Promise.all(pages.map(v));
    const roomPlaying = room.state.playing;
    const statesOk = last.every((s) => s.paused === !roomPlaying);
    const spread = Math.max(...last.map((s) => s.t)) - Math.min(...last.map((s) => s.t));
    if (statesOk && spread <= tolerance) {
      console.log(`PASS ${name}: ${((Date.now() - start) / 1000).toFixed(1)} s to agree, spread ${spread.toFixed(2)} s, room ${roomPlaying ? "playing" : "paused"}`);
      return;
    }
    await sleep(250);
  }
  failures++;
  console.log(`FAIL ${name}: room ${room.state.playing ? "playing" : "paused"}, seats ${JSON.stringify(last.map((s) => `${s.t.toFixed(1)} ${s.paused ? "paused" : "playing"}`))}`);
}

const A = await seat("Nick");
const B = await seat("Guest");
const vid = `document.getElementById('player')`;

// 1. basics from each side
await run(A, `${vid}.play()`);
await converged("A plays", [A, B], 1.5);
await run(B, `${vid}.pause()`);
await converged("B pauses", [A, B], 0.3);
await run(B, `${vid}.currentTime = 120`);
await converged("B seeks while paused", [A, B], 0.3);
await run(A, `${vid}.play()`);
await sleep(2000);
await run(A, `${vid}.currentTime = 300`);
jumpedAt = Date.now();
await converged("A seeks while playing", [A, B], 1.5);
stuck("A's seek while playing sticks", 300, jumpedAt);

// 2. rapid toggling: pause/play five times, 150 ms apart
for (let i = 0; i < 5; i++) {
  await run(A, `${vid}.pause()`);
  await sleep(150);
  await run(A, `${vid}.play()`);
  await sleep(150);
}
await converged("rapid pause/play x5", [A, B], 1.5);

// 3. dragging the seek bar: ten seeks 100 ms apart
for (let i = 0; i < 10; i++) {
  await run(B, `${vid}.currentTime = ${350 + i * 5}`);
  jumpedAt = Date.now();
  await sleep(100);
}
await converged("seek-bar drag (10 seeks)", [A, B], 1.5);
stuck("the drag ends where it was let go", 395, jumpedAt);

// 4. both act at the same moment, opposite intentions
await Promise.all([run(A, `${vid}.pause()`), run(B, `${vid}.currentTime = 420`)]);
await converged("simultaneous pause + seek", [A, B], 1.5);
await run(A, `${vid}.play()`);
await sleep(1000);
await Promise.all([run(A, `${vid}.pause()`), run(B, `${vid}.pause()`)]);
await converged("both pause together", [A, B], 0.5);
await Promise.all([run(A, `${vid}.play()`), run(B, `${vid}.play()`)]);
await converged("both play together", [A, B], 1.5);

// 5. a third person joins mid-film
const C = await seat("Third");
await converged("late joiner while playing", [A, B, C], 2);
await C.close();

// 6. B reloads the page mid-film
await B.reload();
await B.fill("#name", "Guest").catch(() => {});
await B.click("#sit");
await sleep(500);
await converged("B reloads the page", [A, B], 2, 20_000);

// 7. B's connection drops; A seeks while B is gone; B reconnects
await run(B, `ws.close()`); // room.js reconnects after 1.5 s
await run(A, `${vid}.currentTime = 500`);
jumpedAt = Date.now();
await converged("B reconnects after A seeked", [A, B], 2, 15_000);
stuck("A's seek during B's outage sticks", 500, jumpedAt);

// 8. nothing should echo while just playing for 20 s (fresh logs: B's socket is new)
await Promise.all([A, B].map((p) => p.evaluate(LOG)));
const before = [0, 0];
await sleep(20_000);
// a reconnect announcing itself ("join") isn't a playback action
const after = await Promise.all([A, B].map((p) => p.evaluate(() => (window as any).acts.filter((a: string) => !a.startsWith("join")).length)));
const echoes = after[0] - before[0] + (after[1] - before[1]);
if (echoes === 0) console.log("PASS 20 s of playing: no stray actions");
else {
  failures++;
  const detail = await Promise.all([A, B].map((p) => p.evaluate(() => (window as any).acts.slice(-3))));
  console.log(`FAIL 20 s of playing: ${echoes} stray actions, last actions per seat ${JSON.stringify(detail)}`);
}
await converged("still together after 20 s", [A, B], 1.5);

// 9. B's connection crawls for 10 s (a bad hotspot moment), then recovers
const cdp = await B.context().newCDPSession(B);
await cdp.send("Network.enable");
await run(A, `${vid}.currentTime = 560`); // a fresh spot, so B has to download
jumpedAt = Date.now();
await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 800, downloadThroughput: 20_000, uploadThroughput: 20_000 });
await sleep(10_000);
const stalled = await Promise.all([A, B].map(v));
console.log(`     during the crawl: A ${stalled[0].t.toFixed(1)} s, B ${stalled[1].t.toFixed(1)} s`);
await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await converged("B catches up after its connection recovers", [A, B], 1.5, 20_000);
stuck("A's seek before the crawl sticks (B's late catch-up doesn't rewind A)", 560, jumpedAt);

// 10. the end: both land on the details page
await run(A, `${vid}.currentTime = ${vid}.duration - 3`);
await sleep(10_000);
const ends = await Promise.all([A, B].map((p) => p.evaluate(() => !document.getElementById("after")!.hidden)));
if (ends.every(Boolean)) console.log("PASS film end: both on the details page");
else {
  failures++;
  const players = await Promise.all([A, B].map((p) => p.evaluate(`(() => { const e = document.getElementById("player"); return { t: e.currentTime, dur: e.duration, paused: e.paused, ended: e.ended, ready: e.readyState, rate: e.playbackRate }; })()`)));
  console.log(`FAIL film end: details page shown ${JSON.stringify(ends)}; room ${JSON.stringify({ ended: room.state.ended, playing: room.state.playing, time: room.state.time })}; players ${JSON.stringify(players)}`);
}

console.log(failures ? `${failures} FAILED` : "ALL PASSED");
await browser.close();
room.close();
tunnel.stop();
await stream.stop();
await engine.shutdown();
process.exit(failures ? 1 : 0);
