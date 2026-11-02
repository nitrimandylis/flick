// flick's visual pieces: the logo, panels, the progress bar, the key hints.
// The look follows torlink (github.com/baairon/torlink, MIT): a gradient
// block logo with one accent glyph, panels titled in their border, a sheen
// that sweeps across the progress bar. Colours are flick's own neon cyan,
// the same as the couch room page.

import { Box, Text } from "ink";
import { useEffect, useState, type ReactNode } from "react";

export const C = {
  accent: "#3DF5FF", // couch's cyan
  bright: "#9FFBFF",
  deep: "#1B6FA8",
  text: "#E8F1F5",
  mute: "#7D8A9A",
  rule: "#4A5A6E",
  good: "#86D6A2",
  warn: "#F0C560",
  bad: "#FF3DCB", // couch's magenta
};

// ---------- colour maths ----------

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The colour `t` of the way from `a` to `b` (t from 0 to 1). Pure. */
export function lerpHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  const mix = (x: number, y: number) =>
    Math.round(x + (y - x) * t)
      .toString(16)
      .padStart(2, "0");
  return `#${mix(ar, br)}${mix(ag, bg)}${mix(ab, bb)}`;
}

// ---------- the logo ----------

// Row 0 holds the accent glyph, a magenta spark over the I.
const LOGO = [
  "        ✦        ",
  "█▀▀ █   █ █▀▀ █▄▀",
  "█▀  █▄▄ █ █▄▄ █ █",
];

/** The logo's sheen: white at the top left, through cyan, to deep blue at the
 *  bottom right. `t` runs from 0 to 1. Pure. */
function sheen(t: number): string {
  if (t < 0.15) return lerpHex("#FFFFFF", C.bright, t / 0.15);
  if (t < 0.45) return lerpHex(C.bright, C.accent, (t - 0.15) / 0.3);
  return lerpHex(C.accent, C.deep, (t - 0.45) / 0.55);
}

export function Logo() {
  return (
    <Box flexDirection="column" flexShrink={0}>
      {LOGO.map((line, row) => (
        <Box key={row}>
          {[...line].map((ch, i) => {
            if (ch === " ") return <Text key={i}> </Text>;
            if (row === 0) {
              return (
                <Text key={i} bold color={C.bad}>
                  {ch}
                </Text>
              );
            }
            const across = i / (line.length - 1);
            const down = row - 1; // 0 or 1
            return (
              <Text key={i} bold color={sheen((across + down) / 2)}>
                {ch}
              </Text>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}

export function Rule({ width }: { width: number }) {
  return <Text color={C.rule}>{"─".repeat(Math.max(0, width))}</Text>;
}

// ---------- panels ----------

/** A box with its title set into the top border: ╭─ Title (5) ───╮ */
export function Panel(props: { title: string; count?: number; width: number; height?: number; focused?: boolean; children: ReactNode }) {
  const color = props.focused ? C.accent : C.rule;
  const label = props.count === undefined ? props.title : `${props.title} (${props.count})`;
  const fill = Math.max(0, props.width - 5 - label.length);
  return (
    <Box flexDirection="column" width={props.width} flexShrink={0}>
      <Text wrap="truncate">
        <Text color={color}>{"╭─ "}</Text>
        <Text bold color={props.focused ? C.accent : C.text}>
          {label}
        </Text>
        <Text color={color}>{` ${"─".repeat(fill)}╮`}</Text>
      </Text>
      <Box
        width={props.width}
        height={props.height === undefined ? undefined : Math.max(1, props.height - 1)}
        flexDirection="column"
        borderStyle="round"
        borderTop={false}
        borderColor={color}
        paddingX={1}
        overflow="hidden"
      >
        {props.children}
      </Box>
    </Box>
  );
}

// ---------- the progress bar ----------

// A bright bell sweeps across the filled cells while the download runs.
const SHEEN_RADIUS = 4.5; // half-width of the bell, in cells
const SHEEN_GAP = 8; // dark cells between sweeps
const SHEEN_TICK_MS = 80; // one frame; slower than torlink's 40 ms to spare the battery
const SHEEN_SPEED = 0.6; // cells per frame

/** How bright cell `i` is when the bell is centred at `center` (0 to 0.9). Pure. */
export function sheenIntensity(i: number, center: number): number {
  const d = Math.abs(i - center);
  if (d >= SHEEN_RADIUS) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * d) / SHEEN_RADIUS)) * 0.9;
}

export function ProgressBar({ percent, width, animate }: { percent: number; width: number; animate: boolean }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!animate) return;
    const timer = setInterval(() => setTick((n) => n + 1), SHEEN_TICK_MS);
    return () => clearInterval(timer);
  }, [animate]);

  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width);
  const period = width + SHEEN_RADIUS * 2 + SHEEN_GAP;
  const center = ((tick * SHEEN_SPEED) % period) - SHEEN_RADIUS;
  const cells = [];
  for (let i = 0; i < filled; i++) {
    let color = lerpHex(C.deep, C.accent, i / Math.max(1, width - 1));
    if (animate) color = lerpHex(color, "#F2FFFF", sheenIntensity(i, center));
    cells.push(
      <Text key={i} color={color}>
        █
      </Text>,
    );
  }
  return (
    <Text>
      {cells}
      <Text color={C.rule}>{"░".repeat(width - filled)}</Text>
    </Text>
  );
}

// ---------- key hints ----------

export type Hint = [keys: string, label: string];

export function Footer({ hints, message }: { hints: Hint[]; message?: string }) {
  if (message) {
    return (
      <Text color={C.accent} wrap="truncate">
        {message}
      </Text>
    );
  }
  return (
    <Text wrap="truncate">
      {hints.map(([keys, label], i) => (
        <Text key={keys + label}>
          {i ? "   " : ""}
          <Text color={C.accent}>{keys}</Text>
          <Text color={C.mute}> {label}</Text>
        </Text>
      ))}
    </Text>
  );
}

// ---------- the sidebar ----------

export function Sidebar({ items, active, width }: { items: { label: string; count?: number }[][]; active: string; width: number }) {
  return (
    <Box flexDirection="column" width={width} flexShrink={0} marginTop={1}>
      {items.map((group, g) => (
        <Box key={g} flexDirection="column" marginTop={g ? 1 : 0}>
          {group.map((item) => {
            const on = item.label === active;
            return (
              <Text key={item.label} wrap="truncate">
                <Text color={C.accent}>{on ? "▌ " : "  "}</Text>
                <Text color={on ? C.accent : C.mute} bold={on}>
                  {item.label}
                </Text>
                {item.count ? <Text color={C.mute}> ({item.count})</Text> : null}
              </Text>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}
