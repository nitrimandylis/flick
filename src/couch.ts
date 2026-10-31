// `flick couch`: watch together. Starts the room on this computer, opens a
// tunnel to it, and puts films on when the host picks them in the TUI.

import { randomBytes } from "node:crypto";
import type { Engine, Stream } from "./engines.ts";
import { Room } from "./room.ts";
import { loadConfig, recordPlay, saveConfig, touchFilm, trimCache } from "./store.ts";
import { englishSubtitles } from "./subtitles.ts";
import { openUrl } from "./system.ts";
import type { Title } from "./titles.ts";
import { withTrackers, type Torrent } from "./torrents.ts";
import { openTunnel, type Tunnel } from "./tunnel.ts";

// A named tunnel's Cloudflare route points at a fixed local port.
const NAMED_PORT = 8765;

/** A room id: ten random base-36 characters, unguessable. Pure-ish. */
export function newRoomId(): string {
  return [...randomBytes(10)].map((b) => (b % 36).toString(36)).join("");
}

export class Couch {
  room: Room;
  link: string | null = null; // the room's public address, once the tunnel answers
  error: string | null = null;
  private tunnel: Tunnel | null = null;
  private stream: Stream | null = null;
  onUpdate: () => void = () => {};

  private constructor(room: Room) {
    this.room = room;
    room.onChange = () => {
      // The film ended: stop the torrent so nothing uploads during the ratings.
      if (room.state.ended && this.stream) {
        this.stream.stop();
        this.stream = null;
      }
      this.onUpdate();
    };
  }

  /** Start the room and its tunnel. The room id is made once and remembered,
   *  so a bookmark of the room keeps working night after night. */
  static start(): Couch {
    const config = loadConfig();
    if (!config.room) saveConfig({ ...config, room: newRoomId() });
    const { room: id, tunnelToken, tunnelHost } = loadConfig();
    const couch = new Couch(new Room(id!));
    const named = tunnelToken && tunnelHost ? { token: tunnelToken, host: tunnelHost } : undefined;
    couch.room
      .listen(named ? NAMED_PORT : 0)
      .then((port) => openTunnel(port, `/r/${id}`, named))
      .then((tunnel) => {
        couch.tunnel = tunnel;
        couch.link = `${tunnel.url}/r/${id}`;
        openUrl(couch.link); // the host watches in their browser too
        couch.onUpdate();
      })
      .catch((error) => {
        couch.error = error instanceof Error ? error.message : String(error);
        couch.onUpdate();
      });
    return couch;
  }

  /** Put a film on in the room. Resolves once it's streaming. */
  async play(engine: Engine, title: Title, torrent: Torrent, onStatus: (message: string) => void) {
    await this.stopFilm();
    onStatus("finding peers…");
    const stream = await engine.open(withTrackers(torrent.magnet));
    const video = stream.videos[0];
    if (!video || !/\.mp4$/i.test(video.name)) {
      await stream.stop();
      throw new Error(video ? `that source is .${video.name.split(".").pop()}, not .mp4; pick another` : "no video in that torrent");
    }
    onStatus("looking for English subtitles…");
    const sub = stream.subtitles[0];
    const subs = await englishSubtitles(title.id, sub ? { url: stream.urlOf(sub), name: sub.name } : null);
    this.stream = stream;
    recordPlay({ id: title.id, name: title.name, year: title.year, kind: title.kind, poster: title.poster });
    touchFilm(stream.folder);
    trimCache(loadConfig().cacheGB ?? 10, stream.folder);
    this.room.setFilm({ id: title.id, title: title.name, year: title.year ?? undefined }, stream.urlOf(video), subs?.vtt ?? null);
    onStatus(`on in the room${subs ? ", English subtitles available" : ""}`);
  }

  async progress() {
    return this.stream ? this.stream.progress() : null;
  }

  /** Take the film off: the room holds its place, the torrent stops. */
  async stopFilm() {
    if (!this.stream) return;
    const stream = this.stream;
    this.stream = null;
    this.room.stopFilm();
    await stream.stop();
  }

  async close() {
    await this.stopFilm();
    this.tunnel?.stop();
    this.room.close();
  }
}
