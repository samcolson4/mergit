// One Durable Object per board.
//
//  * objects  — content-addressed blobs/trees/commits, exactly as mergit-core
//               serialised them (verified by SHA-256 on the way in)
//  * refs     — branch → commit, updated only by compare-and-swap
//  * docs     — one live Yjs document per branch (the shared, uncommitted
//               working copy), relayed between WebSocket clients and
//               persisted as an append-only update log
//
// For GitHub-backed boards, history's source of truth is the git repository:
// a ref only moves here after the commit has been written to GitHub, and the
// objects/refs tables are a cache that can be rebuilt from it (see git-store.js).
// The live documents always stay here: they change on every keystroke.
//
// The server never merges or commits on its own: clients do that with the Rust core.

import { DurableObject } from "cloudflare:workers";
import * as Y from "yjs";
import { replaceBoard } from "../client/doc.js";
import { GitHub } from "./github.js";
import { GitStore, NeedsTokenError, slug } from "./git-store.js";
import { sha256 } from "./objects.js";

const BRANCH = /^[\p{L}\p{N}_][\p{L}\p{N}_\-./]*$/u;
const COLOR = /^#[0-9a-f]{6}$/i;
const COMPACT_AFTER = 200;

const json = (data, status = 200) => Response.json(data, { status });
const toBuffer = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

/** Branch names must also be valid inside git ref names. */
function validBranch(name) {
  return (
    typeof name === "string" &&
    name.length <= 100 &&
    BRANCH.test(name) &&
    !/\.\.|\/\/|\/\.|@\{|\.lock$|[/.]$/.test(name)
  );
}

/** Reject objects the core would never produce (beyond the hash check). */
function validObject(data) {
  let o;
  try {
    o = JSON.parse(data);
  } catch {
    return false;
  }
  if (o.type === "blob") return typeof o.data === "string" && o.data.length <= 200_000;
  if (o.type === "tree") {
    return Array.isArray(o.entries) && o.entries.length <= 500 &&
      o.entries.every((e) => typeof e.id === "string" && typeof e.title === "string" && typeof e.blob === "string" &&
        [e.x, e.y, e.w, e.h].every(Number.isInteger));
  }
  if (o.type === "commit") {
    return typeof o.tree === "string" && Array.isArray(o.parents) && o.parents.length <= 2 &&
      typeof o.message === "string" && o.message.length <= 10_000 &&
      typeof o.author === "string" && o.author.length <= 100 && !/[\n<>]/.test(o.author) &&
      Number.isInteger(o.time);
  }
  return false;
}

export class Board extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.docs = new Map(); // branch → Y.Doc, rebuilt from storage after hibernation
    this.refQueue = Promise.resolve(); // ref updates run one at a time (they await GitHub)
    for (const ddl of [
      "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS objects (hash TEXT PRIMARY KEY, data TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS refs (name TEXT PRIMARY KEY, hash TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS doc_updates (id INTEGER PRIMARY KEY AUTOINCREMENT, branch TEXT NOT NULL, data BLOB NOT NULL)",
      // mergit commit → the git commit it was written as
      "CREATE TABLE IF NOT EXISTS git_commits (mergit TEXT PRIMARY KEY, git TEXT NOT NULL, root TEXT NOT NULL, folder TEXT NOT NULL)",
      // what we last wrote to each branch's git ref
      "CREATE TABLE IF NOT EXISTS git_branches (name TEXT PRIMARY KEY, git TEXT NOT NULL, root TEXT NOT NULL, folder TEXT NOT NULL)",
    ]) this.sql.exec(ddl);
  }

  meta(key) {
    return this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value ?? null;
  }

  setMeta(key, value) {
    this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  get boardName() {
    return this.meta("name");
  }

  get githubConfig() {
    const raw = this.meta("github");
    return raw ? JSON.parse(raw) : null;
  }

  refs() {
    return Object.fromEntries(this.sql.exec("SELECT name, hash FROM refs").toArray().map((r) => [r.name, r.hash]));
  }

  object(hash) {
    return this.sql.exec("SELECT data FROM objects WHERE hash = ?", hash).toArray()[0]?.data;
  }

  /**
   * GitHub access for one request: the person's own token if they sent one,
   * else the server's fallback token (if configured).
   */
  gitStore(cfg = this.githubConfig, token = null) {
    if (!cfg) return null;
    token ||= this.env.GITHUB_TOKEN;
    if (!token) throw new NeedsTokenError("This board's history is stored on GitHub. Add your GitHub token to continue.");
    const gh = new GitHub(token, this.env.GITHUB_API_URL || undefined);
    const row = (table, key, value) => this.sql.exec(`SELECT git, root, folder FROM ${table} WHERE ${key} = ?`, value).toArray()[0] ?? null;
    return new GitStore(gh, cfg, {
      object: (h) => this.object(h),
      mapping: (h) => row("git_commits", "mergit", h),
      setMapping: (h, m) =>
        this.sql.exec("INSERT OR REPLACE INTO git_commits (mergit, git, root, folder) VALUES (?, ?, ?, ?)", h, m.git, m.root, m.folder),
      branchState: (name) => row("git_branches", "name", name),
      setBranchState: (name, s) =>
        s
          ? this.sql.exec("INSERT OR REPLACE INTO git_branches (name, git, root, folder) VALUES (?, ?, ?, ?)", name, s.git, s.root, s.folder)
          : this.sql.exec("DELETE FROM git_branches WHERE name = ?", name),
    });
  }

  /** Who a token belongs to, cached in memory by a hash of the token. */
  async githubUser(gh, token) {
    this.users ??= new Map();
    const key = await sha256(token);
    if (!this.users.has(key)) {
      const user = await gh.request("GET", "/user").catch(() => null);
      if (!user) return null;
      this.users.set(key, { id: user.id, login: user.login });
    }
    return this.users.get(key);
  }

  githubInfo() {
    const cfg = this.githubConfig;
    if (!cfg) return null;
    const web = (this.env.GITHUB_WEB_URL || "https://github.com").replace(/\/$/, "");
    return { repo: cfg.repo, path: cfg.path, branch: cfg.branch, url: `${web}/${cfg.repo}/tree/${cfg.branch}/${cfg.path}` };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname.replace(/^\/api\/boards\/[^/]+/, "") || "/"}`;

    const token = request.headers.get("x-github-token");
    if (route === "POST /init") return this.init(await request.json(), token);
    if (this.boardName == null) return json({ error: "Board not found" }, 404);

    switch (route) {
      case "GET /":
        return json({ name: this.boardName, refs: this.refs(), github: this.githubInfo() });
      case "POST /pack": {
        const { want, have = [] } = await request.json();
        return json({ objects: this.pack(want ?? Object.values(this.refs()), have) });
      }
      case "POST /refs":
        return this.updateRef(await request.json(), token);
      case "GET /ws":
        return this.connect(request, url);
    }
    const commit = route.match(/^GET \/github\/commit\/([0-9a-f]{64})$/);
    if (commit) {
      const row = this.sql.exec("SELECT git FROM git_commits WHERE mergit = ?", commit[1]).toArray()[0];
      const info = this.githubInfo();
      if (!row || !info) return json({ error: "Not on GitHub" }, 404);
      const web = (this.env.GITHUB_WEB_URL || "https://github.com").replace(/\/$/, "");
      return Response.redirect(`${web}/${info.repo}/commit/${row.git}`, 302);
    }
    return json({ error: "Not found" }, 404);
  }

  /**
   * Create the board. With `github`, validate access and, if the folder
   * already holds mergit history, import it: that's also how a board is
   * recovered from GitHub.
   */
  async init({ name, url, github }, token) {
    if (this.boardName != null) return json({ error: "Board already exists" }, 409);
    let imported = 0;
    if (github) {
      const repo = String(github.repo ?? "").trim();
      const path = String(github.path ?? "").trim().replace(/^\/+|\/+$/g, "");
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: "GitHub repo must look like owner/name" }, 400);
      if (!path || path.split("/").some((p) => !p || p === "." || p === "..")) {
        return json({ error: "Choose a folder for the board, e.g. diagrams/my-board" }, 400);
      }
      try {
        const store = this.gitStore({ repo, path, branch: "", prefix: `mergit/${slug(path)}`, name, url }, token);
        const info = await store.gh.getRepo(repo);
        if (info.permissions && !info.permissions.push) return json({ error: `The server's token can't write to ${repo}` }, 400);
        const branch = String(github.branch ?? "").trim() || info.default_branch;
        if (!(await store.gh.branchSha(repo, branch))) {
          return json({ error: `${repo} has no branch '${branch}' (an empty repository needs one commit first)` }, 400);
        }
        store.cfg.branch = branch;
        const rebuilt = await store.rebuild();
        this.setMeta("github", JSON.stringify(store.cfg));
        if (rebuilt) {
          for (const [hash, data] of rebuilt.objects) this.sql.exec("INSERT OR IGNORE INTO objects (hash, data) VALUES (?, ?)", hash, data);
          for (const [hash, m] of rebuilt.mappings) store.db.setMapping(hash, m);
          for (const [n, s] of Object.entries(rebuilt.branchStates)) store.db.setBranchState(n, s);
          for (const [n, h] of Object.entries(rebuilt.refs)) this.sql.exec("INSERT INTO refs (name, hash) VALUES (?, ?)", n, h);
          imported = rebuilt.commits;
        }
      } catch (e) {
        this.sql.exec("DELETE FROM meta");
        if (e.needsToken) return json({ error: e.message, needsToken: true }, 401);
        const status = e.status === 401 || e.status === 403 || e.status === 404 ? 400 : (e.status ?? 500);
        const message = e.status === 404 ? `Couldn't find ${repo}, or your token doesn't have access to it` : e.message;
        return json({ error: message }, status);
      }
    }
    this.setMeta("name", name);
    this.setMeta("url", url ?? "");
    return json({ ok: true, imported });
  }

  /** Objects reachable from `want`, not walking past commits the client already has. */
  pack(want, have) {
    const seen = new Set(have);
    const stack = [...want];
    const out = {};
    while (stack.length) {
      const hash = stack.pop();
      if (seen.has(hash)) continue;
      seen.add(hash);
      const data = this.object(hash);
      if (!data) continue;
      out[hash] = data;
      const o = JSON.parse(data);
      if (o.type === "commit") stack.push(o.tree, ...o.parents);
      else if (o.type === "tree") stack.push(...o.entries.map((e) => e.blob));
    }
    return out;
  }

  /** True if the commit and everything it references is stored. */
  complete(hash) {
    const seen = new Set();
    const stack = [hash];
    while (stack.length) {
      const h = stack.pop();
      if (seen.has(h)) continue;
      seen.add(h);
      const data = this.object(h);
      if (!data) return false;
      const o = JSON.parse(data);
      if (o.type === "commit") stack.push(o.tree, ...o.parents);
      else if (o.type === "tree") stack.push(...o.entries.map((e) => e.blob));
    }
    return true;
  }

  async updateRef({ name, old = null, new: next = null, objects = {}, by = "someone" }, token) {
    if (!validBranch(name)) return json({ error: `'${name}' is not a valid branch name` }, 400);
    for (const [hash, data] of Object.entries(objects)) {
      if (typeof data !== "string" || (await sha256(data)) !== hash || !validObject(data)) {
        return json({ error: `Object ${hash.slice(0, 7)} failed verification` }, 400);
      }
    }
    for (const [hash, data] of Object.entries(objects)) {
      this.sql.exec("INSERT OR IGNORE INTO objects (hash, data) VALUES (?, ?)", hash, data);
    }

    // Ref updates wait for GitHub, so they're queued: the compare-and-swap
    // and the GitHub write happen as one step per board.
    const run = this.refQueue.then(() => this.applyRef(name, old, next, by, token));
    this.refQueue = run.catch(() => {});
    return run;
  }

  async applyRef(name, old, next, by, token) {
    const current = this.refs()[name] ?? null;
    if (current !== old) return json({ error: "The branch moved on the server", current }, 409);
    if (next) {
      const data = this.object(next);
      if (!data || JSON.parse(data).type !== "commit" || !this.complete(next)) {
        return json({ error: "Unknown or incomplete commit" }, 400);
      }
    } else if (name === "main") {
      return json({ error: "main can't be deleted" }, 400);
    }

    try {
      const store = this.gitStore(this.githubConfig, token);
      if (store) {
        // Commits are made by the token's owner; link them to their GitHub profile.
        const me = await this.githubUser(store.gh, token || this.env.GITHUB_TOKEN);
        if (me) store.email = `${me.id}+${me.login}@users.noreply.github.com`;
        await store.writeBranch(name, old, next);
      }
    } catch (e) {
      if (e.needsToken) return json({ error: e.message, needsToken: true, github: true }, 401);
      console.error("GitHub write failed:", e.message);
      const message = e.status === 401 ? "GitHub rejected your token (expired or revoked?). Update it in GitHub settings." : e.message;
      return json({ error: message, github: true, needsToken: e.status === 401 }, e.status === 409 ? 409 : e.status === 401 ? 401 : 502);
    }

    if (next) {
      this.sql.exec("INSERT INTO refs (name, hash) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET hash = excluded.hash", name, next);
    } else {
      this.sql.exec("DELETE FROM refs WHERE name = ?", name);
      this.sql.exec("DELETE FROM doc_updates WHERE branch = ?", name);
      this.docs.delete(name);
    }
    this.broadcast({ type: "ref", name, hash: next, by: String(by).slice(0, 40) });
    return json({ ok: true });
  }

  boardAt(commit) {
    const c = JSON.parse(this.object(commit));
    const tree = JSON.parse(this.object(c.tree));
    return {
      frames: tree.entries.map((e) => ({
        id: e.id, title: e.title, x: e.x, y: e.y, w: e.w, h: e.h,
        source: JSON.parse(this.object(e.blob)).data,
      })),
    };
  }

  /** The live document for a branch; seeded from its head commit the first time. */
  loadDoc(branch) {
    let doc = this.docs.get(branch);
    if (doc) return doc;
    doc = new Y.Doc();
    const rows = this.sql.exec("SELECT data FROM doc_updates WHERE branch = ? ORDER BY id", branch).toArray();
    if (rows.length) {
      for (const row of rows) Y.applyUpdate(doc, new Uint8Array(row.data));
    } else {
      // Seeding happens only here, on the server, so two clients can never
      // both seed the same document and duplicate its contents.
      const head = this.refs()[branch];
      if (head) replaceBoard(doc, this.boardAt(head));
      this.sql.exec("INSERT INTO doc_updates (branch, data) VALUES (?, ?)", branch, toBuffer(Y.encodeStateAsUpdate(doc)));
    }
    this.docs.set(branch, doc);
    return doc;
  }

  compact(branch, doc) {
    const { n } = this.sql.exec("SELECT COUNT(*) AS n FROM doc_updates WHERE branch = ?", branch).one();
    if (n < COMPACT_AFTER) return;
    this.sql.exec("DELETE FROM doc_updates WHERE branch = ?", branch);
    this.sql.exec("INSERT INTO doc_updates (branch, data) VALUES (?, ?)", branch, toBuffer(Y.encodeStateAsUpdate(doc)));
  }

  connect(request, url) {
    if (request.headers.get("Upgrade") !== "websocket") return json({ error: "Expected a WebSocket" }, 426);
    const branch = url.searchParams.get("branch") ?? "main";
    if (!(branch in this.refs())) return json({ error: `No branch '${branch}'` }, 404);

    const [client, server] = Object.values(new WebSocketPair());
    const color = url.searchParams.get("color") ?? "";
    const peer = {
      id: crypto.randomUUID().slice(0, 8),
      name: (url.searchParams.get("name") || "Anonymous").slice(0, 40),
      color: COLOR.test(color) ? color : "#ff3670",
      branch,
      selected: null,
      cursor: null,
    };
    // Hibernatable socket: the object can sleep between messages without dropping clients.
    this.ctx.acceptWebSocket(server, [branch]);
    server.serializeAttachment(peer);

    server.send(JSON.stringify({ type: "hello", id: peer.id }));
    server.send(Y.encodeStateAsUpdate(this.loadDoc(branch)));
    server.send(JSON.stringify({ type: "synced" }));
    this.broadcastPeers();
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    const peer = ws.deserializeAttachment();
    if (typeof message === "string") {
      let msg;
      try {
        msg = JSON.parse(message);
      } catch {
        return;
      }
      if (msg.type === "presence") {
        peer.selected = typeof msg.selected === "string" ? msg.selected : null;
        peer.cursor = msg.cursor && Number.isFinite(msg.cursor.x) && Number.isFinite(msg.cursor.y) ? msg.cursor : null;
        ws.serializeAttachment(peer);
        this.broadcastPeers();
      }
      return;
    }

    const doc = this.loadDoc(peer.branch);
    try {
      Y.applyUpdate(doc, new Uint8Array(message));
    } catch {
      return; // malformed update: drop it rather than persisting garbage
    }
    this.sql.exec("INSERT INTO doc_updates (branch, data) VALUES (?, ?)", peer.branch, message);
    for (const other of this.ctx.getWebSockets(peer.branch)) {
      if (other !== ws) {
        try {
          other.send(message);
        } catch {}
      }
    }
    this.compact(peer.branch, doc);
  }

  webSocketClose(ws, code) {
    try {
      ws.close(code, "bye");
    } catch {}
    this.broadcastPeers(ws);
  }

  webSocketError(ws) {
    this.broadcastPeers(ws);
  }

  sockets(except) {
    return this.ctx.getWebSockets().filter((ws) => ws !== except && ws.readyState === 1 /* OPEN */);
  }

  broadcast(msg, except) {
    const text = JSON.stringify(msg);
    for (const ws of this.sockets(except)) {
      try {
        ws.send(text);
      } catch {}
    }
  }

  broadcastPeers(except) {
    const peers = this.sockets(except).map((ws) => ws.deserializeAttachment());
    this.broadcast({ type: "peers", peers }, except);
  }
}
