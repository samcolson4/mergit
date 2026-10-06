// Thin JS binding for mergit-core.wasm: JSON request in, JSON response out.
// No wasm-bindgen; the module has zero imports.

export async function loadCore(url) {
  const { instance } = await WebAssembly.instantiateStreaming(fetch(url));
  const ex = instance.exports;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  return {
    call(op, args = {}) {
      const bytes = enc.encode(JSON.stringify({ op, ...args }));
      const ptr = ex.gm_alloc(bytes.length);
      // Always take a fresh view of memory: it may have grown during alloc.
      new Uint8Array(ex.memory.buffer, ptr, bytes.length).set(bytes);
      const out = ex.gm_call(ptr, bytes.length);
      const res = JSON.parse(dec.decode(new Uint8Array(ex.memory.buffer, out, ex.gm_out_len())));
      ex.gm_free(ptr, bytes.length);
      if ("err" in res) throw new Error(res.err);
      return res.ok;
    },
  };
}
