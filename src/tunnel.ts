// Making the room reachable from anywhere, through Cloudflare.
// Default: an anonymous quick tunnel with a random *.trycloudflare.com address,
// no account needed. With a named tunnel set up (config: tunnelToken + tunnelHost),
// the room keeps one fixed address instead.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { bin, install } from "cloudflared";

export type Tunnel = { url: string; stop(): void };

/** cloudflared's binary, downloaded on first use if npm's install step didn't. */
async function cloudflaredBinary(): Promise<string> {
  if (!existsSync(bin)) await install(bin);
  return bin;
}

/** Run a command without blocking: the room answering our own checks lives in
 *  this same process, so a synchronous wait would deadlock it. */
function run(cmd: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => resolve(out.trim()));
    child.on("error", () => resolve(""));
  });
}

/** Whether a brand-new quick tunnel answers yet. Asks trycloudflare.com's own
 *  nameservers, never a caching resolver: any resolver asked before Cloudflare
 *  publishes the name (about 6 s) remembers "no such name" for minutes, and
 *  that could be the one the other person's browser uses. */
async function quickTunnelAnswers(url: string): Promise<boolean> {
  const host = new URL(url).hostname;
  const nameserver = (await run(["dig", "+short", "NS", "trycloudflare.com"])).split("\n")[0];
  if (!nameserver) return false;
  const ip = (await run(["dig", "+short", `@${nameserver}`, host, "A"])).split("\n")[0];
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const code = await run(["curl", "-s", "-o", "/dev/null", "-m", "5", "-w", "%{http_code}", "--resolve", `${host}:443:${ip}`, url]);
  return code === "200";
}

/** Read cloudflared's log until it prints the quick tunnel's address, then keep
 *  draining it (a full pipe would stall cloudflared). Pure-ish: just a stream reader. */
function addressFromLog(child: ChildProcess): Promise<string | null> {
  return new Promise((resolve) => {
    let log = "";
    const timer = setTimeout(() => resolve(null), 30_000);
    child.stderr?.on("data", (chunk) => {
      log += chunk;
      const found = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (found) {
        clearTimeout(timer);
        resolve(found[0]);
      }
    });
    child.on("exit", () => resolve(null));
  });
}

/** Open a tunnel to the room on `port`. `roomPath` is "/r/<id>", used to check
 *  the room really answers through the tunnel before anyone is told the link. */
export async function openTunnel(port: number, roomPath: string, named?: { token: string; host: string }): Promise<Tunnel> {
  const binary = await cloudflaredBinary();

  if (named) {
    // The named tunnel's address routes to this port in its Cloudflare config.
    const child = spawn(binary, ["tunnel", "--no-autoupdate", "run", "--token", named.token], { stdio: "ignore" });
    const url = `https://${named.host}`;
    for (let i = 0; i < 30; i++) {
      try {
        if ((await fetch(url + roomPath, { signal: AbortSignal.timeout(4000) })).ok) return { url, stop: () => child.kill() };
      } catch {}
      await sleep(1000);
    }
    child.kill();
    throw new Error(`the named tunnel to ${named.host} didn't answer; check its route points at this computer`);
  }

  const child = spawn(binary, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "ignore", "pipe"] });
  const url = await addressFromLog(child);
  if (!url) {
    child.kill();
    throw new Error("cloudflared didn't open a tunnel; check the internet connection");
  }
  for (let i = 0; i < 40; i++) {
    if (await quickTunnelAnswers(url + roomPath)) return { url, stop: () => child.kill() };
    await sleep(1000);
  }
  child.kill();
  throw new Error("the tunnel opened but never answered; try again");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
