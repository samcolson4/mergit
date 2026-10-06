// Builds mergit objects in JavaScript, byte-for-byte identical to how
// mergit-core (serde_json) serialises them, so hashes match. Used when
// rebuilding a board's history from GitHub. test/canonical.test.mjs checks
// this against the Rust core.

/** Same as mergit-core's `diff::normalize`. */
export function normalize(src) {
  return src
    .split("\n")
    .map((line) => line.replace(/\s+$/u, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

// Key order matters: it must follow the Rust struct field order.
export const blobJson = (data) => JSON.stringify({ type: "blob", data });

export const treeJson = (entries) =>
  JSON.stringify({
    type: "tree",
    entries: [...entries]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((e) => ({ id: e.id, title: e.title, x: e.x, y: e.y, w: e.w, h: e.h, blob: e.blob })),
  });

export const commitJson = (c) =>
  JSON.stringify({ type: "commit", tree: c.tree, parents: c.parents, message: c.message, author: c.author, time: c.time });

export async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
