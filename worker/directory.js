// A single Durable Object for everything that isn't one board:
//
//  * accounts & sessions — "Sign in with GitHub"; the session id is an opaque
//    random cookie value, and the user's GitHub token stays in here
//  * repo access         — which repos (through the App's installations) each
//    person can read or write, refreshed from GitHub every few minutes
//  * the board list      — each board's repo, folder and installation
//
// Access to a board follows access to its repository: write → edit, read → view.

import { DurableObject } from "cloudflare:workers";
import { apiBase, authorizeUrl, installationClient, installUrl, missingAppConfig, userToken } from "./app-auth.js";
import { GitHub } from "./github.js";

const SESSION_DAYS = 30;
const ACCESS_TTL = 5 * 60_000; // re-check repo access after this long
const SESSION_COOKIE = "mergit_session";
const STATE_COOKIE = "mergit_oauth";

const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers });

function randomId(bytes = 24) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newBoardId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
}

export function readCookie(request, name) {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}

function cookie(name, value, { maxAge, secure }) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

/** Only same-site relative paths are allowed as post-login destinations. */
const safeNext = (next) => (typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/");

export class Directory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const ddl of [
      `CREATE TABLE IF NOT EXISTS boards (
         id TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL,
         repo TEXT NOT NULL, installation_id INTEGER NOT NULL, path TEXT NOT NULL, branch TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS users (
         id INTEGER PRIMARY KEY, login TEXT NOT NULL, name TEXT,
         token TEXT NOT NULL, token_expires INTEGER NOT NULL, refresh TEXT, refresh_expires INTEGER,
         access_checked INTEGER NOT NULL DEFAULT 0)`,
      "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL)",
      `CREATE TABLE IF NOT EXISTS repo_access (
         user_id INTEGER NOT NULL, repo TEXT NOT NULL, installation_id INTEGER NOT NULL,
         permission TEXT NOT NULL, default_branch TEXT NOT NULL, private INTEGER NOT NULL,
         PRIMARY KEY (user_id, repo))`,
    ]) this.sql.exec(ddl);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;

    try {
      if (route === "GET /auth/login") return this.login(url);
      if (route === "GET /auth/callback") return await this.callback(request, url);
      if (route === "POST /auth/logout") return this.logout(request, url);

      const user = await this.sessionUser(request);
      if (!user) return json({ error: "Sign in to continue", signIn: true }, 401);

      switch (route) {
        case "GET /api/me":
          return json({ ...publicUser(user), installUrl: installUrl(this.env) });
        case "GET /api/repos":
          return json({ repos: await this.repos(user, url.searchParams.has("refresh")) });
        case "GET /api/folders":
          return await this.folders(user, url.searchParams.get("repo") ?? "", url.searchParams.get("path") ?? "");
        case "GET /api/boards":
          return await this.listBoards(user);
        case "POST /api/boards":
          return await this.createBoard(user, await request.json(), url.origin);
        case "POST /internal/authorize":
          return await this.authorize(user, (await request.json()).boardId);
      }
      return json({ error: "Not found" }, 404);
    } catch (e) {
      console.error("directory:", e.message);
      return json({ error: e.message }, e.status === 401 ? 401 : 502);
    }
  }

  // ---- sign in ------------------------------------------------------------------

  login(url) {
    const missing = missingAppConfig(this.env);
    if (missing.length) {
      return new Response(`mergit's GitHub App isn't configured on this server (missing ${missing.join(", ")}). See the README.`, {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    const state = randomId(16);
    const next = safeNext(url.searchParams.get("next"));
    return new Response(null, {
      status: 302,
      headers: {
        location: authorizeUrl(this.env, `${url.origin}/auth/callback`, state),
        "set-cookie": cookie(STATE_COOKIE, `${state}|${next}`, { maxAge: 600, secure: url.protocol === "https:" }),
      },
    });
  }

  async callback(request, url) {
    const [state, next] = (readCookie(request, STATE_COOKIE) ?? "").split("|");
    const secure = url.protocol === "https:";
    if (!state || state !== url.searchParams.get("state")) {
      return new Response("Sign-in expired or was started in another browser. Please try again.", { status: 400 });
    }
    const code = url.searchParams.get("code");
    if (!code) return new Response("GitHub didn't send an authorization code.", { status: 400 });

    const t = await userToken(this.env, { code, redirect_uri: `${url.origin}/auth/callback` });
    const profile = await new GitHub(t.token, apiBase(this.env)).request("GET", "/user");
    this.sql.exec(
      `INSERT INTO users (id, login, name, token, token_expires, refresh, refresh_expires, access_checked)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(id) DO UPDATE SET login = excluded.login, name = excluded.name, token = excluded.token,
         token_expires = excluded.token_expires, refresh = excluded.refresh, refresh_expires = excluded.refresh_expires,
         access_checked = 0`,
      profile.id, profile.login, profile.name ?? null, t.token, t.expires, t.refresh, t.refreshExpires,
    );
    const sid = randomId();
    this.sql.exec("INSERT INTO sessions (id, user_id, expires) VALUES (?, ?, ?)", sid, profile.id, Date.now() + SESSION_DAYS * 86_400_000);
    const headers = new Headers({ location: safeNext(next) });
    headers.append("set-cookie", cookie(SESSION_COOKIE, sid, { maxAge: SESSION_DAYS * 86_400, secure }));
    headers.append("set-cookie", cookie(STATE_COOKIE, "", { maxAge: 0, secure }));
    return new Response(null, { status: 302, headers });
  }

  logout(request, url) {
    const sid = readCookie(request, SESSION_COOKIE);
    if (sid) this.sql.exec("DELETE FROM sessions WHERE id = ?", sid);
    return json({ ok: true }, 200, { "set-cookie": cookie(SESSION_COOKIE, "", { maxAge: 0, secure: url.protocol === "https:" }) });
  }

  /** The signed-in user, with a fresh GitHub token (refreshed if needed), or null. */
  async sessionUser(request) {
    const sid = readCookie(request, SESSION_COOKIE);
    if (!sid) return null;
    const user = this.sql
      .exec("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires > ?", sid, Date.now())
      .toArray()[0];
    if (!user) return null;
    if (user.token_expires - Date.now() < 60_000) {
      if (!user.refresh || (user.refresh_expires && user.refresh_expires < Date.now())) return null;
      try {
        const t = await userToken(this.env, { grant_type: "refresh_token", refresh_token: user.refresh });
        this.sql.exec(
          "UPDATE users SET token = ?, token_expires = ?, refresh = ?, refresh_expires = ? WHERE id = ?",
          t.token, t.expires, t.refresh, t.refreshExpires, user.id,
        );
        Object.assign(user, { token: t.token, token_expires: t.expires });
      } catch {
        return null; // refresh token revoked or expired: sign in again
      }
    }
    return user;
  }

  // ---- repo access ------------------------------------------------------------------

  /** Repos the user can reach through the App's installations, cached for a few minutes. */
  async repos(user, force = false) {
    if (force || Date.now() - user.access_checked > ACCESS_TTL) {
      const gh = new GitHub(user.token, apiBase(this.env));
      const rows = [];
      const { installations } = await gh.request("GET", "/user/installations?per_page=100");
      for (const inst of installations) {
        for (let page = 1; ; page++) {
          const { repositories } = await gh.request("GET", `/user/installations/${inst.id}/repositories?per_page=100&page=${page}`);
          for (const r of repositories) {
            const p = r.permissions ?? {};
            const permission = p.push || p.admin || p.maintain ? "write" : p.pull || p.triage ? "read" : null;
            if (permission) rows.push([r.full_name, inst.id, permission, r.default_branch ?? "main", r.private ? 1 : 0]);
          }
          if (repositories.length < 100) break;
        }
      }
      this.ctx.storage.transactionSync(() => {
        this.sql.exec("DELETE FROM repo_access WHERE user_id = ?", user.id);
        for (const r of rows) {
          this.sql.exec(
            "INSERT INTO repo_access (user_id, repo, installation_id, permission, default_branch, private) VALUES (?, ?, ?, ?, ?, ?)",
            user.id, ...r,
          );
        }
        this.sql.exec("UPDATE users SET access_checked = ? WHERE id = ?", Date.now(), user.id);
      });
      user.access_checked = Date.now();
    }
    return this.sql
      .exec(
        "SELECT repo, installation_id AS installationId, permission, default_branch AS branch, private FROM repo_access WHERE user_id = ? ORDER BY repo",
        user.id,
      )
      .toArray()
      .map((r) => ({ ...r, private: Boolean(r.private) }));
  }

  async access(user, repo) {
    let row = (await this.repos(user)).find((r) => r.repo === repo);
    // Newly granted access shouldn't need a five-minute wait.
    if (!row && Date.now() - user.access_checked > 30_000) row = (await this.repos(user, true)).find((r) => r.repo === repo);
    return row ?? null;
  }

  async authorize(user, boardId) {
    const board = this.sql.exec("SELECT * FROM boards WHERE id = ?", boardId).toArray()[0];
    if (!board) return json({ error: "Board not found" }, 404);
    const access = await this.access(user, board.repo);
    if (!access) return json({ error: `You don't have access to ${board.repo}, where this board is stored.`, repo: board.repo }, 403);
    return json({ user: publicUser(user), role: access.permission === "write" ? "edit" : "view" });
  }

  // ---- folders ----------------------------------------------------------------------

  /** Sub-folders of `path` in a repo, for the folder picker. */
  async folders(user, repo, path) {
    const access = await this.access(user, repo);
    if (!access) return json({ error: `You don't have access to ${repo}` }, 403);
    path = path.replace(/^\/+|\/+$/g, "");
    if (path.split("/").some((p) => p === "." || p === "..")) return json({ error: "Invalid folder" }, 400);

    const gh = await installationClient(this.env, access.installationId);
    const encoded = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    const items = (await gh.maybe(gh.request("GET", `/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(access.branch)}`))) ?? [];
    const list = Array.isArray(items) ? items : [];
    const boards = new Map(this.sql.exec("SELECT id, path FROM boards WHERE repo = ?", repo).toArray().map((b) => [b.path, b.id]));
    return json({
      repo,
      branch: access.branch,
      path,
      exists: list.length > 0,
      isBoard: list.some((i) => i.type === "file" && i.name === "board.json"),
      hasFiles: list.some((i) => i.type === "file"),
      boardId: boards.get(path) ?? null,
      folders: list
        .filter((i) => i.type === "dir")
        .map((i) => ({ name: i.name, path: i.path, boardId: boards.get(i.path) ?? null }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  }

  // ---- boards -----------------------------------------------------------------------

  async listBoards(user) {
    const repos = new Map((await this.repos(user)).map((r) => [r.repo, r]));
    const boards = this.sql
      .exec("SELECT id, name, created, repo, path, branch FROM boards ORDER BY created DESC")
      .toArray()
      .filter((b) => repos.has(b.repo))
      .map((b) => ({ ...b, role: repos.get(b.repo).permission === "write" ? "edit" : "view" }));
    return json({ boards });
  }

  async createBoard(user, { name, repo, path }, origin) {
    const clean = typeof name === "string" ? name.trim().slice(0, 80) : "";
    if (!clean) return json({ error: "A board name is required" }, 400);
    const access = await this.access(user, repo);
    if (!access) return json({ error: `You don't have access to ${repo}` }, 403);
    if (access.permission !== "write") return json({ error: `You can view ${repo} but not write to it` }, 403);
    path = String(path ?? "").trim().replace(/^\/+|\/+$/g, "");

    const existing = this.sql.exec("SELECT id FROM boards WHERE repo = ? AND path = ?", repo, path).toArray()[0];
    if (existing) return json({ error: "That folder already has a board.", boardId: existing.id }, 409);

    const id = newBoardId();
    const board = this.env.BOARD.get(this.env.BOARD.idFromName(id));
    const res = await board.fetch(`https://board/api/boards/${id}/init`, {
      method: "POST",
      body: JSON.stringify({
        name: clean,
        url: `${origin}/b/${id}`,
        github: { repo, path, branch: access.branch, installationId: access.installationId },
      }),
    });
    const result = await res.json();
    if (!res.ok) return json({ error: result.error ?? "Could not create board" }, res.status);
    this.sql.exec(
      "INSERT INTO boards (id, name, created, repo, installation_id, path, branch) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id, clean, Date.now(), repo, access.installationId, path, access.branch,
    );
    return json({ id, name: clean, imported: result.imported ?? 0 });
  }
}

function publicUser(u) {
  return { id: u.id, login: u.login, name: u.name || u.login };
}
