export { Board } from "./board.js";
export { Directory } from "./directory.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/b/")) {
      // Every board URL serves the same page; it reads the board id from the path.
      return env.ASSETS.fetch(new Request(new URL("/board", url), request));
    }
    if (url.pathname === "/api/config") {
      return Response.json({
        github: env.GITHUB_TOKEN
          ? { repo: env.GITHUB_DEFAULT_REPO ?? "", branch: env.GITHUB_DEFAULT_BRANCH ?? "", dir: env.GITHUB_DEFAULT_DIR ?? "diagrams" }
          : null,
      });
    }
    if (url.pathname === "/api/boards") {
      return env.DIRECTORY.get(env.DIRECTORY.idFromName("directory")).fetch(request);
    }
    const match = url.pathname.match(/^\/api\/boards\/([a-z0-9]+)(\/|$)/);
    if (match) {
      return env.BOARD.get(env.BOARD.idFromName(match[1])).fetch(request);
    }
    if (url.pathname.startsWith("/api/")) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
};
