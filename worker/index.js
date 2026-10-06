import { GitHub } from "./github.js";

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
        github: {
          repo: env.GITHUB_DEFAULT_REPO ?? "",
          branch: env.GITHUB_DEFAULT_BRANCH ?? "",
          dir: env.GITHUB_DEFAULT_DIR ?? "diagrams",
          // A fallback token on the server means people can commit without adding their own.
          serverToken: Boolean(env.GITHUB_TOKEN),
        },
      });
    }
    if (url.pathname === "/api/github/user") {
      // Check a person's token before their browser saves it.
      const token = request.headers.get("x-github-token");
      if (!token) return Response.json({ error: "No token" }, { status: 400 });
      try {
        const user = await new GitHub(token, env.GITHUB_API_URL || undefined).request("GET", "/user");
        return Response.json({ login: user.login, name: user.name ?? null });
      } catch (e) {
        const message = e.status === 401 ? "GitHub didn't accept that token. Check it was copied in full and hasn't expired." : e.message;
        return Response.json({ error: message }, { status: 400 });
      }
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
