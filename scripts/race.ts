// Race repro for flick couch (development only, not shipped): both seats pause
// together, then play together, 30 times; the room must end up playing. On a
// failure it prints what the room received. Run with: node scripts/race.ts

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
const room = new Room("syncstress01");
const port = await room.listen(0);
const tunnel = await openTunnel(port, "/r/syncstress01");
const link = `${tunnel.url}/r/syncstress01`;
room.setFilm({ id: "tt1254207", title: "Big Buck Bunny", year: 2008 }, stream.urlOf(stream.videos[0]), null);
console.log("room:", link);

const LOG = `window.acts = []; ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.type === "state" && m.action) window.acts.push(m.action + " by " + m.by + " @" + Math.round(m.state.time)); }); 1`;
// One browser per seat, like two people on two computers: tabs sharing one
// browser fight over audio focus, and Chrome pauses one when the other plays.
const browsers: any[] = [];
async function seat(name: string) {
  const browser = await chromium.launch();
  browsers.push(browser);
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
await run(A, `${vid}.play()`);
await converged("start", [A, B], 1.5);
const T0 = Date.now();
const srv: string[] = [];
const r: any = room;
const realMessage = r.message.bind(r), realLeave = r.leave.bind(r), realConnect = r.connect.bind(r);
r.message = (ws: any, raw: string) => { const m = JSON.parse(raw); if (m.type !== "pos") srv.push(`${Date.now() - T0} recv ${r.seats.get(ws)?.name ?? "?"} ${raw}`); realMessage(ws, raw); if (m.type === "set") srv.push(`${Date.now() - T0}   -> room playing=${r.state.playing}`); };
r.leave = (ws: any) => { srv.push(`${Date.now() - T0} CLOSE ${r.seats.get(ws)?.name ?? "?"}`); realLeave(ws); };
r.connect = (ws: any) => { srv.push(`${Date.now() - T0} CONNECT`); realConnect(ws); };
for (let i = 1; i <= 30; i++) {
  srv.push(`${Date.now() - T0} ===== round ${i}`);
  await Promise.all([A, B].map((p) => p.evaluate(LOG)));
  await Promise.all([run(A, `${vid}.pause()`), run(B, `${vid}.pause()`)]);
  await sleep(1500);
  await Promise.all([run(A, `${vid}.play()`), run(B, `${vid}.play()`)]);
  await sleep(2500);
  const acts = await A.evaluate(() => (window as any).acts);
  console.log(`round ${i}: room ${room.state.playing ? "PLAYING" : "PAUSED "}`);
  if (!room.state.playing) {
    console.log(srv.slice(-12).join("\n"));
    break;
  }
}
for (const b of browsers) await b.close();
room.close();
tunnel.stop();
await stream.stop();
await engine.shutdown();
process.exit(0);
