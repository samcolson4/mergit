// The live (uncommitted) state of one branch, as a Yjs document.
// Shared by the browser and the Durable Object, so both agree on the schema:
//
//   frames: Y.Map<frameId, Y.Map{ title, x, y, w, h, z, source: Y.Text }>
//   meta:   Y.Map{ mergeHead?, mergeBranch? }   — merge state is shared too

import * as Y from "yjs";

export const framesOf = (doc) => doc.getMap("frames");
export const metaOf = (doc) => doc.getMap("meta");

/** Plain board object in the shape mergit-core expects, ordered back-to-front. */
export function docToBoard(doc) {
  const frames = [];
  framesOf(doc).forEach((m, id) => {
    frames.push({
      id,
      title: m.get("title") ?? "",
      x: m.get("x") ?? 0,
      y: m.get("y") ?? 0,
      w: m.get("w") ?? 400,
      h: m.get("h") ?? 300,
      z: m.get("z") ?? 0,
      source: m.get("source")?.toString() ?? "",
    });
  });
  frames.sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : 1));
  return { frames: frames.map(({ z, ...f }) => f) };
}

/** The changed span between two strings: [start, endInPrev, endInNext]. */
export function changedSpan(prev, next) {
  let start = 0;
  while (start < prev.length && start < next.length && prev[start] === next[start]) start++;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
    endPrev--;
    endNext--;
  }
  return [start, endPrev, endNext];
}

/** Turn a whole-string replacement into a minimal Y.Text edit, so concurrent typing merges. */
export function setText(ytext, next) {
  const prev = ytext.toString();
  if (prev === next) return;
  const [start, endPrev, endNext] = changedSpan(prev, next);
  if (endPrev > start) ytext.delete(start, endPrev - start);
  if (endNext > start) ytext.insert(start, next.slice(start, endNext));
}

function writeFrame(frames, f, z) {
  let m = frames.get(f.id);
  if (!m) {
    m = new Y.Map();
    frames.set(f.id, m);
    m.set("source", new Y.Text());
  }
  for (const key of ["title", "x", "y", "w", "h"]) {
    if (m.get(key) !== f[key]) m.set(key, f[key]);
  }
  if (m.get("z") !== z) m.set("z", z);
  setText(m.get("source"), f.source);
}

/** Make the document equal to `board`, touching only what differs. */
export function replaceBoard(doc, board) {
  doc.transact(() => {
    const frames = framesOf(doc);
    const keep = new Set(board.frames.map((f) => f.id));
    for (const id of [...frames.keys()]) if (!keep.has(id)) frames.delete(id);
    board.frames.forEach((f, i) => writeFrame(frames, f, i));
  });
}

export function addFrame(doc, frame) {
  doc.transact(() => {
    const frames = framesOf(doc);
    const top = Math.max(-1, ...[...frames.values()].map((m) => m.get("z") ?? 0));
    writeFrame(frames, frame, top + 1);
  });
}

export function updateFrame(doc, id, fields) {
  const m = framesOf(doc).get(id);
  if (!m) return;
  doc.transact(() => {
    for (const [key, value] of Object.entries(fields)) if (m.get(key) !== value) m.set(key, value);
  });
}

export function deleteFrame(doc, id) {
  framesOf(doc).delete(id);
}

export const frameText = (doc, id) => framesOf(doc).get(id)?.get("source");

export function getMerge(doc) {
  const meta = metaOf(doc);
  return { head: meta.get("mergeHead") ?? null, branch: meta.get("mergeBranch") ?? null };
}

export function setMerge(doc, head, branch) {
  const meta = metaOf(doc);
  doc.transact(() => {
    if (head) {
      meta.set("mergeHead", head);
      meta.set("mergeBranch", branch);
    } else {
      meta.delete("mergeHead");
      meta.delete("mergeBranch");
    }
  });
}
