// flick's visual pieces, themed as a cinema: a marquee sign with chasing
// bulbs, viewfinder panels, programme tabs, a film-strip progress bar and
// ticket-stub key hints. Colours are flick's neon cyan (the couch room page's)
// with warm marquee bulbs.

import { Box, Text } from "ink";
import { useEffect, useState, type ReactNode } from "react";

export const C = {
  accent: "#3DF5FF", // couch's cyan
  bright: "#9FFBFF",
  deep: "#1B6FA8",
  text: "#E8F1F5",
  mute: "#7D8A9A",
  rule: "#4A5A6E",
  bulb: "#FFD27A", // a lit marquee bulb
  good: "#7BE3A8",
  warn: "#FFB86B",
  bad: "#FF3DCB", // couch's magenta
  ink: "#060A12", // text on a coloured chip
};

/** A colour partway between two "#RRGGBB" colours (`t` from 0 to 1). Pure. */
export function mix(from: string, to: string, t: number): string {
  let out = "#";
  for (let i = 1; i < 7; i += 2) {
    const a = parseInt(from.slice(i, i + 2), 16);
    const b = parseInt(to.slice(i, i + 2), 16);
    out += Math.round(a + (b - a) * t)
      .toString(16)
      .padStart(2, "0");
  }
  return out;
}

/** A number that goes up every `ms` while `on`, for small animations. */
function useTick(ms: number, on: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(timer);
  }, [ms, on]);
  return tick;
}

// ---------- the marquee ----------

const WORD = ["█▀▀ █   █ █▀▀ █▄▀", "█▀  █▄▄ █ █▄▄ █ █"];
const MARQUEE_WIDTH = WORD[0].length + 6; // a bulb, two spaces, the word, two spaces, a bulb

/** Where the bulbs sit around the sign, in order clockwise from the top left,
 *  as [row, column]. Rows 0 and 3 are the top and bottom edges. Pure. */
export function bulbPath(width: number): [number, number][] {
  const path: [number, number][] = [];
  for (let col = 0; col < width; col += 2) path.push([0, col]); // top, left to right
  path.push([1, width - 1], [2, width - 1]); // right side, down
  for (let col = width - 1; col >= 0; col -= 2) path.push([3, col]); // bottom, right to left
  path.push([2, 0], [1, 0]); // left side, up
  return path;
}

/** The flick sign: the word inside a frame of bulbs. With `chase`, every third
 *  bulb is lit and the lit ones run around the frame. */
export function Marquee({ chase = false }: { chase?: boolean }) {
  const tick = useTick(350, chase);
  const lit = new Map<string, boolean>();
  bulbPath(MARQUEE_WIDTH).forEach(([row, col], i) => lit.set(`${row},${col}`, (i + (chase ? tick : 0)) % 3 === 0));

  const bulb = (row: number, col: number) => {
    const on = lit.get(`${row},${col}`);
    return (
      <Text key={col} color={on ? C.bulb : C.rule}>
        {on ? "●" : "○"}
      </Text>
    );
  };
  const edge = (row: number) => {
    const cells = [];
    for (let col = 0; col < MARQUEE_WIDTH; col++) cells.push(col % 2 === 0 || col === MARQUEE_WIDTH - 1 ? bulb(row, col) : <Text key={col}> </Text>);
    return <Text>{cells}</Text>;
  };

  return (
    <Box flexDirection="column" flexShrink={0}>
      {edge(0)}
      {WORD.map((line, i) => (
        <Text key={i}>
          {bulb(i + 1, 0)}
          {"  "}
          <Text bold color={i === 0 ? C.bright : C.accent}>
            {line}
          </Text>
          {"  "}
          {bulb(i + 1, MARQUEE_WIDTH - 1)}
        </Text>
      ))}
      {edge(3)}
    </Box>
  );
}

// ---------- viewfinder panels ----------

/** A panel in a thin square frame, its title set into the top line:
 *  ┌─ Title · 3 ───────┐ */
export function Viewfinder(props: { title: string; count?: number; width: number; height?: number; focused?: boolean; children: ReactNode }) {
  const line = props.focused ? C.accent : C.rule;
  const label = props.count === undefined ? props.title : `${props.title} · ${props.count}`;
  const rest = Math.max(0, props.width - 3 - label.length - 2);
  return (
    <Box flexDirection="column" width={props.width} flexShrink={0}>
      <Text wrap="truncate">
        <Text color={line}>{"┌─ "}</Text>
        <Text color={props.focused ? C.accent : C.text} bold>
          {label}
        </Text>
        <Text color={line}>{` ${"─".repeat(rest)}┐`}</Text>
      </Text>
      <Box
        flexDirection="column"
        borderStyle="single"
        borderTop={false}
        borderColor={line}
        paddingX={1}
        height={props.height === undefined ? undefined : Math.max(2, props.height - 1)}
        overflow="hidden"
      >
        {props.children}
      </Box>
    </Box>
  );
}

// ---------- programme tabs ----------

/** The home screen's sections, like a cinema programme: the showing one lit. */
export function Tabs({ tabs, active }: { tabs: { label: string; count?: number }[]; active: string }) {
  return (
    <Text wrap="truncate">
      {tabs.map((tab, i) => {
        const on = tab.label === active;
        const text = ` ${tab.label.toUpperCase()}${tab.count ? ` ${tab.count}` : ""} `;
        return (
          <Text key={tab.label}>
            {i ? <Text color={C.rule}> · </Text> : null}
            {on ? (
              <Text backgroundColor={C.accent} color={C.ink} bold>
                {text}
              </Text>
            ) : (
              <Text color={C.mute}>{text}</Text>
            )}
          </Text>
        );
      })}
    </Text>
  );
}

// ---------- the film strip ----------

/** A download shown as a strip of film: one frame per 3 columns, frames filling
 *  in as the film arrives, sprocket holes above and below that roll while it
 *  downloads. */
export function FilmStrip({ percent, width, rolling }: { percent: number; width: number; rolling: boolean }) {
  const tick = useTick(150, rolling);
  const frames = Math.max(4, Math.floor(width / 3));
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * frames);
  const shift = rolling ? tick % 3 : 0;
  const holes = " ▪ ".repeat(frames + 1).slice(shift, shift + frames * 3);
  const cells = [];
  for (let i = 0; i < frames; i++) {
    const color = i < filled ? mix(C.deep, C.accent, i / Math.max(1, frames - 1)) : C.rule;
    cells.push(
      <Text key={i} color={color}>
        {i < filled ? "██" : "░░"}{" "}
      </Text>,
    );
  }
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text color={C.mute}>{holes}</Text>
      <Text>{cells}</Text>
      <Text color={C.mute}>{holes}</Text>
    </Box>
  );
}

// ---------- ticket-stub key hints ----------

export type Hint = [keys: string, label: string];

/** Key hints as little tickets: the key on a cyan stub, then what it does. */
export function Tickets({ hints, message }: { hints: Hint[]; message?: string }) {
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
          {i ? "  " : ""}
          <Text backgroundColor={C.accent} color={C.ink} bold>
            {` ${keys} `}
          </Text>
          <Text color={C.mute}> {label}</Text>
        </Text>
      ))}
    </Text>
  );
}
