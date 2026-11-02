---
name: flick-cli
description: Help the user watch films and shows with flick, the terminal app that searches a title, picks a torrent and streams it, or runs `flick couch` to watch a film together in sync with someone far away through a browser link. Use when the user wants to watch a film or episode, stream a torrent, set up a long-distance watch party or movie night, asks about flick or flick couch, or flick misbehaves (no peers, no posters, a couch link that won't open).
---

# flick

`flick` is a full-screen terminal UI. **An agent cannot drive it.** Every mode
draws on the terminal and waits for keys, so a tool call hangs until it times
out. Hand the user the command to run instead, and help with setup and
problems around it.

## Setup

- Install: `npm i -g @nitrimandylis/flick` (or `bun add -g`, or run once with
  `npx @nitrimandylis/flick`). Needs Node 22+. If `flick` is not on PATH, it
  has not been installed: offer the install line.
- Optional, better: `brew install rqbit` (faster engine; otherwise the built-in
  webtorrent is used) and IINA or mpv as the player (otherwise the browser).
- Settings: `~/.config/flick/config.json` with `engine`, `player`, `cacheGB`,
  `dub`, and for couch `room`, `tunnelToken`, `tunnelHost`. **`tunnelToken` is
  a secret: never read, print or write it.** Tell the user the key name and
  let them set it.

## Commands to hand the user

| Want | Command |
| --- | --- |
| Browse and search | `flick` |
| Jump to a title | `flick dune` |
| Watch together | `flick couch` or `flick couch dune` |
| Pick the engine or player | `--engine rqbit\|webtorrent`, `--player iina\|mpv\|vlc\|browser` |
| Anime with dual audio | `--dub` |

The only commands safe to run from a tool call: `flick --help`, `flick --version`.

Inside flick: type to search, `←→` move along the posters, `⏎` open or play,
`tab` switch section, `esc` back, paste a magnet to play it, `c` copies the
couch room link while a film is on, `ctrl-c` quits.

## flick couch

- flick serves the room page, the sync and the film from the host's computer
  through a Cloudflare tunnel and prints a link. The other person opens it in
  a desktop browser. Nothing to install on their side.
- Films only, and only MP4 with H.264 (every browser plays those). Releases
  that don't qualify are hidden with a count; solo flick still plays them.
- Default address: a new random `*.trycloudflare.com` each run. For a fixed
  one, the user creates a named Cloudflare tunnel routed to
  `http://127.0.0.1:8765` and sets `tunnelToken` and `tunnelHost`.
- The film streams from the host's upload. The playing screen says whether the
  upload keeps up with the film's bitrate ("keeping up" / "may buffer").

## Things that will bite you

- **A brand-new trycloudflare link can 404 for a few seconds** while the name
  publishes; flick waits until it answers before printing it.
- **No peers**: old or rare releases. Pick one with more seeders (the list
  colours seeders green, amber, red).
- **Posters only in kitty or Ghostty on macOS.** Elsewhere the wall shows cards
  with titles. That is expected, not broken.
- **flick never seeds after a film closes** and quits rqbit on exit; a crashed
  session may leave `rqbit --http-api-listen-addr 127.0.0.1:3041` running.
- **No ratings anywhere**, by design.

## What it cannot do

No subscriptions or paid services, no downloads to keep (the cache is capped at
`cacheGB`, least recently watched removed first), no shows in couch. The couch room is made for a desktop browser.
