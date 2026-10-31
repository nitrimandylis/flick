// Smoke check for the room protocol. Start `bunx wrangler dev`, then: bun check.ts
// Two fake browsers sit down, a fake `cine couch` puts a film on, they play,
// the source drops and comes back, they rate blind, and finish.

function ok(cond: boolean, what: string) {
  if (!cond) throw new Error("failed: " + what);
}

const base = process.env.COUCH_URL ?? "ws://localhost:8787";
const room = "check" + Math.random().toString(36).slice(2, 10);

function seat(id: string, name: string) {
  const ws = new WebSocket(`${base}/r/${room}/ws`);
  const inbox: any[] = [];
  ws.onmessage = (e) => inbox.push(JSON.parse(String(e.data)));
  const opened = new Promise((resolve) => (ws.onopen = resolve));
  const send = (msg: object) => ws.send(JSON.stringify(msg));
  // Wait for the next message matching `test`, ignoring ones already seen.
  let seen = 0;
  async function next(test: (m: any) => boolean) {
    for (let i = 0; i < 100; i++) {
      while (seen < inbox.length) {
        const m = inbox[seen++];
        if (test(m)) return m;
      }
      await Bun.sleep(30);
    }
    throw new Error(`${name}: timed out waiting`);
  }
  return { ws, opened, send, next, hello: () => send({ type: "hello", id, name }) };
}

const a = seat("id-a", "Nick");
const b = seat("id-b", "Guest");
await Promise.all([a.opened, b.opened]);

a.hello();
await a.next((m) => m.type === "state" && m.action === "join");
b.hello();
const peers = await a.next((m) => m.type === "peers" && m.peers.length === 2);
ok(peers.peers.map((p: any) => p.name).sort().join() === "Guest,Nick", "both seated");

const cine = seat("source", "cine");
await cine.opened;
const film = { id: "tt0137523", title: "Fight Club", year: 1999 };
const tunnel = "https://abc-def.trycloudflare.com/token/film.mp4";
cine.send({ type: "source", film, url: tunnel });
const loaded = await b.next((m) => m.type === "state" && m.action === "load");
ok(loaded.state.film.id === "tt0137523" && loaded.state.src.url === tunnel, "the source puts the film on for both");
cine.send({ type: "source", film, url: "https://evil.example.com/x" });

b.send({ type: "set", playing: true, time: 0 });
const played = await a.next((m) => m.type === "state" && m.action === "play");
ok(played.state.playing === true && played.by === "Guest", "play is relayed with a name");
ok(played.state.src.url === tunnel, "a source URL that isn't a quick tunnel is refused");

// The source drops: the film holds, paused. It comes back: same place.
cine.ws.close();
const gone = await a.next((m) => m.type === "state" && m.action === "source-off");
ok(gone.state.src === null && gone.state.playing === false && gone.state.film.id === "tt0137523", "source loss pauses and keeps the film");
const cine2 = seat("source2", "cine");
await cine2.opened;
cine2.send({ type: "source", film, url: tunnel });
const back = await a.next((m) => m.type === "state" && m.action === "source");
ok(back.state.src.url === tunnel && back.state.film.id === "tt0137523", "the same film comes back without resetting");
b.send({ type: "set", playing: true, time: back.state.time });
await a.next((m) => m.type === "state" && m.action === "play");

// An echo that matches the room's state must not produce a broadcast.
a.send({ type: "set", playing: true, time: 0.5 });
b.send({ type: "set", playing: false, time: 42 });
const paused = await a.next((m) => m.type === "state" && m.action !== null);
ok(paused.action === "pause" && paused.state.time === 42, "echo ignored, real pause relayed");

a.send({ type: "ended" });
await b.next((m) => m.type === "state" && m.action === "ended");
a.send({ type: "rate", stars: 4 });
const half = await b.next((m) => m.type === "state" && m.action === "rate");
ok(half.state.ratings[0].stars === null, "a single rating stays hidden");
b.send({ type: "rate", stars: 2 });
const both = await a.next((m) => m.type === "state" && m.action === "rate" && m.state.ratings.length === 2);
ok(both.state.ratings.map((r: any) => r.stars).join() === "4,2", "both ratings revealed");

b.send({ type: "done" });
const done = await a.next((m) => m.type === "state" && m.action === "done");
ok(done.state.film === null && done.state.last.title === "Fight Club", "done empties the room");

a.ws.close();
b.ws.close();
cine2.ws.close();
console.log("check passed");
