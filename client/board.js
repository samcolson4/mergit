import mermaid from "/vendor/mermaid/mermaid.esm.min.mjs";
import { loadCore } from "./core.js";
import {
  addFrame as docAddFrame,
  changedSpan,
  deleteFrame as docDeleteFrame,
  docToBoard,
  frameText,
  getMerge,
  replaceBoard,
  setMerge,
  setText,
  updateFrame,
} from "./doc.js";
import { Session } from "./sync.js";
import { githubButton, openGithubSettings } from "./settings.js";
import { TEMPLATES } from "./templates.js";
import { api, el, identity, prefs, short } from "./util.js";

const LANE_COLORS = ["#ff3670", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#a855f7"];

const $ = (id) => document.getElementById(id);
const canvas = $("canvas");
const world = $("world");
const cursorsLayer = $("cursors");
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const boardId = location.pathname.split("/")[2];
const me = identity();

function initMermaid() {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: darkQuery.matches ? "dark" : "default",
    fontFamily: "ui-sans-serif, -apple-system, 'Segoe UI', sans-serif",
  });
}
initMermaid();

const core = await loadCore("/pkg/mergit_core.wasm");

const state = {
  branch: null,
  remoteRefs: {}, // branch → commit, as last seen on the server
  board: { frames: [] }, // derived from the live document
  view: prefs.get(`view.${boardId}`) ?? { x: 60, y: 60, k: 0.8 },
  selected: null,
  editorOpen: false,
  preview: null, // { hash, entry, board } while viewing a past commit
  status: null,
  log: [],
  changes: [],
  peers: [],
  myId: null,
  connection: "connecting",
  github: null, // { repo, path, branch, url } when history lives on GitHub
  committing: false,
};

/** @type {Session | null} */
let session = null;
const doc = () => session.doc;

// ---- helpers ------------------------------------------------------------------

let toastTimer;
function toast(msg, isError = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (isError ? " error" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 4500 : 2600);
}

async function attempt(fn) {
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    if (e.data?.needsToken) {
      if (await openGithubSettings(e.message)) toast("GitHub connected. Try that again.");
    } else {
      toast(e.message, true);
    }
  }
}

const hasMarkers = (src) => src.includes("%% <<<<<<<");
const currentBoard = () => state.preview?.board ?? state.board;
const readonly = () => state.preview != null;
const frameById = (id) => currentBoard().frames.find((f) => f.id === id);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function ago(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

let viewSaveTimer;
function saveView() {
  clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(() => prefs.set(`view.${boardId}`, state.view), 300);
}

// ---- syncing commits & refs with the server -----------------------------------

let refsQueue = Promise.resolve();

/** Fetch whatever commits we're missing and mirror the server's branches locally. */
function syncRefs(refs) {
  refsQueue = refsQueue.then(async () => {
    refs ??= (await api(`/api/boards/${boardId}`)).refs;
    const known = new Set(Object.values(state.remoteRefs));
    const want = [...new Set(Object.values(refs))].filter((h) => !known.has(h));
    if (want.length) {
      const { objects } = await api(`/api/boards/${boardId}/pack`, {
        method: "POST",
        body: { want, have: [...known] },
      });
      core.call("ingest", { objects });
    }
    for (const name of new Set([...Object.keys(state.remoteRefs), ...Object.keys(refs)])) {
      core.call("set_ref", { name, hash: refs[name] ?? null });
    }
    state.remoteRefs = refs;
  });
  return refsQueue;
}

/** A 409 that means "someone else moved the branch first" (not a GitHub refusal). */
const lostRace = (e) => e.status === 409 && !e.data?.github;

/** Compare-and-swap a branch on the server, uploading any objects it lacks. */
async function pushRef(name, old, next, tips = []) {
  const objects = tips.length
    ? core.call("pack", { tips, exclude: [...new Set(Object.values(state.remoteRefs))] })
    : {};
  await api(`/api/boards/${boardId}/refs`, { method: "POST", body: { name, old, new: next, objects, by: me.name } });
  state.remoteRefs = { ...state.remoteRefs, [name]: next };
}

// ---- live session -----------------------------------------------------------------

function wsUrl(branch) {
  const u = new URL(`/api/boards/${boardId}/ws`, location.href);
  u.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  u.search = new URLSearchParams({ branch, name: me.name, color: me.color });
  return u;
}

function joinBranch(name, { carry } = {}) {
  return new Promise((resolve) => {
    session?.close();
    state.branch = name;
    state.preview = null;
    state.selected = null;
    closeEditor();
    core.call("attach", { name });
    const query = name === "main" ? "" : `?branch=${encodeURIComponent(name)}`;
    history.replaceState(null, "", `/b/${boardId}${query}`);

    session = new Session(wsUrl(name), {
      onSynced() {
        doc().on("update", onDocUpdate);
        if (carry) replaceBoard(doc(), carry);
        onDocUpdate();
        resolve();
      },
      onMessage,
      onStatus(status) {
        state.connection = status;
        renderPresence();
        if (state.status) renderVcs();
      },
    });
  });
}

let vcsTimer;
function onDocUpdate() {
  state.board = docToBoard(doc());
  core.call("set_merge", getMerge(doc()));
  if (state.editorOpen && !readonly()) syncEditor();
  renderBoard();
  clearTimeout(vcsTimer);
  vcsTimer = setTimeout(refreshVcs, 120);
}

function onMessage(msg) {
  if (msg.type === "hello") state.myId = msg.id;
  else if (msg.type === "peers") {
    state.peers = msg.peers;
    renderPresence();
    renderBoard();
  } else if (msg.type === "ref") {
    syncRefs()
      .then(() => {
        if (!(state.branch in state.remoteRefs)) {
          toast(`${msg.by} deleted ${state.branch}; switched to main`, true);
          return joinBranch("main");
        }
        if (msg.by !== me.name && msg.name === state.branch && msg.hash) toast(`${msg.by} committed to ${msg.name}`);
        refreshVcs();
      })
      .catch((e) => toast(e.message, true));
  }
}

let presenceTimer;
let pendingCursor;
function sendPresence(cursor = pendingCursor) {
  pendingCursor = cursor;
  if (presenceTimer) return;
  presenceTimer = setTimeout(() => {
    presenceTimer = null;
    session?.send({ type: "presence", selected: state.selected, cursor: pendingCursor ?? null });
  }, 60);
}

// ---- viewport -----------------------------------------------------------------

function applyView() {
  const { x, y, k } = state.view;
  world.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
  canvas.style.backgroundSize = `${24 * k}px ${24 * k}px`;
  canvas.style.backgroundPosition = `${x}px ${y}px`;
  canvas.style.setProperty("--inv-k", 1 / k);
  $("zoom-label").textContent = `${Math.round(k * 100)}%`;
}

function zoomAt(clientX, clientY, factor) {
  const r = canvas.getBoundingClientRect();
  const v = state.view;
  const px = clientX - r.left;
  const py = clientY - r.top;
  const k = Math.min(4, Math.max(0.1, v.k * factor));
  v.x = px - ((px - v.x) * k) / v.k;
  v.y = py - ((py - v.y) * k) / v.k;
  v.k = k;
  applyView();
  saveView();
}

function zoomCenter(factor) {
  const r = canvas.getBoundingClientRect();
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
}

function toWorld(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  return { x: (clientX - r.left - state.view.x) / state.view.k, y: (clientY - r.top - state.view.y) / state.view.k };
}

function fit() {
  const frames = currentBoard().frames;
  if (!frames.length) return;
  const minX = Math.min(...frames.map((f) => f.x));
  const minY = Math.min(...frames.map((f) => f.y));
  const maxX = Math.max(...frames.map((f) => f.x + f.w));
  const maxY = Math.max(...frames.map((f) => f.y + f.h));
  const r = canvas.getBoundingClientRect();
  const pad = 60;
  const k = Math.min(1.5, (r.width - pad * 2) / (maxX - minX), (r.height - pad * 2) / (maxY - minY));
  state.view = { k, x: (r.width - (maxX - minX) * k) / 2 - minX * k, y: (r.height - (maxY - minY) * k) / 2 - minY * k };
  applyView();
  saveView();
}

function locate(id) {
  const f = frameById(id);
  if (!f) return;
  const r = canvas.getBoundingClientRect();
  const k = state.view.k;
  state.view.x = r.width / 2 - (f.x + f.w / 2) * k;
  state.view.y = r.height / 2 - (f.y + f.h / 2) * k;
  applyView();
  select(id);
}

// ---- mermaid rendering ------------------------------------------------------------

const svgCache = new Map();
let renderSeq = 0;
let renderQueue = Promise.resolve();

// mermaid.render isn't safe to run concurrently, so renders are serialised.
function renderMermaid(rec, src) {
  const token = ++rec.token;
  renderQueue = renderQueue.then(async () => {
    if (token !== rec.token) return;
    let out = svgCache.get(src);
    if (!out) {
      const id = `mmd-${++renderSeq}`;
      try {
        out = { svg: (await mermaid.render(id, src)).svg };
      } catch (e) {
        out = { error: String(e?.message ?? e) };
        document.getElementById(`d${id}`)?.remove();
        document.getElementById(id)?.remove();
      }
      svgCache.set(src, out);
      if (svgCache.size > 300) svgCache.delete(svgCache.keys().next().value);
    }
    if (token !== rec.token) return;
    if (out.svg) rec.body.innerHTML = out.svg;
    else rec.body.replaceChildren(el("div", { className: "render-error", textContent: out.error }));
    if (state.selected === rec.id) showSourceError(out.error);
  });
}

function showSourceError(error) {
  const box = $("source-error");
  box.hidden = !error;
  box.textContent = error ?? "";
}

// ---- frames -------------------------------------------------------------------

const frameEls = new Map();

function createFrameEl(id) {
  const title = el("span", { className: "title" });
  const badge = el("span", { className: "badge" });
  const peerTag = el("span", { className: "peer-tag" });
  const body = el("div", { className: "frame-body" });
  const resize = el("div", { className: "resize", title: "Resize" });
  const node = el("div", { className: "frame" }, peerTag, el("div", { className: "frame-head" }, title, badge), body, resize);
  const rec = { id, el: node, title, badge, peerTag, body, src: null, token: 0, renderTimer: null };

  node.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    select(id);
    if (!readonly()) dragFrame(e, id, e.target === resize);
  });
  node.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    openEditor(id);
  });
  return rec;
}

function dragFrame(e, id, isResize) {
  const f = frameById(id);
  const start = { x: e.clientX, y: e.clientY, fx: f.x, fy: f.y, fw: f.w, fh: f.h };
  let moved = false;
  let frame = 0;
  const target = e.currentTarget;
  target.setPointerCapture(e.pointerId);

  const move = (ev) => {
    const dx = (ev.clientX - start.x) / state.view.k;
    const dy = (ev.clientY - start.y) / state.view.k;
    if (!moved && Math.hypot(dx, dy) < 2) return;
    moved = true;
    const fields = isResize
      ? { w: Math.max(220, Math.round(start.fw + dx)), h: Math.max(160, Math.round(start.fh + dy)) }
      : { x: Math.round(start.fx + dx), y: Math.round(start.fy + dy) };
    // At most one document update per animation frame keeps wire traffic sane.
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => updateFrame(doc(), id, fields));
  };
  const up = () => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", up);
    target.removeEventListener("pointercancel", up);
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", up);
  target.addEventListener("pointercancel", up);
}

function renderBoard() {
  const board = currentBoard();
  const statusById = new Map(state.changes.map((c) => [c.id, c.status]));
  const peerSelections = new Map();
  if (!readonly()) {
    for (const p of state.peers) {
      if (p.id !== state.myId && p.branch === state.branch && p.selected) peerSelections.set(p.selected, p);
    }
  }
  const seen = new Set();
  board.frames.forEach((f, i) => {
    seen.add(f.id);
    let rec = frameEls.get(f.id);
    if (!rec) {
      rec = createFrameEl(f.id);
      frameEls.set(f.id, rec);
      world.append(rec.el);
    }
    const st = hasMarkers(f.source) ? "conflict" : statusById.get(f.id);
    const peer = peerSelections.get(f.id);
    const selected = state.selected === f.id;
    rec.el.className = `frame${st ? ` st-${st}` : ""}${selected ? " selected" : ""}${peer ? " peer-selected" : ""}`;
    rec.el.style.cssText = `left:${f.x}px;top:${f.y}px;width:${f.w}px;height:${f.h}px;z-index:${selected ? 900 : i + 1}`;
    if (peer) rec.el.style.setProperty("--peer", peer.color);
    rec.peerTag.textContent = peer?.name ?? "";
    rec.peerTag.hidden = !peer;
    rec.title.textContent = f.title || "Untitled";
    rec.badge.textContent = st ?? "";
    rec.badge.className = `badge ${st ?? ""}`;
    rec.badge.hidden = !st;
    if (rec.src !== f.source) {
      // Debounced so typing (ours or a collaborator's) doesn't re-layout on every keystroke.
      const first = rec.src === null;
      rec.src = f.source;
      clearTimeout(rec.renderTimer);
      rec.renderTimer = setTimeout(() => renderMermaid(rec, f.source), first ? 0 : 160);
    }
  });
  for (const [id, rec] of frameEls) {
    if (!seen.has(id)) {
      rec.el.remove();
      frameEls.delete(id);
    }
  }
  world.classList.toggle("readonly", readonly());
}

function select(id) {
  if (state.selected === id) return;
  state.selected = id;
  if (state.editorOpen) id ? openEditor(id) : closeEditor();
  renderBoard();
  sendPresence();
}

function addFrame(template, at) {
  if (readonly()) return toast("Close the history preview to edit", true);
  const center = at ?? (() => {
    const r = canvas.getBoundingClientRect();
    return toWorld(r.left + r.width / 2, r.top + r.height / 2);
  })();
  const f = {
    id: `f-${crypto.randomUUID().slice(0, 8)}`,
    title: template.name,
    x: Math.round(center.x - template.w / 2),
    y: Math.round(center.y - template.h / 2),
    w: template.w,
    h: template.h,
    source: template.source,
  };
  docAddFrame(doc(), f);
  openEditor(f.id);
}

function deleteFrame(id) {
  if (readonly()) return;
  closeEditor();
  state.selected = null;
  docDeleteFrame(doc(), id);
  sendPresence();
}

// ---- presence -------------------------------------------------------------------

function initials(name) {
  return name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
}

function renderPresence() {
  const live = state.connection === "live";
  $("connection").className = `connection ${live ? "live" : "offline"}`;
  $("connection").textContent = live ? "Live" : state.connection === "connecting" ? "Connecting…" : "Reconnecting…";

  const others = state.peers.filter((p) => p.id !== state.myId);
  $("peers").replaceChildren(
    ...[{ ...me, id: state.myId, branch: state.branch, self: true }, ...others].map((p) =>
      el("span", {
        className: `avatar${p.self ? " self" : ""}${p.branch !== state.branch ? " elsewhere" : ""}`,
        textContent: initials(p.name),
        title: `${p.name}${p.self ? " (you)" : ""} · ${p.branch}`,
        style: `--c:${p.color}`,
      }),
    ),
  );

  cursorsLayer.replaceChildren(
    ...others
      .filter((p) => p.cursor && p.branch === state.branch && !readonly())
      .map((p) =>
        el(
          "div",
          { className: "cursor", style: `left:${p.cursor.x}px;top:${p.cursor.y}px;--c:${p.color}` },
          el("span", { textContent: p.name }),
        ),
      ),
  );
}

// ---- editor -------------------------------------------------------------------

function openEditor(id) {
  const f = frameById(id);
  if (!f) return;
  state.selected = id;
  state.editorOpen = true;
  $("editor").hidden = false;
  $("frame-title").value = f.title;
  $("source").value = f.source;
  $("frame-title").readOnly = $("source").readOnly = readonly();
  $("delete-frame").hidden = readonly();
  showSourceError(svgCache.get(f.source)?.error);
  renderBoard();
  sendPresence();
}

function closeEditor() {
  state.editorOpen = false;
  $("editor").hidden = true;
}

/** Apply a remote edit to an input without yanking the local caret around. */
function syncInput(input, next) {
  const prev = input.value;
  if (prev === next) return;
  const [start, endPrev, endNext] = changedSpan(prev, next);
  const map = (i) => (i <= start ? i : i >= endPrev ? i + (endNext - endPrev) : endNext);
  const [s, e] = [input.selectionStart, input.selectionEnd];
  input.value = next;
  if (document.activeElement === input) input.setSelectionRange(map(s), map(e));
}

function syncEditor() {
  const f = frameById(state.selected);
  if (!f) {
    closeEditor();
    return;
  }
  syncInput($("source"), f.source);
  syncInput($("frame-title"), f.title);
}

$("source").addEventListener("input", () => {
  if (readonly() || !state.selected) return;
  const text = frameText(doc(), state.selected);
  if (text) setText(text, $("source").value);
});
$("source").addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  e.preventDefault();
  document.execCommand("insertText", false, "  ");
});
$("frame-title").addEventListener("input", () => {
  if (!readonly() && state.selected) updateFrame(doc(), state.selected, { title: $("frame-title").value });
});
$("close-editor").onclick = closeEditor;
$("delete-frame").onclick = () => state.selected && deleteFrame(state.selected);

// ---- version control ------------------------------------------------------------

function refreshVcs() {
  if (!session?.synced) return;
  state.status = core.call("status", { board: state.board });
  state.log = core.call("log");
  state.changes = state.preview
    ? core.call("commit_diff", { rev: state.preview.hash })
    : core.call("diff", { rev: "HEAD", board: state.board });
  renderVcs();
  renderBanner();
  renderBoard();
}

function renderVcs() {
  const { status } = state;
  const branchSel = $("branch");
  branchSel.replaceChildren(...status.branches.map((b) => el("option", { value: b, textContent: b })));
  branchSel.value = state.branch;

  const conflicts = state.board.frames.filter((f) => hasMarkers(f.source)).length;
  const dot = el("span", { className: `dot${status.merging ? " merging" : status.dirty ? " dirty" : ""}` });
  const text = status.merging
    ? `Merging ${status.merging}${conflicts ? ` · ${conflicts} conflicted` : " · ready to commit"}`
    : status.dirty
      ? state.preview
        ? "Uncommitted changes"
        : `${plural(state.changes.length, "uncommitted change")}, shared with everyone on ${state.branch}`
      : "Clean";
  $("status-line").replaceChildren(dot, text, el("span", {}, "· HEAD"), el("code", { textContent: short(status.head) }));

  const live = state.connection === "live";
  $("commit-box").style.opacity = readonly() ? 0.5 : 1;
  $("message").disabled = readonly();
  $("commit").disabled = state.committing || readonly() || !live || (!status.dirty && !status.merging);
  $("commit").title = live ? "" : "Reconnect to commit";
  $("discard").disabled = readonly() || (!status.dirty && !status.merging);
  $("discard").textContent = status.merging ? "Abort merge" : "Discard";

  $("changes-title").textContent = state.preview ? `Changed in ${short(state.preview.hash)}` : "Uncommitted changes";
  renderChanges();
  renderHistory();
}

function renderChanges() {
  const box = $("changes");
  if (!state.changes.length) {
    box.replaceChildren(
      el("div", { className: "empty", textContent: state.preview ? "No diagram changes." : "Nothing changed since the last commit." }),
    );
    return;
  }
  const open = state.changes.length <= 3;
  box.replaceChildren(
    ...state.changes.map((c) => {
      const locateBtn = el("button", { className: "btn ghost icon locate", title: "Show on canvas", textContent: "◎" });
      locateBtn.onclick = (e) => {
        e.preventDefault();
        locate(c.id);
      };
      const conflicted = !state.preview && hasMarkers(frameById(c.id)?.source ?? "");
      const status = conflicted ? "conflict" : c.status;
      const summary = el(
        "summary",
        {},
        el("span", { className: `badge ${status}`, textContent: status }),
        el("span", { className: "name", textContent: c.title || "Untitled" }),
        c.status === "removed" ? null : locateBtn,
      );
      const semantic = c.semantic.length
        ? el("ul", { className: "semantic" }, ...c.semantic.map((s) => el("li", { className: `k-${s.kind}`, textContent: s.text })))
        : null;
      const lines = c.lines.length
        ? el(
            "div",
            { className: "lines" },
            ...c.lines.map((l) =>
              el("div", {
                className: l.op === "+" ? "add" : l.op === "-" ? "del" : "ctx",
                textContent: `${l.op} ${l.text}`,
              }),
            ),
          )
        : null;
      return el("details", { className: "change", open: open && c.lines.length > 0 }, summary, semantic, lines);
    }),
  );
}

function layoutGraph(log) {
  const lanes = [];
  const pos = new Map();
  log.forEach((c, row) => {
    let col = lanes.indexOf(c.hash);
    if (col === -1) col = lanes.indexOf(null) === -1 ? lanes.length : lanes.indexOf(null);
    lanes.forEach((h, i) => {
      if (i !== col && h === c.hash) lanes[i] = null;
    });
    pos.set(c.hash, { row, col });
    lanes[col] = c.parents[0] ?? null;
    for (const p of c.parents.slice(1)) {
      if (lanes.includes(p)) continue;
      const free = lanes.indexOf(null);
      lanes[free === -1 ? lanes.length : free] = p;
    }
  });
  return pos;
}

function renderHistory() {
  const box = $("history");
  const ROW = 40;
  const LANE = 14;
  const pos = layoutGraph(state.log);
  const lanes = Math.max(1, ...[...pos.values()].map((p) => p.col + 1));
  const gutter = lanes * LANE + 12;
  const cx = (col) => 10 + col * LANE;
  const cy = (row) => row * ROW + ROW / 2;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.classList.add("graph");
  svg.setAttribute("width", gutter);
  svg.setAttribute("height", state.log.length * ROW);

  for (const c of state.log) {
    const a = pos.get(c.hash);
    c.parents.forEach((p, i) => {
      const b = pos.get(p);
      if (!b) return;
      const [x1, y1, x2, y2] = [cx(a.col), cy(a.row), cx(b.col), cy(b.row)];
      let d;
      if (x1 === x2) d = `M${x1},${y1} L${x2},${y2}`;
      else if (i > 0) d = `M${x1},${y1} C${x1},${y1 + ROW * 0.6} ${x2},${y1 + ROW * 0.4} ${x2},${y1 + ROW} L${x2},${y2}`;
      else d = `M${x1},${y1} L${x1},${y2 - ROW} C${x1},${y2 - ROW * 0.4} ${x2},${y2 - ROW * 0.6} ${x2},${y2}`;
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", LANE_COLORS[Math.max(a.col, b.col) % LANE_COLORS.length]);
      path.setAttribute("stroke-width", "2");
      svg.append(path);
    });
  }
  for (const c of state.log) {
    const a = pos.get(c.hash);
    const dot = document.createElementNS(NS, "circle");
    const isHead = c.hash === state.status.head;
    const color = LANE_COLORS[a.col % LANE_COLORS.length];
    dot.setAttribute("cx", cx(a.col));
    dot.setAttribute("cy", cy(a.row));
    dot.setAttribute("r", isHead ? 5.5 : 4);
    dot.setAttribute("fill", isHead ? "var(--panel)" : color);
    dot.setAttribute("stroke", color);
    dot.setAttribute("stroke-width", isHead ? 3 : 0);
    svg.append(dot);
  }

  const rows = state.log.map((c) => {
    const refs = c.refs.map((r) => el("span", { className: `ref${r === state.branch ? " head" : ""}`, textContent: r }));
    const row = el(
      "div",
      { className: `commit${state.preview?.hash === c.hash ? " active" : ""}`, title: `${c.hash}\n${c.message}` },
      el(
        "div",
        { className: "meta" },
        el("div", { className: "msg" }, ...refs, c.message),
        el(
          "div",
          { className: "sub" },
          el("code", { textContent: short(c.hash) }),
          `${c.author} · ${ago(c.time)}`,
          c.parents.length > 1 ? "· merge" : null,
          state.github
            ? Object.assign(
                el("a", { className: "gh", href: `/api/boards/${boardId}/github/commit/${c.hash}`, target: "_blank", rel: "noopener", title: "View on GitHub", textContent: "GitHub ↗" }),
                { onclick: (e) => e.stopPropagation() },
              )
            : null,
        ),
      ),
    );
    row.style.paddingLeft = `${gutter}px`;
    row.onclick = () => (state.preview?.hash === c.hash ? exitPreview() : enterPreview(c.hash));
    return row;
  });
  box.replaceChildren(svg, ...rows);
}

function enterPreview(hash) {
  const entry = state.log.find((c) => c.hash === hash);
  state.preview = { hash, entry, board: core.call("show", { rev: hash }) };
  closeEditor();
  state.selected = null;
  sendPresence();
  refreshVcs();
  renderPresence();
}

function exitPreview() {
  state.preview = null;
  refreshVcs();
  renderPresence();
}

function renderBanner() {
  const banner = $("banner");
  const btn = (label, onclick, cls = "ghost") =>
    Object.assign(el("button", { className: `btn ${cls}`, textContent: label }), { onclick });

  if (state.preview) {
    const { hash, entry } = state.preview;
    banner.className = "banner";
    banner.replaceChildren(
      el("span", {}, "Viewing ", el("code", { textContent: short(hash) }), ` “${entry?.message ?? ""}” · read-only`),
      btn("Restore this version", restoreVersion, "primary"),
      btn("Branch from here", () => newBranch(hash)),
      btn("Close", exitPreview),
    );
    banner.hidden = false;
  } else if (state.status.merging) {
    const n = state.board.frames.filter((f) => hasMarkers(f.source)).length;
    banner.className = `banner ${n ? "danger" : "warn"}`;
    banner.replaceChildren(
      el(
        "span",
        {},
        n
          ? `Merging ${state.status.merging}: fix ${plural(n, "conflicted diagram")} (see %% markers), then commit`
          : `Merging ${state.status.merging}: conflicts resolved, so commit to finish`,
      ),
      btn("Abort merge", abortMerge),
    );
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

function restoreVersion() {
  const board = structuredClone(state.preview.board);
  const from = short(state.preview.hash);
  state.preview = null;
  replaceBoard(doc(), board);
  renderPresence();
  toast(`Restored ${from} as uncommitted changes on ${state.branch}. Commit to keep it.`);
}

/** Branch from HEAD (optionally taking uncommitted changes along) or from a past commit. */
async function newBranch(from) {
  if (state.status.merging) return toast("Finish or abort the merge first", true);
  const name = prompt("New branch name", "feature/")?.trim();
  if (!name) return;
  await attempt(async () => {
    const start = from ?? state.status.head;
    await pushRef(name, null, start);
    await syncRefs();
    let carry;
    if (!from && state.status.dirty) {
      const move = confirm(
        `Take the uncommitted changes with you to ${name}?\n\nOK: move them (they'll be reset on ${state.branch} for everyone)\nCancel: leave them on ${state.branch}`,
      );
      if (move) {
        carry = structuredClone(state.board);
        replaceBoard(doc(), core.call("show", { rev: "HEAD" }));
      }
    }
    await joinBranch(name, { carry });
    toast(`Switched to new branch ${name}`);
  });
}

async function commit() {
  if (readonly() || state.committing) return;
  state.committing = true;
  $("commit").disabled = true;
  $("commit").textContent = state.github ? "Writing to GitHub…" : "Committing…";
  await attempt(async () => {
    const branch = state.branch;
    const prev = state.remoteRefs[branch];
    const merge = getMerge(doc());
    const hash = core.call("commit", { board: state.board, message: $("message").value, author: me.name, time: Date.now() });
    try {
      await pushRef(branch, prev, hash, [hash]);
    } catch (e) {
      // Undo locally; the server's history wins.
      core.call("set_ref", { name: branch, hash: prev });
      core.call("set_merge", merge);
      if (lostRace(e)) {
        await syncRefs();
        throw new Error("Someone else committed first. Review the changes and commit again.");
      }
      throw e;
    }
    if (merge.head) setMerge(doc(), null);
    $("message").value = "";
    toast(`Committed ${short(hash)} to ${branch}${state.github ? ` and ${state.github.repo}` : ""}`);
  });
  state.committing = false;
  $("commit").textContent = "Commit";
  refreshVcs();
}

async function merge(branch) {
  await attempt(async () => {
    const prev = state.remoteRefs[state.branch];
    const res = core.call("merge", { branch, board: state.board, author: me.name, time: Date.now() });
    if (res.kind === "up-to-date") return toast(`Already up to date with ${branch}`);
    if (res.kind === "conflicts") {
      replaceBoard(doc(), res.board);
      setMerge(doc(), state.remoteRefs[branch], branch);
      $("message").value = `Merge branch '${branch}'`;
      toast(`${plural(res.conflicts.length, "conflict")}: ${res.conflicts.map((c) => `${c.title} (${c.reason})`).join(", ")}`, true);
      locate(res.conflicts[0].id);
      return;
    }
    try {
      await pushRef(state.branch, prev, res.commit, [res.commit]);
    } catch (e) {
      core.call("set_ref", { name: state.branch, hash: prev });
      core.call("set_merge", { head: null, branch: null });
      if (lostRace(e)) {
        await syncRefs();
        throw new Error(`${state.branch} moved on the server. Try the merge again.`);
      }
      throw e;
    }
    replaceBoard(doc(), res.board);
    toast(res.kind === "fast-forward" ? `Fast-forwarded to ${branch}` : `Merged ${branch} cleanly (${short(res.commit)})`);
  });
}

function abortMerge() {
  setMerge(doc(), null);
  replaceBoard(doc(), core.call("merge_abort"));
  toast("Merge aborted");
}

// ---- toolbar & panel wiring -------------------------------------------------------

function toggleMenu(menu, build) {
  const show = menu.hidden;
  document.querySelectorAll(".menu").forEach((m) => (m.hidden = true));
  if (!show) return;
  menu.replaceChildren(...build());
  menu.hidden = false;
}

$("add-frame").onclick = (e) => {
  e.stopPropagation();
  toggleMenu($("template-menu"), () =>
    TEMPLATES.map((t) => Object.assign(el("button", { textContent: t.name }), { onclick: () => addFrame(t) })),
  );
};
$("merge").onclick = (e) => {
  e.stopPropagation();
  toggleMenu($("merge-menu"), () => {
    const others = state.status.branches.filter((b) => b !== state.branch);
    if (!others.length) return [el("div", { className: "empty", textContent: "No other branches" })];
    return others.map((b) => Object.assign(el("button", { textContent: `Merge ${b} → ${state.branch}` }), { onclick: () => merge(b) }));
  });
};
document.addEventListener("click", () => document.querySelectorAll(".menu").forEach((m) => (m.hidden = true)));

$("branch").onchange = async (e) => {
  const name = e.target.value;
  const leftDirty = state.status.dirty;
  const from = state.branch;
  await attempt(() => joinBranch(name));
  if (leftDirty) toast(`Uncommitted changes stay on ${from}`);
};
$("new-branch").onclick = () => newBranch();
$("commit").onclick = commit;
$("discard").onclick = () => {
  if (state.status.merging) return abortMerge();
  if (!confirm(`Discard all uncommitted changes on ${state.branch}? This affects everyone on the branch.`)) return;
  replaceBoard(doc(), core.call("show", { rev: "HEAD" }));
};
$("message").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
});

$("zoom-in").onclick = () => zoomCenter(1.2);
$("zoom-out").onclick = () => zoomCenter(1 / 1.2);
$("zoom-reset").onclick = () => zoomCenter(1 / state.view.k);
$("zoom-fit").onclick = fit;

$("export").onclick = () => {
  const data = { format: "mergit/1", repo: core.call("export"), board: state.board };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }));
  el("a", { href: url, download: `${$("board-name").textContent || "board"}.mergit.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$("share").onclick = async () => {
  await navigator.clipboard?.writeText(location.href).catch(() => {});
  toast("Link copied. Anyone with it can view and edit.");
};

// ---- canvas input -------------------------------------------------------------

canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 && e.button !== 1) return;
  if (e.target.closest(".banner")) return;
  select(null);
  canvas.focus();
  const start = { x: e.clientX, y: e.clientY, vx: state.view.x, vy: state.view.y };
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add("panning");
  const move = (ev) => {
    state.view.x = start.vx + ev.clientX - start.x;
    state.view.y = start.vy + ev.clientY - start.y;
    applyView();
  };
  const up = () => {
    canvas.removeEventListener("pointermove", move);
    canvas.removeEventListener("pointerup", up);
    canvas.classList.remove("panning");
    saveView();
  };
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
});

canvas.addEventListener("pointermove", (e) => sendPresence(toWorld(e.clientX, e.clientY)));
canvas.addEventListener("pointerleave", () => sendPresence(null));

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
    } else {
      state.view.x -= e.deltaX;
      state.view.y -= e.deltaY;
      applyView();
      saveView();
    }
  },
  { passive: false },
);

canvas.addEventListener("dblclick", (e) => {
  if (e.target.closest(".frame, .banner")) return;
  addFrame(TEMPLATES[0], toWorld(e.clientX, e.clientY));
});

document.addEventListener("keydown", (e) => {
  const typing = e.target.closest("input, textarea, select");
  if (e.key === "Escape") {
    if (state.editorOpen) closeEditor();
    else if (state.preview) exitPreview();
    else select(null);
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "s") {
    e.preventDefault();
    $("message").focus();
    return;
  }
  if (typing) return;
  if ((e.key === "Delete" || e.key === "Backspace") && state.selected) deleteFrame(state.selected);
  else if (e.key === "Enter" && state.selected) {
    e.preventDefault();
    openEditor(state.selected);
  } else if (e.key === "f") fit();
});

darkQuery.addEventListener("change", () => {
  initMermaid();
  svgCache.clear();
  for (const rec of frameEls.values()) rec.src = null;
  renderBoard();
});

// ---- boot -----------------------------------------------------------------------

try {
  const info = await api(`/api/boards/${boardId}`);
  document.title = `${info.name} · mergit`;
  $("board-name").textContent = info.name;
  state.github = info.github;
  $("github-link").after(githubButton());
  if (info.github) {
    Object.assign($("github-link"), { hidden: false, href: info.github.url, title: `History is stored in ${info.github.repo}/${info.github.path}` });
  }
  const requested = new URLSearchParams(location.search).get("branch");
  const branch = requested in info.refs ? requested : "main" in info.refs ? "main" : Object.keys(info.refs)[0];
  if (!branch) throw new Error("This board has no branches yet.");
  core.call("init_empty", { branch });
  await syncRefs(info.refs);
  applyView();
  renderPresence();
  await joinBranch(branch);
  $("loading").hidden = true;
  if (!prefs.get(`view.${boardId}`)) requestAnimationFrame(fit);
} catch (e) {
  console.error(e);
  $("loading").textContent = e.status === 404 ? "Board not found." : `Couldn't open this board: ${e.message}`;
}
