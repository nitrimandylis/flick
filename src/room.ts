// The couch room, served from the host's computer: the page, the WebSocket
// relay that keeps everyone's play, pause and seek in step, and the film itself.
// It all lives on one local port; a Cloudflare tunnel makes it reachable.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { filmDetails } from "./details.ts";
import { CONFIG_DIR } from "./store.ts";

type Film = { id: string; title: string; year?: number }; // id is the IMDb id
type Rating = { name: string; stars: number };

export type RoomState = {
  film: Film | null;
  src: { url: string; subs: string | null } | null; // null while no film is streaming
  playing: boolean;
  time: number; // seconds into the film at moment `at`
  at: number; // ms timestamp when `time` was recorded
  ended: boolean;
  ratings: Record<string, Rating>; // keyed by browser id
  last: { title: string; finished: number } | null;
};

export type Seat = { id: string; name: string };

// Each room remembers its last film and ratings in its own file.
const ROOMS_DIR = join(CONFIG_DIR, "rooms");

// The room's page and assets ship next to the built CLI: dist/flick.js -> ../room
const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "room");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

export function emptyState(): RoomState {
  return { film: null, src: null, playing: false, time: 0, at: 0, ended: false, ratings: {}, last: null };
}

/** Where the film should be right now, according to the room. Pure. */
export function currentTime(s: RoomState, now = Date.now()): number {
  return s.playing ? s.time + (now - s.at) / 1000 : s.time;
}

/** A play/pause/seek report from a browser: the action it means, or null when
 *  it only echoes what the room already believes. Changes `s` in place. */
export function applySet(s: RoomState, playing: boolean, time: number, now = Date.now()): "play" | "pause" | "seek" | null {
  if (!s.film || s.ended) return null;
  if (playing === s.playing && Math.abs(time - currentTime(s, now)) < 2) return null;
  const action = playing !== s.playing ? (playing ? "play" : "pause") : "seek";
  s.playing = playing;
  s.time = Math.max(0, time);
  s.at = now;
  return action;
}

/** Two people pressing play and pause at the same moment: the later press was
 *  made before its browser saw the first one land (`seen` is the last revision
 *  that browser had), so the first one stands. `last` is the latest play/pause
 *  change: who made it and at which revision. Pure. */
export function crossedToggle(last: { by: string; rev: number } | null, by: string, seen: number): boolean {
  return last !== null && last.by !== by && seen < last.rev;
}

export class Room {
  readonly id: string;
  state: RoomState;
  private seats = new Map<WebSocket, Seat>();
  private sockets = new Set<WebSocket>();
  private lastPos: number | null = null; // last position someone reported
  private lastToggle: { by: string; rev: number } | null = null; // latest play/pause change
  private rev = 0; // goes up with every change the room broadcasts
  private filmUrl: string | null = null; // the engine's local stream URL
  private vtt: string | null = null;
  private server: Server;
  sentBytes = 0;
  lastChange: { action: string; by: string } | null = null; // "paused by Kat", for the TUI
  onChange: () => void = () => {}; // the TUI redraws who is here and what's sent

  private statePath: string;

  constructor(id: string) {
    this.id = id;
    this.statePath = join(ROOMS_DIR, `${id}.json`);
    const saved = existsSync(this.statePath) ? JSON.parse(readFileSync(this.statePath, "utf-8")) : {};
    // A saved room never has a stream: that only exists while flick runs.
    this.state = { ...emptyState(), ...saved, src: null, playing: false };
    const wss = new WebSocketServer({ noServer: true });
    this.server = createServer((req, res) => this.http(req, res));
    this.server.on("upgrade", (req, socket, head) => {
      if (req.url !== `/r/${this.id}/ws`) return socket.destroy();
      wss.handleUpgrade(req, socket, head, (ws) => this.connect(ws));
    });
  }

  listen(port = 0): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(port, "127.0.0.1", () => {
        const address = this.server.address();
        resolve(address && typeof address === "object" ? address.port : 0);
      });
    });
  }

  close() {
    for (const ws of this.sockets) ws.close();
    this.server.close();
  }

  people(): string[] {
    return [...this.seats.values()].map((s) => s.name);
  }

  // ---------- what's on ----------

  /** Put a film on: a new film starts from the top; the same film again (the
   *  host restarted it) keeps its place. */
  setFilm(film: Film, filmUrl: string, vtt: string | null) {
    const s = this.state;
    this.filmUrl = filmUrl;
    this.vtt = vtt;
    // The key changes with every stream so browsers reload the new one.
    const key = Date.now().toString(36);
    s.src = { url: `/r/${this.id}/film.mp4?v=${key}`, subs: vtt ? `/r/${this.id}/subs.vtt?v=${key}` : null };
    let action = "source";
    if (!s.film || s.film.id !== film.id || s.ended) {
      s.film = film;
      s.playing = false;
      s.time = 0;
      s.at = Date.now();
      s.ended = false;
      s.ratings = {};
      action = "load";
    }
    this.save();
    this.broadcast(this.stateMessage(action, null));
  }

  /** The film's stream stopped (the host closed it): hold it where it is. */
  stopFilm() {
    const s = this.state;
    this.filmUrl = null;
    if (!s.src) return;
    s.src = null;
    if (s.playing) {
      s.time = this.lastPos ?? currentTime(s);
      s.playing = false;
      s.at = Date.now();
    }
    this.save();
    this.broadcast(this.stateMessage("source-off", null));
  }

  // ---------- the relay ----------

  private connect(ws: WebSocket) {
    this.sockets.add(ws);
    ws.send(JSON.stringify(this.stateMessage(null, null))); // the gate shows tonight's film
    ws.on("message", (raw) => this.message(ws, String(raw)));
    ws.on("close", () => this.leave(ws));
    ws.on("error", () => this.leave(ws));
  }

  private message(ws: WebSocket, raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const s = this.state;

    if (msg.type === "hello") {
      const seat = { id: String(msg.id || "").slice(0, 64), name: String(msg.name || "").trim().slice(0, 24) || "Someone" };
      this.seats.set(ws, seat);
      ws.send(JSON.stringify(this.stateMessage("join", seat)));
      this.broadcast({ type: "peers", peers: [...this.seats.values()] });
      this.onChange();
      return;
    }
    const seat = this.seats.get(ws);
    if (!seat) return; // everything below needs a seated browser

    if (msg.type === "pos") {
      this.lastPos = Number(msg.time) || 0;
      this.toOthers(ws, { type: "pos", id: seat.id, name: seat.name, time: this.lastPos, playing: !!msg.playing });
      return;
    }
    if (msg.type === "pull") {
      // the person ahead asks the person behind to jump to them
      const time = Math.max(0, Number(msg.time) || 0);
      s.time = time;
      s.at = Date.now();
      this.save();
      this.toOthers(ws, { type: "pull", name: seat.name, time, playing: !!msg.playing, now: Date.now() });
      return;
    }

    let action: string | null = null;
    if (msg.type === "set") {
      if (!!msg.playing !== s.playing && crossedToggle(this.lastToggle, seat.id, Number(msg.rev) || 0)) {
        ws.send(JSON.stringify(this.stateMessage(null, null))); // the late browser follows the room
        return;
      }
      action = applySet(s, !!msg.playing, Number(msg.time) || 0);
      if (action === "play" || action === "pause") this.lastToggle = { by: seat.id, rev: this.rev + 1 }; // the broadcast below
    } else if (msg.type === "ended" && s.film && !s.ended) {
      s.ended = true;
      s.playing = false;
      action = "ended";
    } else if (msg.type === "rate" && s.ended) {
      const stars = Math.round(Number(msg.stars));
      if (stars >= 1 && stars <= 5) {
        s.ratings[seat.id] = { name: seat.name, stars };
        action = "rate";
      }
    } else if (msg.type === "done" && s.ended && s.film) {
      s.last = { title: s.film.title, finished: Date.now() };
      s.film = null;
      s.src = null;
      s.ended = false;
      s.ratings = {};
      action = "done";
    }
    if (!action) return;
    this.lastChange = { action, by: seat.name };
    this.save();
    this.broadcast(this.stateMessage(action, seat));
    this.onChange();
  }

  private leave(ws: WebSocket) {
    if (!this.sockets.delete(ws)) return;
    this.seats.delete(ws);
    this.broadcast({ type: "peers", peers: [...this.seats.values()] });
    // Last one out: freeze the film where it was, so next time resumes there.
    if (this.seats.size === 0 && this.state.playing) {
      this.state.time = this.lastPos ?? currentTime(this.state);
      this.state.playing = false;
      this.state.at = Date.now();
      this.save();
    }
    this.onChange();
  }

  /** Ratings stay hidden until both people have rated. */
  stateMessage(action: string | null, seat: Seat | null) {
    if (action) this.rev++;
    const ratings = Object.values(this.state.ratings);
    const revealed = ratings.length >= 2;
    return {
      type: "state",
      state: { ...this.state, ratings: ratings.map((r) => ({ name: r.name, stars: revealed ? r.stars : null })) },
      raters: Object.keys(this.state.ratings),
      action,
      rev: this.rev,
      by: seat?.name ?? null,
      byId: seat?.id ?? null,
      now: Date.now(),
    };
  }

  private broadcast(msg: object) {
    const text = JSON.stringify(msg);
    for (const ws of this.sockets) if (ws.readyState === ws.OPEN) ws.send(text);
  }

  private toOthers(from: WebSocket, msg: object) {
    const text = JSON.stringify(msg);
    for (const [ws] of this.seats) if (ws !== from && ws.readyState === ws.OPEN) ws.send(text);
  }

  private save() {
    mkdirSync(ROOMS_DIR, { recursive: true });
    const { src, ...rest } = this.state; // the stream never outlives flick
    writeFileSync(this.statePath, JSON.stringify(rest));
  }

  // ---------- http ----------

  private async http(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? "/", "http://room").pathname;
    const room = `/r/${this.id}`;
    try {
      if (path === room || path === `${room}/`) return this.file(res, "room.html");
      if (path === `${room}/film.mp4`) return await this.film(req, res);
      if (path === `${room}/subs.vtt` && this.vtt) {
        res.writeHead(200, { "content-type": "text/vtt; charset=utf-8", "cache-control": "no-store" });
        return res.end(this.vtt);
      }
      const details = path.match(/^\/api\/film\/(tt\d+)$/);
      if (details) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(await filmDetails(details[1])));
      }
      // The page's own assets. Anything else (other rooms, guessing) is a 404.
      if (/^\/(style\.css|room\.js|favicon\.svg|fonts\/[a-z0-9-]+\.woff2)$/.test(path)) return this.file(res, path.slice(1));
    } catch {
      if (!res.headersSent) res.writeHead(500);
      return res.end();
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not here");
  }

  private file(res: ServerResponse, name: string) {
    const full = normalize(join(ASSETS, name));
    if (!full.startsWith(ASSETS) || !existsSync(full)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-type": TYPES[extname(full)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(readFileSync(full));
  }

  /** The film, passed through from the torrent engine, Range requests and all. */
  private async film(req: IncomingMessage, res: ServerResponse) {
    if (!this.filmUrl) {
      res.writeHead(404);
      return res.end();
    }
    const abort = new AbortController();
    req.on("close", () => abort.abort()); // a seek drops the old request
    const range = req.headers.range;
    const upstream = await fetch(this.filmUrl, { headers: range ? { range } : {}, signal: abort.signal });
    // no-store: on a named tunnel Cloudflare caches .mp4 by default, and would try
    // to pull the whole film into its cache before answering the first request.
    const headers: Record<string, string> = { "content-type": "video/mp4", "accept-ranges": "bytes", "cache-control": "no-store" };
    for (const name of ["content-range", "content-length"]) {
      const value = upstream.headers.get(name);
      if (value) headers[name] = value;
    }
    res.writeHead(upstream.status, headers);
    if (!upstream.body || req.method === "HEAD") return res.end();
    const body = Readable.fromWeb(upstream.body as any);
    body.on("data", (chunk: Buffer) => (this.sentBytes += chunk.length));
    body.on("error", () => res.destroy());
    body.pipe(res);
  }
}
