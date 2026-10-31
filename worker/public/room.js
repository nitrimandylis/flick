// couch room: both browsers play the same MP4 in a plain <video>, streamed from
// the host's Mac by `cine couch`. A tiny relay keeps play, pause and seek in step.
//
// One rule decides what counts as a person acting: a media event is only sent
// to the room when it disagrees with the room. A "play" while the room plays,
// or a seek that lands where the room is, is just us following.

const DRIFT_LIMIT = 3; // seconds apart before the pill turns magenta
const CURTAIN_CAP = 10000; // ms before the loading curtain gives up and lifts
const SEEK_LEAD = 1.5; // seconds: a jump while playing re-buffers through the tunnel, so land ahead

const roomId = location.pathname.split("/")[2];
const $ = (id) => document.getElementById(id);
const video = $("player");

// Who this browser is. The id survives renames; the name is what toasts show.
if (!localStorage.couchId) localStorage.couchId = crypto.randomUUID();
const me = { id: localStorage.couchId, name: localStorage.couchName || "" };

let ws = null;
let seated = false;
let room = null; // last state from the server
let raters = []; // browser ids that have rated, from the server
let clockOffset = 0; // server clock minus our clock, in ms
let peers = [];

let playing = null; // the source we attached: { key, url, subs }
let peerPos = null; // { name, time, playing, at } from the other browser
let sendTimer = null;
let capTimer = null;

// ---------- small helpers ----------

function clock(seconds) {
  seconds = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return (h > 0 ? h + ":" : "") + mm + ":" + String(s).padStart(2, "0");
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function show(sectionId) {
  for (const id of ["gate", "empty", "stage", "after"]) $(id).hidden = id !== sectionId;
}

// Where the room says the film is right now.
function roomTime() {
  if (!room || !room.film) return 0;
  if (!room.playing) return room.time;
  return room.time + (Date.now() + clockOffset - room.at) / 1000;
}

function otherPeer() {
  return peers.find((p) => p.id !== me.id) || null;
}

// ---------- connection ----------

function connect() {
  const scheme = location.protocol === "https:" ? "wss://" : "ws://";
  ws = new WebSocket(scheme + location.host + "/r/" + roomId + "/ws");
  ws.addEventListener("open", () => {
    if (seated) send({ type: "hello", id: me.id, name: me.name });
  });
  ws.addEventListener("message", (event) => onServer(JSON.parse(event.data)));
  ws.addEventListener("close", () => {
    setTimeout(connect, 1500); // laptop slept or wifi blinked: come back quietly
  });
}

function onServer(msg) {
  if (msg.type === "state") {
    clockOffset = msg.now - Date.now();
    applyState(msg);
  } else if (msg.type === "peers") {
    peers = msg.peers;
    const other = otherPeer();
    if (other) localStorage.couchPeer = other.name;
    if (!seated) renderGate();
    updatePill();
  } else if (msg.type === "pos") {
    peerPos = { name: msg.name, time: msg.time, playing: msg.playing, at: Date.now() };
    updatePill();
  } else if (msg.type === "pull") {
    // The other person is ahead and asked us to jump to them.
    video.currentTime = msg.time;
    toast(msg.name + " pulled you to " + clock(msg.time));
  }
}

async function applyState(msg) {
  room = msg.state;
  raters = msg.raters || [];

  if (!seated) {
    renderGate();
    return;
  }

  if (!room.film) {
    detach();
    renderEmpty();
    show("empty");
    return;
  }

  if (room.ended) {
    detach();
    renderAfter();
    show("after");
    return;
  }

  show("stage");
  $("pill-film").textContent = room.film.title;

  if (!room.src) {
    // cine couch stopped (Ctrl-C, sleep, lost signal). Hold where we are.
    video.pause();
    curtain("The film's source went offline. It comes back when cine couch is running again on the host's Mac.");
    return;
  }

  const fromMe = msg.byId === me.id;
  if (!playing || playing.key !== room.src.url) {
    await attach();
    follow();
  } else if (["play", "pause", "seek"].includes(msg.action) && !fromMe) {
    follow();
  }

  if (!fromMe && msg.by) {
    if (msg.action === "play") toast(msg.by + " pressed play at " + clock(room.time));
    if (msg.action === "pause") toast(msg.by + " paused at " + clock(room.time));
    if (msg.action === "seek") toast(msg.by + " jumped to " + clock(room.time));
  }
  if (msg.action === "load") toast(room.film.title + " is on");
  wake();
}

// ---------- the player ----------

// Everyone, the host included, streams through the tunnel: a public page
// reaching this Mac's own 127.0.0.1 makes Chrome ask for local network access.
async function attach() {
  const { url, subs } = room.src;
  playing = { key: url, url, subs };

  curtain("Loading " + room.film.title + "…");
  video.src = url;
  const track = $("subs");
  track.src = subs || "";
  $("cc").hidden = !subs;
  setCaptions(localStorage.couchCaptions === "on");
  video.load();
  // Wait for the file's index before seeking into it, but never forever.
  await Promise.race([
    new Promise((resolve) => video.addEventListener("loadedmetadata", resolve, { once: true })),
    new Promise((resolve) => setTimeout(resolve, CURTAIN_CAP)),
  ]);
}

function detach() {
  if (!playing) return;
  playing = null;
  video.removeAttribute("src");
  video.load();
}

// Put our player where the room is.
function follow() {
  if (!playing) return;
  const target = roomTime();
  if (Math.abs(video.currentTime - target) > 0.5) video.currentTime = target + (room.playing ? SEEK_LEAD : 0);
  if (room.playing) {
    video.play().catch(() => toast("Press play: the browser didn't let couch start the film.", 5000));
  } else {
    video.pause();
  }
}

// Report a change made by the person at this screen. Seeking fires a burst of
// events while the bar is dragged, so only where it settles is sent.
function report() {
  clearTimeout(sendTimer);
  sendTimer = setTimeout(() => {
    send({ type: "set", playing: !video.paused, time: video.currentTime });
  }, 300);
}

video.addEventListener("play", () => {
  if (room && !room.playing) report();
});
video.addEventListener("pause", () => {
  if (video.ended) return;
  if (room && room.playing) report();
});
video.addEventListener("seeked", () => {
  if (room && Math.abs(video.currentTime - roomTime()) > 2.5) report(); // wider than SEEK_LEAD
});
video.addEventListener("ended", () => send({ type: "ended" }));
video.addEventListener("canplay", hideCurtain);
video.addEventListener("timeupdate", updateClock);

// Tell the other browser where we are, for the drift badge.
setInterval(() => {
  if (!seated || !playing || !room || room.ended) return;
  send({ type: "pos", time: video.currentTime, playing: !video.paused });
}, 3000);

// ---------- curtain ----------

function curtain(text) {
  $("curtain-text").textContent = text;
  const line = $("curtain-line");
  line.replaceWith(line.cloneNode(true)); // restart the progress line
  $("curtain").classList.remove("gone");
  clearTimeout(capTimer);
  capTimer = setTimeout(hideCurtain, CURTAIN_CAP);
}

function hideCurtain() {
  if (room && room.film && !room.src) return; // offline notice stays up
  clearTimeout(capTimer);
  $("curtain").classList.add("gone");
}

// ---------- subtitles ----------

function setCaptions(on) {
  const track = video.textTracks[0];
  if (track) track.mode = on ? "showing" : "hidden";
  $("cc").classList.toggle("on", on);
  $("cc").setAttribute("aria-pressed", String(on));
}

$("cc").addEventListener("click", () => {
  const on = localStorage.couchCaptions !== "on";
  localStorage.couchCaptions = on ? "on" : "off";
  setCaptions(on);
});

// ---------- pill ----------

let sleepTimer = null;

function wake() {
  const pill = $("pill");
  pill.classList.remove("asleep");
  clearTimeout(sleepTimer);
  sleepTimer = setTimeout(() => {
    if (!$("dot").classList.contains("drift")) pill.classList.add("asleep");
  }, 3000);
}

// Seconds we are ahead of the other person (negative: behind). Null if unknown.
function driftSeconds() {
  if (!peerPos || !playing || !otherPeer()) return null;
  if (Date.now() - peerPos.at > 10000) return null; // stale report
  const theirs = peerPos.time + (peerPos.playing ? (Date.now() - peerPos.at) / 1000 : 0);
  return video.currentTime - theirs;
}

function updatePill() {
  const dot = $("dot");
  const status = $("status");
  const other = otherPeer();
  const drift = driftSeconds();
  dot.className = "dot";
  $("resync").hidden = true;

  if (!other) {
    dot.classList.add("waiting");
    status.textContent = "Waiting for " + (localStorage.couchPeer || "the other seat");
  } else if (drift !== null && Math.abs(drift) > DRIFT_LIMIT) {
    dot.classList.add("drift");
    const gap = Math.round(Math.abs(drift)) + " s";
    status.textContent = drift > 0 ? other.name + " is " + gap + " behind" : "You're " + gap + " behind";
    $("resync").hidden = false;
    wake();
  } else {
    status.textContent = "In sync with " + other.name;
  }
}

function updateClock() {
  const el = $("clock");
  el.textContent = clock(video.currentTime) + " ";
  if (video.duration) {
    const of = document.createElement("span");
    of.className = "of";
    of.textContent = "/ " + clock(video.duration);
    el.append(of);
  }
}

$("resync").addEventListener("click", () => {
  const drift = driftSeconds();
  if (drift === null) return;
  if (drift < 0) {
    // We are behind: jump ourselves to them.
    video.currentTime = peerPos.time + (peerPos.playing ? (Date.now() - peerPos.at) / 1000 : 0);
  } else {
    // They are behind: pull them to us.
    send({ type: "pull", time: video.currentTime, playing: !video.paused });
    toast("Pulling " + otherPeer().name + " to " + clock(video.currentTime));
  }
  peerPos = null;
  updatePill();
});

$("stage").addEventListener("mousemove", wake);

$("fullscreen").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
});

// ---------- toasts ----------

let toastTimer = null;

function toast(text, ms = 2600) {
  const el = $("toast");
  el.textContent = text;
  el.classList.remove("gone");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("gone"), ms);
}

// ---------- gate ----------

function renderGate() {
  $("gate-film").textContent = room && room.film && !room.ended ? "Tonight: " + room.film.title : "";
  const other = otherPeer();
  $("gate-peer").textContent = other ? other.name + " is already here." : "";
}

$("name-field").hidden = !!me.name;
$("name").value = me.name;

function sitDown() {
  if (!me.name) {
    const typed = $("name").value.trim();
    if (!typed) {
      $("name").focus();
      return;
    }
    me.name = typed;
    localStorage.couchName = typed;
  }
  seated = true;
  send({ type: "hello", id: me.id, name: me.name });
}

$("sit").addEventListener("click", sitDown);
$("name").addEventListener("keydown", (event) => {
  if (event.key === "Enter") sitDown();
});

// ---------- empty room ----------

function renderEmpty() {
  if (room && room.last) {
    const date = new Date(room.last.finished).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    $("last").textContent = "Last time: " + room.last.title + ", finished " + date + ".";
  } else {
    $("last").textContent = "";
  }
}

// ---------- after the film ----------

let detailsFor = null;

function renderAfter() {
  const film = room.film;
  if (detailsFor !== film.id) {
    detailsFor = film.id;
    $("after-title").textContent = film.title;
    for (const id of ["facts", "tagline", "plot", "about", "credits"]) $(id).textContent = "";
    $("backdrop").style.backgroundImage = "";
    loadDetails(film.id);
  }
  renderVerdict();
}

async function loadDetails(id) {
  let info;
  try {
    info = await (await fetch("/api/film/" + id)).json();
  } catch {
    return;
  }
  if (detailsFor !== id) return;
  if (info.title) $("after-title").textContent = info.title;
  if (info.poster) $("backdrop").style.backgroundImage = "url(" + info.poster + ")";

  const facts = $("facts");
  const bits = [];
  if (info.year) bits.push(String(info.year));
  if (info.runtime) bits.push(Math.floor(info.runtime / 3600) + " h " + Math.round((info.runtime % 3600) / 60) + " min");
  if (info.genres.length) bits.push(info.genres.join(", "));
  for (const bit of bits) {
    const span = document.createElement("span");
    span.textContent = bit;
    facts.append(span);
  }

  $("tagline").textContent = info.tagline || "";
  $("plot").textContent = info.plot || "";
  $("about").textContent = info.about || "";

  const credits = $("credits");
  const rows = [
    [info.directors.length > 1 ? "Directors" : "Director", info.directors],
    ["Written by", info.writers],
    ["Starring", info.stars],
  ];
  for (const [label, names] of rows) {
    if (!names.length) continue;
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = names.join(", ");
    credits.append(dt, dd);
  }
}

function renderVerdict() {
  const stars = $("stars");
  const mine = Number(localStorage["couchRating:" + room.film.id]) || 0;
  const iRated = raters.includes(me.id);
  stars.innerHTML = "";
  for (let n = 1; n <= 5; n++) {
    const button = document.createElement("button");
    button.textContent = String(n);
    button.setAttribute("aria-label", n + " out of 5");
    if (iRated && n === mine) button.classList.add("picked");
    button.addEventListener("click", () => {
      localStorage["couchRating:" + room.film.id] = n;
      send({ type: "rate", stars: n });
    });
    stars.append(button);
  }

  const revealed = room.ratings.length >= 2 && room.ratings.every((r) => r.stars !== null);
  $("reveal").hidden = !revealed;
  stars.hidden = revealed;
  if (revealed) {
    $("reveal").innerHTML = "";
    for (const r of room.ratings) {
      const box = document.createElement("div");
      const score = document.createElement("strong");
      score.textContent = String(r.stars);
      const who = document.createElement("span");
      who.textContent = r.name;
      box.append(score, who);
      $("reveal").append(box);
    }
    $("verdict-note").textContent = "Out of 5. Now argue.";
  } else if (iRated) {
    const other = otherPeer();
    $("verdict-note").textContent = "You picked " + mine + ". Waiting for " + (other ? other.name : "the other seat") + ".";
  } else {
    $("verdict-note").textContent = "Both scores stay hidden until you have both picked one.";
  }
}

$("done").addEventListener("click", () => send({ type: "done" }));

// ---------- start ----------

connect();
