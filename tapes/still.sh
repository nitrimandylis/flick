#!/bin/zsh
# The README still. Run from the repo root:  ./tapes/still.sh
#
# flick draws its posters with the kitty graphics protocol, which no headless
# recorder renders (vhs and asciinema come back with empty boxes). So the hero
# is a real screenshot of a real Ghostty window. This script pins everything so
# the next one matches the last one, and needs no clicks:
#
#   - Ghostty 120x34 cells, Cascadia Code NF 16, flick's background (#060A12),
#     from a generated config instead of yours
#   - a throwaway HOME (tapes/fixtures/home), so no real watch history shows
#   - `flick dune`: a search, so the wall is public IMDb data
#   - the window is found by its process id and captured with screencapture
#
# Needs: Ghostty, flick on PATH, and Screen Recording permission for the
# terminal you run this from (else the PNG is blank). Run it from a normal
# desktop, not a full-screen app: the window opens on the current Space, and a
# window on another Space can't be found or captured.

set -e
cd "$(dirname "$0")/.."
mkdir -p .github/assets tapes/fixtures/home/.config/flick
echo '{}' > tapes/fixtures/home/.config/flick/config.json

# Ghostty in ~/Applications or /Applications, whichever has it.
GHOSTTY=$(mdfind "kMDItemCFBundleIdentifier == 'com.mitchellh.ghostty'" | head -1)/Contents/MacOS/ghostty
if [ ! -x "$GHOSTTY" ]; then
  echo "Ghostty isn't installed" >&2
  exit 1
fi
FLICK=$(command -v flick)
FIX="$PWD/tapes/fixtures"

# What the window runs: flick searching "dune", with the throwaway HOME.
cat > "$FIX/run.sh" <<RUN
#!/bin/sh
export HOME="$FIX/home" PATH="$PATH"
exec "$FLICK" dune 2>"$FIX/flick.err"
RUN
chmod +x "$FIX/run.sh"

# Ghostty's settings for the shot, used instead of your own config (so no
# theme, saved tabs or window size of yours leaks in). Font as in the README.
cat > "$FIX/ghostty.conf" <<CONF
font-family = Cascadia Code NF
font-size = 16
background = 060A12
foreground = E8F1F5
window-width = 120
window-height = 34
window-padding-x = 14
window-padding-y = 12
window-save-state = never
confirm-close-surface = false
title = flick
command = $FIX/run.sh
CONF

"$GHOSTTY" --config-default-files=false --config-file="$FIX/ghostty.conf" >/dev/null 2>&1 &
pid=$!

echo "waiting for the posters and details to load..."
sleep 14

# The window that belongs to that Ghostty process. It can take a moment to be
# listed, so ask a few times.
id=""
for try in 1 2 3 4 5 6 7 8 9 10; do
  id=$(swift -e '
import CoreGraphics
let pid = Int(CommandLine.arguments[1])!
let windows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as! [[String: Any]]
for w in windows where (w["kCGWindowOwnerPID"] as? Int) == pid && (w["kCGWindowLayer"] as? Int) == 0 {
  print(w["kCGWindowNumber"]!)
  break
}' "$pid")
  [ -n "$id" ] && break
  sleep 1
done

if [ -z "$id" ]; then
  kill -0 $pid 2>/dev/null || echo "Ghostty closed early; flick said: $(cat "$FIX/flick.err" 2>/dev/null)" >&2
  kill $pid 2>/dev/null
  echo "couldn't find the Ghostty window" >&2
  exit 1
fi

screencapture -l"$id" -o .github/assets/flick.png
kill $pid 2>/dev/null || true
sips --resampleWidth 1600 .github/assets/flick.png >/dev/null
echo "wrote .github/assets/flick.png"
