// Players: hand a stream URL (and maybe a subtitle file) to something that
// plays video. IINA, mpv and VLC are separate apps; "browser" is a small page
// flick serves itself, so there is always a way to watch.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { openUrl, which } from "./system.ts";

export type PlayerName = "iina" | "mpv" | "vlc" | "browser";

export type Playing = {
  closed: Promise<void>; // resolves when the player window is closed
  stop(): void; // close it from flick's side
};

/** The app's binary, checking PATH and both Applications folders. */
function appBinary(program: string, app: string, inside: string): string | null {
  const onPath = which(program);
  if (onPath) return onPath;
  for (const root of ["/Applications", join(homedir(), "Applications")]) {
    const path = join(root, app, inside);
    if (existsSync(path)) return path;
  }
  return null;
}

function iinaBinary() {
  return appBinary("iina", "IINA.app", "Contents/MacOS/iina-cli");
}
function vlcBinary() {
  return appBinary("vlc", "VLC.app", "Contents/MacOS/VLC");
}

/** Players that can run on this machine, best first. "browser" is always there. */
export function installedPlayers(): PlayerName[] {
  const list: PlayerName[] = [];
  if (iinaBinary()) list.push("iina");
  if (which("mpv")) list.push("mpv");
  if (vlcBinary()) list.push("vlc");
  list.push("browser");
  return list;
}

/** The configured player if it's installed, else the best one that is. */
export function pickPlayer(choice?: string): PlayerName {
  const installed = installedPlayers();
  return installed.includes(choice as PlayerName) ? (choice as PlayerName) : installed[0];
}

export type Film = { url: string; title: string; subtitle: string | null; vtt: string | null };

export function play(player: PlayerName, film: Film): Playing {
  if (player === "browser") return playInBrowser(film);
  const args: string[] = [];
  let binary: string;
  if (player === "iina") {
    binary = iinaBinary()!;
    args.push("--no-stdin", `--mpv-force-media-title=${film.title}`);
    if (film.subtitle) args.push(`--mpv-sub-files=${film.subtitle}`);
  } else if (player === "mpv") {
    binary = which("mpv")!;
    args.push(`--force-media-title=${film.title}`);
    if (film.subtitle) args.push(`--sub-file=${film.subtitle}`);
  } else {
    binary = vlcBinary()!;
    args.push(`--meta-title=${film.title}`);
    if (film.subtitle) args.push(`--sub-file=${film.subtitle}`);
  }
  args.push(film.url);
  const child = spawn(binary, args, { stdio: "ignore" });

  // mpv and VLC run until their window closes. IINA's helper returns at once,
  // so watch the IINA app itself and treat it quitting as the film closing.
  const closed =
    player === "iina"
      ? waitForAppToQuit("IINA")
      : new Promise<void>((resolve) => child.on("exit", () => resolve()));
  return {
    closed,
    stop: () => {
      if (player === "iina") spawnSync("osascript", ["-e", 'quit app "IINA"']);
      else child.kill();
    },
  };
}

async function waitForAppToQuit(name: string) {
  await sleep(3000); // let it start first
  while (spawnSync("pgrep", ["-x", name]).status === 0) await sleep(2000);
}

// ---------- the browser player ----------

/** A page with one <video> filling the window, served from this machine. */
export function playerPage(title: string, hasSubtitles: boolean): string {
  const safe = title.replace(/[<&"]/g, "");
  const track = hasSubtitles ? '<track kind="subtitles" srclang="en" label="English" src="/subs.vtt" default>' : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${safe}</title>
<style>html,body{margin:0;height:100%;background:#000}video{width:100%;height:100%}</style></head>
<body><video src="/film" controls autoplay>${track}</video></body></html>`;
}

function playInBrowser(film: Film): Playing {
  // The page and the subtitles come from here; /film redirects to the engine's
  // stream, so seeking (Range requests) goes straight to the engine.
  const server: Server = createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(playerPage(film.title, Boolean(film.vtt)));
    } else if (req.url === "/film") {
      res.writeHead(302, { location: film.url });
      res.end();
    } else if (req.url === "/subs.vtt" && film.vtt) {
      res.writeHead(200, { "content-type": "text/vtt; charset=utf-8" });
      res.end(film.vtt);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  let finish = () => {};
  const closed = new Promise<void>((resolve) => (finish = resolve));
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address && typeof address === "object") openUrl(`http://127.0.0.1:${address.port}/`);
  });
  // A browser tab can't tell flick it closed, so the film ends when you stop it in flick.
  return {
    closed,
    stop: () => {
      server.close();
      finish();
    },
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
