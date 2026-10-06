// Request routing, sign-in gate and security headers.
//
//   /auth/*            sign in with GitHub / sign out          → Directory
//   /api/me|repos|folders|boards                               → Directory
//   /api/boards/:id/*  after checking the session and repo access → that Board
//   /b/:id             the board page (static)
//   everything else    static assets

export { Board } from "./board.js";
export { Directory } from "./directory.js";

// Scripts only from this origin (plus WebAssembly compilation for the core).
// Mermaid renders <style> into its SVGs, hence 'unsafe-inline' for styles only.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

function secure(response, url) {
  if (response.status === 101) return response; // WebSocket upgrade
  const res = new Response(response.body, response);
  res.headers.set("content-security-policy", CSP);
  res.headers.set("x-content-type-options", "nosniff");
  res.headers.set("referrer-policy", "no-referrer");
  res.headers.set("x-frame-options", "DENY");
  res.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  if (url.protocol === "https:") {
    res.headers.set("strict-transport-security", "max-age=31536000");
  }
  return res;
}

const json = (data, status) => Response.json(data, { status });

/**
 * Sessions are cookies, so anything that changes state must come from our own
 * pages: same Origin, JSON body. Also blocks cross-site WebSocket hijacking.
 */
function crossSite(request, url) {
  const unsafe = !["GET", "HEAD"].includes(request.method) || request.headers.get("upgrade") === "websocket";
  if (!unsafe) return false;
  if (request.headers.get("origin") !== url.origin) return true;
  const type = request.headers.get("content-type") ?? "";
  return request.method === "POST" && !type.startsWith("application/json");
}

const MAX_BODY = 5_000_000; // bytes; the largest legitimate body is a board's initial history

async function route(request, env) {
  const url = new URL(request.url);

  // Read bodies up front (and cap their size). Forwarded requests then carry
  // a buffered copy, so nothing is left half-read when we refuse early.
  if (request.body) {
    if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return json({ error: "Request too large" }, 413);
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY) return json({ error: "Request too large" }, 413);
    request = new Request(request, { body });
  }
  const directory = () => env.DIRECTORY.get(env.DIRECTORY.idFromName("directory"));

  if (url.pathname.startsWith("/auth/") || url.pathname.startsWith("/api/")) {
    if (crossSite(request, url)) return json({ error: "Cross-site request refused" }, 403);
  }
  if (url.pathname.startsWith("/auth/")) return directory().fetch(request);

  const board = url.pathname.match(/^\/api\/boards\/([a-z0-9]+)(\/.*)?$/);
  if (board) {
    // Who is this, and what may they do on this board's repository?
    const auth = await directory().fetch(
      new Request(new URL("/internal/authorize", url), {
        method: "POST",
        headers: { cookie: request.headers.get("cookie") ?? "", "content-type": "application/json" },
        body: JSON.stringify({ boardId: board[1] }),
      }),
    );
    if (!auth.ok) return auth;
    const { user, role } = await auth.json();
    // Forward with identity headers set here (never trusted from the client).
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    headers.set("x-mergit-user", JSON.stringify(user));
    headers.set("x-mergit-role", role);
    return env.BOARD.get(env.BOARD.idFromName(board[1])).fetch(new Request(request, { headers }));
  }
  if (["/api/me", "/api/repos", "/api/folders", "/api/boards"].includes(url.pathname)) {
    return directory().fetch(request);
  }
  if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);

  if (url.pathname.startsWith("/b/")) {
    // Every board URL serves the same page; it reads the board id from the path.
    return env.ASSETS.fetch(new Request(new URL("/board", url), request));
  }
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    return secure(await route(request, env), new URL(request.url));
  },
};
