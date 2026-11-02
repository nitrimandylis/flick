# flick

Search a film or a show, pick a source, watch. Torrents streamed from your
own computer, in a full-screen terminal UI. `flick couch` watches a film with
someone far away, in sync, without screen sharing.

## What it is

- **Search first:** titles come from IMDb, then sources for the one you
  pick (YTS and EZTV by IMDb id, The Pirate Bay, Knaben, Nyaa for anime).
  Pasting a magnet plays it straight away.
- **Two panes:** the list on the left, details on the right for whatever is
  highlighted: poster (kitty graphics, in kitty and Ghostty on macOS), year,
  runtime, genres, director, cast and plot; an episode's plot and air date;
  a source's full release name, size, seeders, codec and audio. Under 100
  columns the pane hides.
- **Home:** continue watching, then trending films and shows.
- **Sources:** flick's pick on top (1080p x264 under 6 GB, the most seeders),
  then grouped by resolution. Results stream in as each site answers, with
  a status per site.
- **No ratings anywhere**, on purpose: the film gets judged fresh.
- **Pluggable:** engine rqbit if installed, else webtorrent (built in).
  Player IINA, then mpv, then VLC, then the browser. Series play solo.
- **Cache:** 10 GB cap, least recently watched evicted. Nothing seeds after
  flick closes.

## flick couch

`flick couch [title]` serves the room page, the play/pause/seek sync and the
film from the host's computer through a Cloudflare tunnel: a named tunnel on
a fixed address if one is configured (Nick: couch.nicktrim.com), otherwise a
random trycloudflare address. The other person opens one link in a desktop
browser, nothing to install. Couch offers only files every browser plays
(MP4, H.264) and hides the rest with a count.

The playing screen shows who is in the room, where the room is ("paused by
Kat at 1:02:13"), and whether the host's upload keeps up with the film;
`c` copies the room link. At the end both rate the film 1 to 5, blind.

Voice stays outside: an audio-only call, headphones on.

## Releases

npm package `@nitrimandylis/flick`. 0.1.0 goes up by hand (npm can only attach
a trusted publisher to a package that exists). From 0.1.1 every release is a
GitHub release: `.github/workflows/publish.yml` publishes it through OIDC, so
no token and no local clone are needed.

## Where it is headed

- A still PNG for the README (posters are kitty graphics, so vhs can't record
  them), made by a committed `tapes/still.sh`.
- Couch for shows, if MP4 H.264 TV releases turn out to be common enough.
