// Torrent engines: turn a magnet into a local URL a player can stream from.
// rqbit (a separate program, fast) is used when it's installed; webtorrent
// (built into flick) works everywhere with nothing to install.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { FILMS_DIR } from "./store.ts";
import { which } from "./system.ts";

export type FileEntry = { index: number; name: string; bytes: number };

export type Stream = {
  folder: string; // the film's folder inside FILMS_DIR, for the cache cap
  videos: FileEntry[]; // playable videos, largest first
  subtitles: FileEntry[]; // subtitle files shipped in the torrent
  urlOf(file: FileEntry): string; // local http URL that serves the file (with Range)
  progress(): Promise<{ percent: number; downBytesPerSec: number; peers: number }>;
  stop(): Promise<void>; // stop downloading and uploading this torrent
};

export interface Engine {
  name: "rqbit" | "webtorrent";
  open(magnet: string): Promise<Stream>;
  shutdown(): Promise<void>; // called when flick exits: nothing keeps seeding
}

const VIDEO = /\.(mkv|mp4|avi|webm|mov|m4v|ts)$/i;
const SUBTITLE = /\.(srt|vtt|ass|ssa)$/i;

/** Videos big enough to be the film (drops samples and extras), largest first. Pure. */
export function pickVideos(files: FileEntry[]): FileEntry[] {
  return files
    .filter((f) => VIDEO.test(f.name) && f.bytes >= 50_000_000 && !/sample/i.test(f.name))
    .sort((a, b) => b.bytes - a.bytes);
}

/** Subtitle files, English ones first. Pure. */
export function pickSubtitles(files: FileEntry[]): FileEntry[] {
  const english = (name: string) => /\b(en|eng|english)\b/i.test(name) || /\.en\./i.test(name);
  return files.filter((f) => SUBTITLE.test(f.name)).sort((a, b) => Number(english(b.name)) - Number(english(a.name)));
}

// ---------- rqbit ----------

// flick's own rqbit, on its own port, so a rqbit started by another tool is never touched.
const RQBIT = "http://127.0.0.1:3041";

async function rqbitUp(): Promise<boolean> {
  try {
    return (await fetch(`${RQBIT}/`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

class Rqbit implements Engine {
  name = "rqbit" as const;
  private child: ChildProcess | null = null;

  private async ensure() {
    if (await rqbitUp()) return;
    mkdirSync(FILMS_DIR, { recursive: true });
    // No persistence: rqbit forgets torrents when it stops, so the cache cap can
    // delete old films without rqbit trying to fetch them again next time.
    this.child = spawn(
      "rqbit",
      // Its own peer port too (rqbit's default is 4240), so it runs beside another rqbit.
      ["--http-api-listen-addr", "127.0.0.1:3041", "--listen-port", "4247", "--disable-dht-persistence", "server", "start", "--disable-persistence", FILMS_DIR],
      { stdio: "ignore" },
    );
    for (let i = 0; i < 25; i++) {
      if (await rqbitUp()) return;
      await sleep(200);
    }
    throw new Error("rqbit didn't start");
  }

  async open(magnet: string): Promise<Stream> {
    await this.ensure();
    // Adding blocks while rqbit finds the torrent's metadata, so cap it.
    const res = await fetch(`${RQBIT}/torrents?overwrite=true`, {
      method: "POST",
      body: magnet,
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw new Error("rqbit couldn't add that torrent (no seeds?)");
    const json: any = await res.json();
    const id = json.id;
    // A film already in the cache gets re-checked first; streaming before that
    // finishes answers 500. Wait until rqbit says the torrent is live.
    for (let i = 0; i < 150; i++) {
      const stats: any = await fetch(`${RQBIT}/torrents/${id}/stats/v1`)
        .then((r) => r.json())
        .catch(() => ({}));
      if (stats.state === "live" || stats.finished) break;
      await sleep(200);
    }
    const files: FileEntry[] = (json.details?.files ?? []).map((f: any, index: number) => ({
      index,
      name: f.name ?? (f.components ?? []).join("/"),
      bytes: f.length ?? 0,
    }));
    return {
      folder: json.details?.name ?? "",
      videos: pickVideos(files),
      subtitles: pickSubtitles(files),
      urlOf: (file) => `${RQBIT}/torrents/${id}/stream/${file.index}`,
      progress: async () => {
        try {
          const s: any = await (await fetch(`${RQBIT}/torrents/${id}/stats/v1`)).json();
          return {
            percent: s.total_bytes ? Math.floor((100 * s.progress_bytes) / s.total_bytes) : 0,
            downBytesPerSec: (s.live?.download_speed?.mbps ?? 0) * 1024 * 1024,
            peers: s.live?.snapshot?.peer_stats?.live ?? 0,
          };
        } catch {
          return { percent: 0, downBytesPerSec: 0, peers: 0 };
        }
      },
      stop: async () => {
        await fetch(`${RQBIT}/torrents/${id}/forget`, { method: "POST" }).catch(() => {});
      },
    };
  }

  async shutdown() {
    this.child?.kill();
    this.child = null;
    // Port 3041 is flick's own rqbit, so stop it even if an earlier flick that
    // crashed left it running: an orphaned rqbit would keep uploading.
    // Anchored to the program name, so it only ever matches that rqbit.
    spawnSync("pkill", ["-f", "^rqbit --http-api-listen-addr 127.0.0.1:3041"], { stdio: "ignore" });
  }
}

// ---------- webtorrent ----------

class Webtorrent implements Engine {
  name = "webtorrent" as const;
  private client: any = null;
  private base = "";

  private async ensure() {
    if (this.client) return;
    // Loaded only when it is the engine in use: webtorrent needs native parts
    // that some installs never build (bun blocks install scripts), and flick
    // with rqbit must not crash on them.
    let WebTorrent: any;
    try {
      WebTorrent = (await import("webtorrent")).default;
    } catch {
      throw new Error(
        "the built-in engine's native parts aren't installed. Install rqbit (brew install rqbit), or reinstall flick with npm, or run: bun pm -g trust --all",
      );
    }
    this.client = new WebTorrent();
    const server = this.client.createServer({ hostname: "127.0.0.1" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.base = `http://127.0.0.1:${server.server.address().port}/webtorrent`;
  }

  async open(magnet: string): Promise<Stream> {
    await this.ensure();
    mkdirSync(FILMS_DIR, { recursive: true });
    const torrent: any = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no peers sent the torrent's metadata (no seeds?)")), 45_000);
      this.client.add(magnet, { path: FILMS_DIR }, (t: any) => {
        clearTimeout(timer);
        resolve(t);
      });
    });
    const files: FileEntry[] = torrent.files.map((f: any, index: number) => ({ index, name: f.path, bytes: f.length }));
    return {
      folder: torrent.name,
      videos: pickVideos(files),
      subtitles: pickSubtitles(files),
      urlOf: (file) => {
        const path = torrent.files[file.index].path.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
        return `${this.base}/${torrent.infoHash}/${path}`;
      },
      progress: async () => ({
        percent: Math.floor(torrent.progress * 100),
        downBytesPerSec: torrent.downloadSpeed,
        peers: torrent.numPeers,
      }),
      stop: async () => {
        await new Promise<void>((resolve) => torrent.destroy({ destroyStore: false }, () => resolve()));
      },
    };
  }

  async shutdown() {
    if (!this.client) return;
    await new Promise<void>((resolve) => this.client.destroy(() => resolve()));
    this.client = null;
  }
}

/** The engine to use: the configured one, else rqbit if installed, else webtorrent. */
export function pickEngine(choice?: string): Engine {
  if (choice === "webtorrent") return new Webtorrent();
  if (choice === "rqbit" || which("rqbit")) return new Rqbit();
  return new Webtorrent();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
