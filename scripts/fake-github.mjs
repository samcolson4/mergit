// An in-memory stand-in for the parts of the GitHub REST API mergit uses,
// for local development and testing without a real token or repository.
//
//   node scripts/fake-github.mjs            # listens on http://127.0.0.1:8788
//
// Any repository you ask for exists, starting with one commit on `main`.
//
// GitHub App behaviour: one installation (id 1) on the "acme" account with
// acme/diagrams and acme/platform. Sign-in shows a form where you type any
// username; "viewer" gets read-only access and "outsider" gets none.
// App JWTs are verified against FAKE_APP_PUBLIC_KEY (a PEM file), if set.
// Test helpers (not GitHub APIs):
//   GET  /_log/:owner/:repo/:branch          text log of the branch, with each commit's files
//   GET  /_file/:owner/:repo/:branch/<path>  raw file contents at the branch tip
//   POST /_commit/:owner/:repo/:branch       {path, content, message}: someone else's commit
//   GET  /web/...                            stands in for github.com links

import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 8788);
const appPublicKey = process.env.FAKE_APP_PUBLIC_KEY ? createPublicKey(readFileSync(process.env.FAKE_APP_PUBLIC_KEY)) : null;
const INSTALLATION = { id: 1, account: "acme", repos: ["acme/diagrams", "acme/platform"] };
const fail = (status, message) => Object.assign(new Error(message), { status });

/** Who a token is: user tokens are ghu_<login>, installation tokens ghs_… (the App). */
function identity(token) {
  if (token.startsWith("ghu_")) return { kind: "user", login: token.slice(4) };
  if (token.startsWith("ghs_")) return { kind: "app", login: "mergit-dev[bot]" };
  return { kind: "user", login: (token === "fake-token" ? "fake-user" : token).replace(/[^\w-]/g, "").slice(0, 39) || "user" };
}

const userId = (login) => [...login].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1e7, 7);
const permissionsFor = (login) =>
  login === "outsider" ? null : login === "viewer" ? { pull: true, push: false, admin: false } : { pull: true, push: true, admin: false };

function verifyAppJwt(jwt) {
  const [h, p, sig] = jwt.split(".");
  if (!sig) throw fail(401, "A JSON web token could not be decoded");
  const payload = JSON.parse(Buffer.from(p, "base64url").toString());
  if (appPublicKey && !verify("RSA-SHA256", Buffer.from(`${h}.${p}`), appPublicKey, Buffer.from(sig, "base64url"))) {
    throw fail(401, "JWT signature does not match");
  }
  if (payload.exp < Date.now() / 1000) throw fail(401, "JWT expired");
  if (process.env.FAKE_APP_ID && String(payload.iss) !== process.env.FAKE_APP_ID) throw fail(401, "JWT issuer mismatch");
}

const page = (body) => ({
  html: `<!doctype html><meta charset="utf-8"><title>Fake GitHub</title>
<body style="font:15px system-ui;max-width:420px;margin:80px auto;padding:0 16px">${body}</body>`,
});
const repos = new Map();
let clock = Date.parse("2026-01-01T00:00:00Z");

function repoFor(name) {
  if (!repos.has(name)) {
    const repo = { objects: new Map(), refs: new Map() };
    repos.set(name, repo);
    const blob = put(repo, { type: "blob", content: `# ${name}\n` });
    const tree = put(repo, { type: "tree", entries: [{ path: "README.md", mode: "100644", type: "blob", sha: blob }] });
    const commit = put(repo, {
      type: "commit", tree, parents: [], message: "Initial commit",
      author: { name: "Repo Owner", email: "owner@example.com", date: new Date(clock).toISOString() },
    });
    repo.refs.set("main", commit);
  }
  return repos.get(name);
}

function put(repo, obj) {
  const sha = createHash("sha1").update(JSON.stringify(obj)).digest("hex");
  repo.objects.set(sha, obj);
  return sha;
}

const get = (repo, sha, type) => {
  const o = repo.objects.get(sha);
  if (!o || (type && o.type !== type)) throw Object.assign(new Error("Not Found"), { status: 404 });
  return o;
};

/** GitHub's create-tree semantics: optional base tree, nested paths, inline content, sha: null deletes. */
function writeTree(repo, baseSha, changes) {
  const entries = new Map(baseSha ? get(repo, baseSha, "tree").entries.map((e) => [e.path, e]) : []);
  const groups = new Map();
  for (const c of changes) {
    const [first, ...rest] = c.parts;
    if (!groups.has(first)) groups.set(first, []);
    groups.get(first).push({ parts: rest, entry: c.entry });
  }
  for (const [name, group] of groups) {
    const direct = group.find((c) => c.parts.length === 0);
    if (direct) {
      const e = direct.entry;
      if (e.sha === null) entries.delete(name);
      else {
        const sha = e.content !== undefined ? put(repo, { type: "blob", content: e.content }) : e.sha;
        entries.set(name, { path: name, mode: e.mode, type: e.type, sha });
      }
    } else {
      const existing = entries.get(name);
      const sub = writeTree(repo, existing?.type === "tree" ? existing.sha : null, group);
      entries.set(name, { path: name, mode: "040000", type: "tree", sha: sub });
    }
  }
  return put(repo, { type: "tree", entries: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)) });
}

function treeAt(repo, treeSha, path) {
  let sha = treeSha;
  for (const part of path.split("/").filter(Boolean)) {
    const e = get(repo, sha, "tree").entries.find((x) => x.path === part);
    if (!e) return null;
    sha = e.sha;
  }
  return sha;
}

function ancestors(repo, sha) {
  const seen = new Set();
  const stack = [sha];
  while (stack.length) {
    const s = stack.pop();
    if (seen.has(s)) continue;
    seen.add(s);
    stack.push(...get(repo, s, "commit").parents);
  }
  return seen;
}

function files(repo, treeSha, prefix = "") {
  return get(repo, treeSha, "tree").entries.flatMap((e) =>
    e.type === "tree" ? files(repo, e.sha, `${prefix}${e.path}/`) : [`${prefix}${e.path}`],
  );
}

const commitJson = (sha, c) => ({
  sha,
  tree: { sha: c.tree },
  parents: c.parents.map((p) => ({ sha: p })),
  message: c.message,
  author: c.author,
});

function route(method, path, query, body, token) {
  let m;
  if ((m = path.match(/^\/_log\/([^/]+\/[^/]+)\/(.+)$/))) {
    const repo = repoFor(m[1]);
    const lines = [];
    const order = [...ancestors(repo, repo.refs.get(m[2]))]
      .map((sha) => [sha, get(repo, sha)])
      .sort((a, b) => Date.parse(b[1].author.date) - Date.parse(a[1].author.date));
    for (const [sha, c] of order) {
      const by = c.committer && c.committer !== c.author.name ? ` (committed by @${c.committer})` : "";
      lines.push(`${sha.slice(0, 7)} ${c.parents.length > 1 ? "(merge) " : ""}${c.author.name} <${c.author.email}>${by}: ${c.message.split("\n")[0]}`);
      lines.push(...files(repo, c.tree).map((f) => `    ${f}`));
    }
    return { text: lines.join("\n") + "\n" };
  }
  if ((m = path.match(/^\/_file\/([^/]+\/[^/]+)\/([^/]+)\/(.+)$/))) {
    const repo = repoFor(m[1]);
    const tree = get(repo, repo.refs.get(m[2])).tree;
    const parts = m[3].split("/");
    const dir = treeAt(repo, tree, parts.slice(0, -1).join("/"));
    const e = dir && get(repo, dir).entries.find((x) => x.path === parts.at(-1));
    if (!e) throw Object.assign(new Error("Not Found"), { status: 404 });
    return { text: get(repo, e.sha).content };
  }
  if ((m = path.match(/^\/_commit\/([^/]+\/[^/]+)\/(.+)$/)) && method === "POST") {
    const repo = repoFor(m[1]);
    const tip = repo.refs.get(m[2]);
    const tree = writeTree(repo, get(repo, tip).tree, [{ parts: body.path.split("/"), entry: { mode: "100644", type: "blob", content: body.content } }]);
    clock += 60_000;
    const sha = put(repo, {
      type: "commit", tree, parents: [tip], message: body.message ?? `Update ${body.path}`,
      author: { name: "Someone Else", email: "else@example.com", date: new Date(clock).toISOString() },
    });
    repo.refs.set(m[2], sha);
    return { json: { sha } };
  }
  if (path === "/web/login/oauth/authorize") {
    const q = (k) => String(query.get(k) ?? "").replace(/"/g, "&quot;");
    return page(`<h2>Sign in to Fake GitHub</h2>
<p>Authorize <b>mergit-dev</b> as any user. <code>viewer</code> has read-only access; <code>outsider</code> has none.</p>
<form action="/web/login/oauth/approve">
  <input type="hidden" name="redirect_uri" value="${q("redirect_uri")}"><input type="hidden" name="state" value="${q("state")}">
  <p><input name="login" value="samcolson4" autofocus style="font:inherit;padding:6px;width:100%"></p>
  <button style="font:inherit;padding:6px 14px">Authorize</button>
</form>`);
  }
  if (path === "/web/login/oauth/approve") {
    const login = String(query.get("login") ?? "").replace(/[^\w-]/g, "") || "user";
    const target = new URL(query.get("redirect_uri"));
    target.searchParams.set("code", `code_${login}`);
    target.searchParams.set("state", query.get("state") ?? "");
    return { redirect: target.toString() };
  }
  if (path === "/web/login/oauth/access_token" && method === "POST") {
    if (body.client_secret !== "fake-secret") return { json: { error: "incorrect_client_credentials" } };
    const login = body.grant_type === "refresh_token" ? body.refresh_token?.replace(/^ghr_/, "") : body.code?.replace(/^code_/, "");
    if (!login) return { json: { error: "bad_verification_code" } };
    return {
      json: { access_token: `ghu_${login}`, token_type: "bearer", expires_in: 28_800, refresh_token: `ghr_${login}`, refresh_token_expires_in: 15_811_200 },
    };
  }
  if ((m = path.match(/^\/web\/apps\/([^/]+)\/installations\/new$/))) {
    return page(`<h2>Fake GitHub</h2><p><b>${m[1]}</b> is installed on <b>${INSTALLATION.account}</b> with ${INSTALLATION.repos.join(", ")}.</p>`);
  }
  if (path.startsWith("/web/")) return { text: `fake github.com page for ${path.slice(4)}\n` };

  if ((m = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/)) && method === "POST") {
    verifyAppJwt(token);
    if (Number(m[1]) !== INSTALLATION.id) throw fail(404, "Not Found");
    return { json: { token: `ghs_${createHash("sha1").update(String(Math.random())).digest("hex").slice(0, 20)}`, expires_at: new Date(Date.now() + 3600_000).toISOString() }, status: 201 };
  }
  if (path === "/user/installations" && method === "GET") {
    const who = identity(token);
    const installations = permissionsFor(who.login) ? [{ id: INSTALLATION.id, account: { login: INSTALLATION.account } }] : [];
    return { json: { total_count: installations.length, installations } };
  }
  if ((m = path.match(/^\/user\/installations\/(\d+)\/repositories$/)) && method === "GET") {
    const perms = permissionsFor(identity(token).login);
    const repositories = perms && Number(m[1]) === INSTALLATION.id && Number(query.get("page") ?? 1) === 1
      ? INSTALLATION.repos.map((full_name) => ({ full_name, private: true, default_branch: "main", permissions: perms }))
      : [];
    return { json: { total_count: repositories.length, repositories } };
  }

  if (path === "/user" && method === "GET") {
    const { login } = identity(token);
    return { json: { login, id: userId(login), name: login[0].toUpperCase() + login.slice(1) } };
  }
  if (!(m = path.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/))) throw Object.assign(new Error("Not Found"), { status: 404 });
  const name = m[1];
  const repo = repoFor(name);
  const rest = m[2] ?? "";

  if (rest === "" && method === "GET") {
    return { json: { full_name: name, default_branch: "main", permissions: { push: true } } };
  }
  if ((m = rest.match(/^\/git\/ref\/heads\/(.+)$/)) && method === "GET") {
    const sha = repo.refs.get(decodeURIComponent(m[1]));
    if (!sha) throw Object.assign(new Error("Not Found"), { status: 404 });
    return { json: { ref: `refs/heads/${m[1]}`, object: { sha, type: "commit" } } };
  }
  if ((m = rest.match(/^\/git\/matching-refs\/heads\/(.*)$/)) && method === "GET") {
    const prefix = decodeURIComponent(m[1]);
    return {
      json: [...repo.refs].filter(([b]) => b.startsWith(prefix)).map(([b, sha]) => ({ ref: `refs/heads/${b}`, object: { sha } })),
    };
  }
  if (rest === "/git/refs" && method === "POST") {
    const branch = body.ref.replace(/^refs\/heads\//, "");
    if (repo.refs.has(branch)) throw Object.assign(new Error("Reference already exists"), { status: 422 });
    get(repo, body.sha, "commit");
    repo.refs.set(branch, body.sha);
    return { json: { ref: body.ref, object: { sha: body.sha } }, status: 201 };
  }
  if ((m = rest.match(/^\/git\/refs\/heads\/(.+)$/))) {
    const branch = decodeURIComponent(m[1]);
    const current = repo.refs.get(branch);
    if (!current) throw Object.assign(new Error("Reference does not exist"), { status: 422 });
    if (method === "DELETE") {
      repo.refs.delete(branch);
      return { status: 204 };
    }
    if (method === "PATCH") {
      if (!body.force && !ancestors(repo, body.sha).has(current)) {
        throw Object.assign(new Error("Update is not a fast forward"), { status: 422 });
      }
      repo.refs.set(branch, body.sha);
      return { json: { ref: `refs/heads/${branch}`, object: { sha: body.sha } } };
    }
  }
  if ((m = rest.match(/^\/git\/commits\/([0-9a-f]{40})$/)) && method === "GET") {
    return { json: commitJson(m[1], get(repo, m[1], "commit")) };
  }
  if (rest === "/git/commits" && method === "POST") {
    get(repo, body.tree, "tree");
    body.parents.forEach((p) => get(repo, p, "commit"));
    const author = body.author ?? { name: token, email: `${token}@example.com` };
    const c = {
      type: "commit", tree: body.tree, parents: body.parents, message: body.message,
      author: { ...author, date: author.date ?? new Date(clock).toISOString() },
      committer: identity(token).login, // like GitHub: whoever's token made the commit
    };
    const sha = put(repo, c);
    return { json: commitJson(sha, c), status: 201 };
  }
  if ((m = rest.match(/^\/git\/trees\/([0-9a-f]{40})$/)) && method === "GET") {
    return { json: { sha: m[1], tree: get(repo, m[1], "tree").entries } };
  }
  if (rest === "/git/trees" && method === "POST") {
    const sha = writeTree(repo, body.base_tree ?? null, body.tree.map((e) => ({ parts: e.path.split("/"), entry: e })));
    return { json: { sha, tree: get(repo, sha).entries }, status: 201 };
  }
  if ((m = rest.match(/^\/git\/blobs\/([0-9a-f]{40})$/)) && method === "GET") {
    const b = get(repo, m[1], "blob");
    return { json: { sha: m[1], encoding: "base64", content: Buffer.from(b.content).toString("base64") } };
  }
  if ((m = rest.match(/^\/contents\/?(.*)$/)) && method === "GET") {
    const tip = repo.refs.get(query.get("ref") ?? "main");
    const dirPath = decodeURIComponent(m[1]);
    const dir = tip && treeAt(repo, get(repo, tip).tree, dirPath);
    if (!dir || get(repo, dir).type !== "tree") throw fail(404, "Not Found");
    return {
      json: get(repo, dir).entries.map((e) => ({
        name: e.path, path: dirPath ? `${dirPath}/${e.path}` : e.path, sha: e.sha, type: e.type === "tree" ? "dir" : "file",
      })),
    };
  }
  if (rest === "/commits" && method === "GET") {
    const start = query.get("sha");
    const path = query.get("path") ?? "";
    const perPage = Number(query.get("per_page") ?? 30);
    const page = Number(query.get("page") ?? 1);
    const folder = (sha) => (path ? treeAt(repo, get(repo, sha).tree, path) : get(repo, sha).tree);
    const touching = [...ancestors(repo, repo.refs.get(start) ?? start)]
      .map((sha) => [sha, get(repo, sha)])
      .filter(([sha, c]) => {
        const mine = folder(sha);
        if (!c.parents.length) return mine !== null;
        return c.parents.every((p) => folder(p) !== mine); // like git: skip commits TREESAME to a parent
      })
      .sort((a, b) => Date.parse(b[1].author.date) - Date.parse(a[1].author.date));
    return {
      json: touching.slice((page - 1) * perPage, page * perPage).map(([sha, c]) => ({
        sha,
        commit: { message: c.message, author: c.author },
        parents: c.parents.map((p) => ({ sha: p })),
      })),
    };
  }
  throw Object.assign(new Error(`Fake GitHub doesn't implement ${method} ${rest}`), { status: 404 });
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    if (!url.pathname.startsWith("/_") && !url.pathname.startsWith("/web/") && !req.headers.authorization) {
      throw fail(401, "Requires authentication");
    }
    const token = (req.headers.authorization ?? "").replace(/^(Bearer|token)\s+/i, "");
    if (token === "bad") throw fail(401, "Bad credentials");
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = Object.fromEntries(new URLSearchParams(raw)); // form-encoded, like GitHub's OAuth endpoint accepts
    }
    const out = route(req.method, url.pathname, url.searchParams, body, token);
    if (out.redirect) {
      res.writeHead(302, { location: out.redirect }).end();
    } else if (out.html !== undefined) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(out.html);
    } else if (out.text !== undefined) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(out.text);
    } else {
      res.writeHead(out.status ?? 200, { "content-type": "application/json" }).end(out.json ? JSON.stringify(out.json) : undefined);
    }
    if (process.env.VERBOSE) console.log(req.method, url.pathname, out.status ?? 200);
  } catch (e) {
    res.writeHead(e.status ?? 500, { "content-type": "application/json" }).end(JSON.stringify({ message: e.message }));
    if (process.env.VERBOSE || !e.status) console.log(req.method, url.pathname, e.status ?? 500, e.message);
  }
}).listen(port, "127.0.0.1", () => console.log(`fake GitHub → http://127.0.0.1:${port}`));
