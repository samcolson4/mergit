// One Durable Object per board. It is the board's remote repository:
//
//  * objects  — content-addressed blobs/trees/commits, exactly as mergit-core
//               serialised them (verified by SHA-256 on the way in)
//  * refs     — branch → commit, updated only by compare-and-swap
//  * docs     — one live Yjs document per branch (the shared, uncommitted
//               working copy), relayed between WebSocket clients and
//               persisted as an append-only update log
//
// The server never merges or commits: clients do that with the same Rust core.

import { DurableObject } from "cloudflare:workers";
import * as Y from "yjs";
import { replaceBoard } from "../client/doc.js";

const BRANCH = /^[\p{L}\p{N}_][\p{L}\p{N}_\-./]*$/u;
const COLOR = /^#[0-9a-f]{6}$/i;
const COMPACT_AFTER = 200;

const json = (data, status = 200) => Response.json(data, { status });

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const toBuffer = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

export class Board extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.docs = new Map(); // branch → Y.Doc, rebuilt from storage after hibernation
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS objects (hash TEXT PRIMARY KEY, data TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS refs (name TEXT PRIMARY KEY, hash TEXT NOT NULL)");
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS doc_updates (id INTEGER PRIMARY KEY AUTOINCREMENT, branch TEXT NOT NULL, data BLOB NOT NULL)",
    );
  }

  get boardName() {
    return this.sql.exec("SELECT value FROM meta WHERE key = 'name'").toArray()[0]?.value ?? null;
  }

  refs() {
    return Object.fromEntries(this.sql.exec("SELECT name, hash FROM refs").toArray().map((r) => [r.name, r.hash]));
  }

  object(hash) {
    return this.sql.exec("SELECT data FROM objects WHERE hash = ?", hash).toArray()[0]?.data;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname.replace(/^\/api\/boards\/[^/]+/, "") || "/"}`;

    if (route === "POST /init") {
      if (this.boardName != null) return json({ error: "Board already exists" }, 409);
      const { name } = await request.json();
      this.sql.exec("INSERT INTO meta (key, value) VALUES ('name', ?)", name);
      return json({ ok: true });
    }
    if (this.boardName == null) return json({ error: "Board not found" }, 404);

    switch (route) {
      case "GET /":
        return json({ name: this.boardName, refs: this.refs() });
      case "POST /pack": {
        const { want, have = [] } = await request.json();
        return json({ objects: this.pack(want ?? Object.values(this.refs()), have) });
      }
      case "POST /refs":
        return this.updateRef(await request.json());
      case "GET /ws":
        return this.connect(request, url);
      default:
        return json({ error: "Not found" }, 404);
    }
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

  async updateRef({ name, old = null, new: next = null, objects = {}, by = "someone" }) {
    if (typeof name !== "string" || name.length > 100 || !BRANCH.test(name)) {
      return json({ error: `'${name}' is not a valid branch name` }, 400);
    }
    for (const [hash, data] of Object.entries(objects)) {
      if (typeof data !== "string" || (await sha256(data)) !== hash) {
        return json({ error: `Object ${hash.slice(0, 7)} failed verification` }, 400);
      }
    }

    // No awaits from here on: the check-and-set below can't interleave with another request.
    for (const [hash, data] of Object.entries(objects)) {
      this.sql.exec("INSERT OR IGNORE INTO objects (hash, data) VALUES (?, ?)", hash, data);
    }
    const current = this.refs()[name] ?? null;
    if (current !== old) return json({ error: "The branch moved on the server", current }, 409);

    if (next) {
      const data = this.object(next);
      if (!data || JSON.parse(data).type !== "commit") return json({ error: "Unknown commit" }, 400);
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
