#!/usr/bin/env node
// flick: search a film, pick a torrent, watch it now.

import { render } from "ink";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Couch } from "./couch.ts";
import { pickEngine } from "./engines.ts";
import { installedPlayers, pickPlayer } from "./players.ts";
import { loadConfig } from "./store.ts";
import { which } from "./system.ts";
import { App } from "./ui.tsx";

const VERSION = "0.1.2";

const HELP = `flick ${VERSION}: search a film, pick a torrent, watch it now

usage:
  flick                     open flick: continue watching, trending, search
  flick <title>             open flick already searching for <title>
  flick couch [title]       watch together: films play in a room in both your
                            browsers, in sync; flick prints the room's link

options:
  --engine rqbit|webtorrent   torrent engine (default: rqbit if installed, else webtorrent)
  --player iina|mpv|vlc|browser
                              player (default: the first one installed, in that order)
  --dub                       anime: prefer dual-audio releases
  -h, --help                  this help
  -v, --version               the version

Settings live in ~/.config/flick/config.json (engine, player, cacheGB, dub).
couch rooms run on this computer through a free Cloudflare quick tunnel (a new
address each time). For one fixed address, create a named Cloudflare tunnel
routed to http://127.0.0.1:8765 and set tunnelToken and tunnelHost there.
Films are cached in ~/.cache/flick, capped at 10 GB by default; the least
recently watched go first. Nothing keeps uploading once a film is closed.`;

type Args = { query: string; engine?: string; player?: string; dub: boolean; couch: boolean };

/** Command-line arguments into options. Unknown flags are an error. Pure. */
export function parseArgs(argv: string[]): Args | { error: string } | "help" | "version" {
  const args: Args = { query: "", dub: false, couch: false };
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") return "help";
    if (arg === "-v" || arg === "--version") return "version";
    if (arg === "--dub") args.dub = true;
    else if (arg === "--engine" || arg === "--player") {
      const value = argv[++i];
      if (!value) return { error: `${arg} needs a value` };
      if (arg === "--engine") args.engine = value;
      else args.player = value;
    } else if (arg.startsWith("-")) return { error: `unknown option ${arg} (see flick --help)` };
    else words.push(arg);
  }
  if (words[0] === "couch") {
    args.couch = true;
    words.shift();
  }
  args.query = words.join(" ");
  return args;
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === "help") return console.log(HELP);
  if (parsed === "version") return console.log(VERSION);
  if ("error" in parsed) {
    console.error(parsed.error);
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const engineChoice = parsed.engine ?? config.engine;
  if (engineChoice && engineChoice !== "rqbit" && engineChoice !== "webtorrent") {
    console.error(`unknown engine "${engineChoice}": use rqbit or webtorrent`);
    process.exitCode = 1;
    return;
  }
  if (engineChoice === "rqbit" && !which("rqbit")) {
    console.error("rqbit isn't installed (brew install rqbit), or use --engine webtorrent");
    process.exitCode = 1;
    return;
  }
  const playerChoice = parsed.player ?? config.player;
  if (playerChoice && !installedPlayers().includes(playerChoice as never)) {
    console.error(`player "${playerChoice}" isn't installed here. Installed: ${installedPlayers().join(", ")}`);
    process.exitCode = 1;
    return;
  }
  if (!process.stdin.isTTY) {
    console.error("flick needs an interactive terminal");
    process.exitCode = 1;
    return;
  }

  const engine = pickEngine(engineChoice);
  const couch = parsed.couch ? Couch.start() : undefined;
  // Closing the terminal window (or a kill) must not leave a torrent uploading
  // or a tunnel open.
  for (const signal of ["SIGHUP", "SIGTERM"] as const) {
    process.on(signal, async () => {
      await couch?.close().catch(() => {});
      await engine.shutdown().catch(() => {});
      process.exit(0);
    });
  }

  render(
    <App
      engine={engine}
      player={pickPlayer(playerChoice)}
      cacheGB={config.cacheGB ?? 10}
      dub={parsed.dub || Boolean(config.dub)}
      initialQuery={parsed.query}
      couch={couch}
    />,
    { alternateScreen: true, exitOnCtrlC: false },
  );
}

// Run only when started as a program, not when imported by a test. A plain
// path compare first, then real paths (npm's bin is a symlink).
function startedDirectly(): boolean {
  const self = fileURLToPath(import.meta.url);
  const started = process.argv[1] ?? "";
  if (started === self) return true;
  try {
    return realpathSync(started) === realpathSync(self);
  } catch {
    return false;
  }
}

if (startedDirectly()) main();
