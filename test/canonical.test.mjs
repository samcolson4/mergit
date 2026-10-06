// The worker rebuilds mergit objects from GitHub in JavaScript. Their hashes
// must match what the Rust core produced, so the JSON must be byte-identical.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { blobJson, commitJson, normalize, sha256, treeJson } from "../worker/objects.js";

const wasm = await readFile(new URL("../web/pkg/mergit_core.wasm", import.meta.url));
const { instance } = await WebAssembly.instantiate(wasm);
const ex = instance.exports;
function call(op, args = {}) {
  const bytes = new TextEncoder().encode(JSON.stringify({ op, ...args }));
  const ptr = ex.gm_alloc(bytes.length);
  new Uint8Array(ex.memory.buffer, ptr, bytes.length).set(bytes);
  const out = ex.gm_call(ptr, bytes.length);
  const res = JSON.parse(new TextDecoder().decode(new Uint8Array(ex.memory.buffer, out, ex.gm_out_len())));
  ex.gm_free(ptr, bytes.length);
  if ("err" in res) throw new Error(res.err);
  return res.ok;
}

const awkward = 'flowchart LR\r\n  A["quote \\" & <tag> ünïcødé 😀"] --> B\t\n  B -->|tab\there| C   \n\n\n  %% \u0001 control,   separator\n';

test("normalize matches the Rust core", () => {
  call("init", { board: { frames: [{ id: "a", title: "t", x: 0, y: 0, w: 1, h: 1, source: awkward }] }, author: "x", time: 1 });
  const stored = call("show", { rev: "HEAD" }).frames[0].source;
  assert.equal(normalize(awkward), stored);
});

test("blob, tree and commit JSON hash identically to the Rust core", async () => {
  const frames = [
    { id: "f-b", title: "Ünïcødé “title”\n", x: -10, y: 20, w: 300, h: 200, source: awkward },
    { id: "f-a", title: "plain", x: 0, y: 0, w: 400, h: 300, source: "graph TD\n A-->B" },
  ];
  call("init", { board: { frames }, author: "Zoë O'Brien", time: 1791301158790 });
  const head = call("status", { board: { frames } }).head;
  call("commit", { board: { frames: [frames[1]] }, message: "Second\n\nwith body \"quoted\"", author: "Zoë", time: 1791301158999 });
  const tip = call("log")[0].hash;
  const objects = call("pack", { tips: [tip] });

  for (const [hash, json] of Object.entries(objects)) {
    const o = JSON.parse(json);
    const rebuilt =
      o.type === "blob" ? blobJson(o.data) : o.type === "tree" ? treeJson([...o.entries].reverse()) : commitJson(o);
    assert.equal(rebuilt, json, `${o.type} ${hash.slice(0, 7)}`);
    assert.equal(await sha256(rebuilt), hash);
  }
  assert.ok(objects[head], "packs include the parent commit");
});
