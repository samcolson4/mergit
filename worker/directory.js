// A single Durable Object that lists boards. Each board's content lives in its own Board object.

import { DurableObject } from "cloudflare:workers";

const json = (data, status = 200) => Response.json(data, { status });

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
}

export class Directory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS boards (id TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL)");
  }

  async fetch(request) {
    if (request.method === "GET") {
      return json({ boards: this.sql.exec("SELECT id, name, created FROM boards ORDER BY created DESC").toArray() });
    }
    if (request.method === "POST") {
      const { name, github } = await request.json().catch(() => ({}));
      const clean = typeof name === "string" ? name.trim().slice(0, 80) : "";
      if (!clean) return json({ error: "A board name is required" }, 400);
      const id = newId();
      const board = this.env.BOARD.get(this.env.BOARD.idFromName(id));
      const url = `${new URL(request.url).origin}/b/${id}`;
      const token = request.headers.get("x-github-token");
      const res = await board.fetch(`https://board/api/boards/${id}/init`, {
        method: "POST",
        headers: token ? { "x-github-token": token } : {},
        body: JSON.stringify({ name: clean, url, github: github ?? null }),
      });
      const result = await res.json();
      if (!res.ok) return json({ error: result.error ?? "Could not create board" }, res.status);
      this.sql.exec("INSERT INTO boards (id, name, created) VALUES (?, ?, ?)", id, clean, Date.now());
      return json({ id, name: clean, imported: result.imported ?? 0 });
    }
    return json({ error: "Method not allowed" }, 405);
  }
}
