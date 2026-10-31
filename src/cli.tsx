#!/usr/bin/env node
// flick: search a film, pick a torrent, watch it now.

import { render } from "ink";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pickEngine } from "./engines.ts";
import { installedPlayers, pickPlayer } from "./players.ts";
import { loadConfig } from "./store.ts";
import { which } from "./system.ts";
import { App } from "./ui.tsx";

const VERSION = "0.1.0";

const HELP = `flick ${VERSION}: search a film, pick a torrent, watch it now

usage:
  flick                     open flick: continue watching, trending, search
  flick <title>             open flick already searching for <title>

options:
  --engine rqbit|webtorrent   torrent engine (default: rqbit if installed, else webtorrent)
  --player iina|mpv|vlc|browser
                              player (default: the first one installed, in that order)
  --dub                       anime: prefer dual-audio releases
  -h, --help                  this help
  -v, --version               the version

Settings live in ~/.config/flick/config.json (engine, player, cacheGB, dub).
Films are cached in ~/.cache/flick, capped at 10 GB by default; the least
recently watched go first. Nothing keeps uploading once a film is closed.`;

type Args = { query: string; engine?: string; player?: string; dub: boolean };

/** Command-line arguments into options. Unknown flags are an error. Pure. */
export function parseArgs(argv: string[]): Args | { error: string } | "help" | "version" {
  const args: Args = { query: "", dub: false };
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
  // Closing the terminal window (or a kill) must not leave a torrent uploading.
  for (const signal of ["SIGHUP", "SIGTERM"] as const) {
    process.on(signal, () => {
      engine.shutdown().finally(() => process.exit(0));
    });
  }

  render(
    <App
      engine={engine}
      player={pickPlayer(playerChoice)}
      cacheGB={config.cacheGB ?? 10}
      dub={parsed.dub || Boolean(config.dub)}
      initialQuery={parsed.query}
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
