import { colorFor } from "./colors.js";

export { colorFor };

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

/** The signed-in person (from their GitHub session), or null. */
export async function currentUser() {
  try {
    const me = await api("/api/me");
    return { ...me, color: colorFor(me.login) };
  } catch (e) {
    if (e.status === 401) return null;
    throw e;
  }
}

export function signIn() {
  location.href = `/auth/login?next=${encodeURIComponent(location.pathname + location.search)}`;
}

export async function signOut() {
  await api("/auth/logout", { method: "POST", body: {} }).catch(() => {});
  location.href = "/";
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

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
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
export async function pushAllBranches(core, boardId) {
  const { branches } = core.call("export");
  const pushed = [];
  // main first, so the board is usable as soon as possible
  const names = Object.keys(branches).sort((a, b) => (a === "main" ? -1 : b === "main" ? 1 : a.localeCompare(b)));
  for (const name of names) {
    const tip = branches[name];
    const objects = core.call("pack", { tips: [tip], exclude: pushed });
    await api(`/api/boards/${boardId}/refs`, { method: "POST", body: { name, old: null, new: tip, objects } });
    pushed.push(tip);
  }
}

export const short = (h) => h.slice(0, 7);

export const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
};
