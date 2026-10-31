import { DurableObject } from "cloudflare:workers";

// One room per bookmark. The Room object holds the shared playback state and
// relays events between the two browsers over WebSockets. The film itself comes
// from `cine couch` on the host's Mac, which joins as a "source" (not a seat)
// and tells the room what is on and where to stream it from.

type Film = { id: string; title: string; year?: number }; // id is the IMDb id
// Where the browsers fetch the film and its subtitles: the tunnel.
type Src = { url: string; subs: string | null };
type Rating = { name: string; stars: number };

type State = {
  film: Film | null;
  src: Src | null; // null while cine couch is not running
  playing: boolean;
  time: number; // seconds into the film at moment `at`
  at: number; // server ms timestamp when `time` was recorded
  ended: boolean;
  ratings: Record<string, Rating>; // keyed by browser id
  last: { title: string; finished: number } | null;
};

type Seat = { id: string; name: string };
type Source = { source: true };

function isSeat(attachment: unknown): attachment is Seat {
  return !!attachment && typeof (attachment as Seat).name === "string";
}

function isSource(attachment: unknown): attachment is Source {
  return !!attachment && (attachment as Source).source === true;
}

// A stream URL must be a Cloudflare quick tunnel.
function streamUrl(value: unknown): string | null {
  const url = String(value ?? "");
  if (/^https:\/\/[a-z0-9-]+\.trycloudflare\.com\//.test(url)) return url.slice(0, 300);
  return null;
}

const ROOM_ID = /^[a-z0-9]{6,32}$/;

function emptyState(): State {
  return { film: null, src: null, playing: false, time: 0, at: 0, ended: false, ratings: {}, last: null };
}

// Where the film should be right now, according to the room.
function currentTime(s: State): number {
  if (!s.playing) return s.time;
  return s.time + (Date.now() - s.at) / 1000;
}

export class Room extends DurableObject<Env> {
  state: State = emptyState();
  lastPos: number | null = null; // last position someone reported, used when everyone leaves

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.state = { ...emptyState(), ...(await ctx.storage.get<State>("state")) };
    });
  }

  async fetch(): Promise<Response> {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    // Send the state right away so the entry gate can show tonight's film.
    pair[1].send(JSON.stringify(this.stateMessage(null, null)));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    let msg: any;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    const s = this.state;
    const attachment = ws.deserializeAttachment();

    if (msg.type === "hello") {
      const name = String(msg.name || "").trim().slice(0, 24) || "Someone";
      const id = String(msg.id || "").slice(0, 64);
      ws.serializeAttachment({ id, name });
      ws.send(JSON.stringify(this.stateMessage("join", { id, name })));
      this.sendPeers();
      return;
    }
    // cine couch on the host's Mac: what is on, and where to stream it from.
    if (msg.type === "source") {
      const film = msg.film ?? {};
      const id = String(film.id ?? "");
      const url = streamUrl(msg.url);
      if (!/^tt\d+$/.test(id) || !url) return;
      ws.serializeAttachment({ source: true });
      s.src = { url, subs: streamUrl(msg.subs) };
      let action = "source";
      if (!s.film || s.film.id !== id || s.ended) {
        // A new film. The same film again (cine restarted) keeps its position.
        s.film = { id, title: String(film.title || "Untitled").slice(0, 120), year: Number(film.year) || undefined };
        s.playing = false;
        s.time = 0;
        s.at = Date.now();
        s.ended = false;
        s.ratings = {};
        action = "load";
      }
      await this.save();
      this.broadcast(this.stateMessage(action, null));
      ws.send(JSON.stringify({ type: "peers", peers: this.seats() })); // cine shows who is in the room
      return;
    }
    if (msg.type === "source-off") {
      if (isSource(attachment)) await this.sourceGone();
      return;
    }

    if (!isSeat(attachment)) return; // everything below needs a seated browser
    const seat = attachment;

    if (msg.type === "pos") {
      this.lastPos = Number(msg.time) || 0;
      this.sendToOthers(ws, { type: "pos", id: seat.id, name: seat.name, time: this.lastPos, playing: !!msg.playing });
      return;
    }

    if (msg.type === "pull") {
      // The person ahead asks the person behind to jump to them.
      const time = Math.max(0, Number(msg.time) || 0);
      s.time = time;
      s.at = Date.now();
      await this.save();
      this.sendToOthers(ws, { type: "pull", name: seat.name, time, playing: !!msg.playing, now: Date.now() });
      return;
    }

    let action: string | null = null;

    if (msg.type === "set") {
      if (!s.film || s.ended) return;
      const playing = !!msg.playing;
      const time = Math.max(0, Number(msg.time) || 0);
      // Ignore reports that match what the room already believes (echoes, small jitter).
      if (playing === s.playing && Math.abs(time - currentTime(s)) < 2) return;
      if (playing !== s.playing) action = playing ? "play" : "pause";
      else action = "seek";
      s.playing = playing;
      s.time = time;
      s.at = Date.now();
    } else if (msg.type === "ended") {
      if (!s.film || s.ended) return;
      s.ended = true;
      s.playing = false;
      action = "ended";
    } else if (msg.type === "rate") {
      if (!s.ended) return;
      const stars = Math.round(Number(msg.stars));
      if (stars < 1 || stars > 5) return;
      s.ratings[seat.id] = { name: seat.name, stars };
      action = "rate";
    } else if (msg.type === "done") {
      if (!s.ended || !s.film) return;
      s.last = { title: s.film.title, finished: Date.now() };
      s.film = null;
      s.src = null;
      s.ended = false;
      s.ratings = {};
      action = "done";
    } else {
      return;
    }

    await this.save();
    this.broadcast(this.stateMessage(action, seat));
  }

  async webSocketClose(ws: WebSocket) {
    if (isSource(ws.deserializeAttachment())) {
      // cine couch lost its connection: nothing to stream from until it is back.
      const others = this.ctx.getWebSockets().filter((w) => w !== ws && isSource(w.deserializeAttachment()));
      if (others.length === 0) await this.sourceGone();
      return;
    }
    this.sendPeers(ws);
    // Last one out: freeze the film where it was, so tomorrow resumes there.
    const left = this.ctx.getWebSockets().filter((w) => w !== ws && isSeat(w.deserializeAttachment()));
    if (left.length === 0 && this.state.playing) {
      this.state.time = this.lastPos ?? currentTime(this.state);
      this.state.playing = false;
      this.state.at = Date.now();
      await this.save();
    }
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws);
  }

  // The film's source stopped: hold the film where it is, paused.
  async sourceGone() {
    const s = this.state;
    if (!s.src) return;
    s.src = null;
    if (s.playing) {
      s.time = this.lastPos ?? currentTime(s);
      s.playing = false;
      s.at = Date.now();
    }
    await this.save();
    this.broadcast(this.stateMessage("source-off", null));
  }

  // Ratings stay hidden until both people have rated.
  stateMessage(action: string | null, seat: Seat | null) {
    const ratings = Object.values(this.state.ratings);
    const revealed = ratings.length >= 2;
    const shown = ratings.map((r) => ({ name: r.name, stars: revealed ? r.stars : null }));
    return {
      type: "state",
      state: { ...this.state, ratings: shown },
      raters: Object.keys(this.state.ratings),
      action,
      by: seat?.name ?? null,
      byId: seat?.id ?? null,
      now: Date.now(),
    };
  }

  seats(closing?: WebSocket): Seat[] {
    return this.ctx
      .getWebSockets()
      .filter((w) => w !== closing)
      .map((w) => w.deserializeAttachment())
      .filter(isSeat);
  }

  sendPeers(closing?: WebSocket) {
    this.broadcast({ type: "peers", peers: this.seats(closing) }, closing);
  }

  broadcast(msg: object, skip?: WebSocket) {
    const text = JSON.stringify(msg);
    for (const w of this.ctx.getWebSockets()) {
      if (w === skip) continue;
      try {
        w.send(text);
      } catch {}
    }
  }

  sendToOthers(from: WebSocket, msg: object) {
    const text = JSON.stringify(msg);
    for (const w of this.ctx.getWebSockets()) {
      if (w === from || !isSeat(w.deserializeAttachment())) continue;
      try {
        w.send(text);
      } catch {}
    }
  }

  async save() {
    await this.ctx.storage.put("state", this.state);
  }
}

// ---------- film details for the end page ----------

const IMDB_HEADERS = {
  "content-type": "application/json",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36",
  "x-imdb-client-name": "imdb-web-next",
  origin: "https://www.imdb.com",
};
const POLITE_UA = { "user-agent": "couch/0.1 (https://couch.nicktrim.com)" };

async function filmDetails(imdb: string, ctx: ExecutionContext): Promise<Response> {
  const cache = caches.default;
  const key = new Request(`https://couch.nicktrim.com/api/film/${imdb}?v=3`);
  const hit = await cache.match(key);
  if (hit) return hit;

  const out: any = { imdb, title: null, year: null, runtime: null, genres: [], tagline: null, plot: null, poster: null, directors: [], writers: [], stars: [], about: null, wiki: null };

  // 1. Wikidata: IMDb id -> Wikipedia article and the basic facts.
  // IMDb refuses requests from Cloudflare's servers, so these are the fallback.
  try {
    const sparql = `SELECT ?article (MIN(YEAR(?date)) AS ?year) (SAMPLE(?mins) AS ?runtime)
      (GROUP_CONCAT(DISTINCT ?dirLabel; separator="|") AS ?dirs)
      (GROUP_CONCAT(DISTINCT ?genreLabel; separator="|") AS ?genres) WHERE {
      ?f wdt:P345 "${imdb}".
      OPTIONAL { ?article schema:about ?f; schema:isPartOf <https://en.wikipedia.org/> }
      OPTIONAL { ?f wdt:P577 ?date }
      OPTIONAL { ?f wdt:P2047 ?mins }
      OPTIONAL { ?f wdt:P57 ?dir. ?dir rdfs:label ?dirLabel. FILTER(LANG(?dirLabel) = "en") }
      OPTIONAL { ?f wdt:P136 ?genre. ?genre rdfs:label ?genreLabel. FILTER(LANG(?genreLabel) = "en") }
    } GROUP BY ?article LIMIT 1`;
    const r = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`, { headers: POLITE_UA });
    const row = ((await r.json()) as any).results.bindings[0];
    if (row) {
      out.wiki = row.article?.value ?? null;
      out.year = row.year ? Number(row.year.value) : null;
      out.runtime = row.runtime ? Number(row.runtime.value) * 60 : null;
      out.directors = row.dirs?.value ? row.dirs.value.split("|") : [];
      // "romantic comedy film" -> "Romantic comedy"; Wikidata lists many, keep three.
      out.genres = (row.genres?.value ? row.genres.value.split("|") : [])
        .slice(0, 3)
        .map((g: string) => g.replace(/ film$/, ""))
        .map((g: string) => g.charAt(0).toUpperCase() + g.slice(1));
    }
  } catch {}

  // 2. IMDb: plot, credits, runtime, poster. No rating, on purpose.
  if (out.imdb) {
    try {
      const query = `{ title(id: "${out.imdb}") { titleText { text } releaseYear { year } runtime { seconds } plot { plotText { plainText } } primaryImage { url } genres { genres { text } } taglines(first: 1) { edges { node { text } } } principalCredits { category { text } credits(limit: 4) { name { nameText { text } } } } } }`;
      const r = await fetch("https://api.graphql.imdb.com/", { method: "POST", headers: IMDB_HEADERS, body: JSON.stringify({ query }) });
      const t = ((await r.json()) as any).data?.title;
      if (t) {
        out.title = t.titleText?.text ?? out.title;
        out.year = t.releaseYear?.year ?? out.year;
        out.runtime = t.runtime?.seconds ?? out.runtime;
        out.plot = t.plot?.plotText?.plainText ?? null;
        out.poster = t.primaryImage?.url ?? null;
        if (t.genres?.genres?.length) out.genres = t.genres.genres.map((g: any) => g.text);
        out.tagline = t.taglines?.edges?.[0]?.node?.text ?? null;
        for (const group of t.principalCredits ?? []) {
          const names = group.credits.map((c: any) => c.name.nameText.text);
          const category = group.category.text;
          if (category.startsWith("Director")) out.directors = names;
          else if (category.startsWith("Writer")) out.writers = names;
          else if (category.startsWith("Star")) out.stars = names;
        }
      }
    } catch {}
  }

  // 3. Wikipedia: the lead paragraph, and the fallback if IMDb said nothing.
  if (out.wiki) {
    try {
      const page = out.wiki.split("/wiki/")[1];
      const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${page}`, { headers: POLITE_UA });
      const w = (await r.json()) as any;
      out.about = w.extract ?? null;
      out.title ??= w.title ?? null;
      out.poster ??= w.originalimage?.source ?? null;
    } catch {}
  }

  const res = Response.json(out, { headers: { "cache-control": "public, max-age=604800" } });
  if (out.title) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

// ---------- routing ----------

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts[0] === "r" && parts[1] && ROOM_ID.test(parts[1])) {
      if (parts[2] === "ws") {
        if (req.headers.get("upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
        const room = env.ROOM.get(env.ROOM.idFromName(parts[1]));
        return room.fetch(req);
      }
      if (parts.length === 2) return env.ASSETS.fetch(new Request(new URL("/room", url), req));
    }

    if (parts[0] === "api" && parts[1] === "film" && /^tt\d+$/.test(parts[2] ?? "")) {
      return filmDetails(parts[2], ctx);
    }

    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
