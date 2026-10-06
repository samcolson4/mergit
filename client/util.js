const COLORS = ["#ff3670", "#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#a855f7", "#ec4899", "#14b8a6"];
const NAME_KEY = "mergit.name";

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

export function colorFor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

/** Who you are to collaborators. No accounts yet: just a remembered display name. */
export function identity() {
  let name = read(NAME_KEY);
  if (!name) {
    name = (prompt("What's your name? Collaborators see it, and it goes on your commits.") ?? "").trim();
    name ||= `Guest ${Math.floor(100 + Math.random() * 900)}`;
    write(NAME_KEY, name);
  }
  return { name, color: colorFor(name) };
}

export function rename() {
  const name = (prompt("Your name", read(NAME_KEY) ?? "") ?? "").trim();
  if (name) write(NAME_KEY, name);
  return name;
}

export const prefs = {
  get: (key) => {
    try {
      return JSON.parse(read(`mergit.${key}`));
    } catch {
      return null;
    }
  },
  set: (key, value) => write(`mergit.${key}`, JSON.stringify(value)),
};

/** The signed-in person's GitHub token, if they've added one (see settings.js). */
function storedGithubToken() {
  try {
    return JSON.parse(read("mergit.github"))?.token ?? null;
  } catch {
    return null;
  }
}

export async function api(path, { method = "GET", body, token = storedGithubToken() } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      // Only our own API ever sees it; the server uses it for this request's GitHub writes.
      ...(token ? { "x-github-token": token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** Push every branch of the in-memory repo to a freshly created board. */
export async function pushAllBranches(core, boardId, author) {
  const { branches } = core.call("export");
  const pushed = [];
  // main first, so the board is usable as soon as possible
  const names = Object.keys(branches).sort((a, b) => (a === "main" ? -1 : b === "main" ? 1 : a.localeCompare(b)));
  for (const name of names) {
    const tip = branches[name];
    const objects = core.call("pack", { tips: [tip], exclude: pushed });
    await api(`/api/boards/${boardId}/refs`, { method: "POST", body: { name, old: null, new: tip, objects, by: author } });
    pushed.push(tip);
  }
}

export const short = (h) => h.slice(0, 7);

export const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
};
