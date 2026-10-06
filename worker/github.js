// Minimal GitHub REST client: just the Git Data endpoints mergit needs.

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const enc = encodeURIComponent;
const refPath = (branch) => branch.split("/").map(enc).join("/");

export class GitHub {
  constructor(token, apiBase = "https://api.github.com") {
    this.token = token;
    this.api = apiBase.replace(/\/$/, "");
  }

  async request(method, path, body) {
    const res = await fetch(this.api + path, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "mergit",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new GitHubError(`GitHub: ${data.message ?? res.statusText} (${method} ${path})`, res.status);
    return data;
  }

  async maybe(promise) {
    try {
      return await promise;
    } catch (e) {
      if (e.status === 404 || e.status === 409) return null; // 409: empty repository
      throw e;
    }
  }

  getRepo(repo) {
    return this.request("GET", `/repos/${repo}`);
  }

  async branchSha(repo, branch) {
    const ref = await this.maybe(this.request("GET", `/repos/${repo}/git/ref/heads/${refPath(branch)}`));
    return ref?.object?.sha ?? null;
  }

  getCommit(repo, sha) {
    return this.request("GET", `/repos/${repo}/git/commits/${sha}`);
  }

  getTree(repo, sha) {
    return this.request("GET", `/repos/${repo}/git/trees/${sha}`);
  }

  async getBlobText(repo, sha) {
    const blob = await this.request("GET", `/repos/${repo}/git/blobs/${sha}`);
    const bytes = Uint8Array.from(atob(blob.content.replace(/\n/g, "")), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  /** The sha of the tree at `path` inside a root tree, or null if absent. */
  async treeAt(repo, rootTree, path) {
    let sha = rootTree;
    for (const part of path.split("/").filter(Boolean)) {
      const entry = (await this.getTree(repo, sha)).tree.find((e) => e.path === part && e.type === "tree");
      if (!entry) return null;
      sha = entry.sha;
    }
    return sha;
  }

  async createTree(repo, tree, baseTree) {
    return (await this.request("POST", `/repos/${repo}/git/trees`, { tree, ...(baseTree ? { base_tree: baseTree } : {}) })).sha;
  }

  async createCommit(repo, commit) {
    return (await this.request("POST", `/repos/${repo}/git/commits`, commit)).sha;
  }

  createBranch(repo, branch, sha) {
    return this.request("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  }

  /** Fast-forward only: GitHub rejects the update if `sha` doesn't descend from the current tip. */
  moveBranch(repo, branch, sha) {
    return this.request("PATCH", `/repos/${repo}/git/refs/heads/${refPath(branch)}`, { sha, force: false });
  }

  deleteBranch(repo, branch) {
    return this.maybe(this.request("DELETE", `/repos/${repo}/git/refs/heads/${refPath(branch)}`));
  }

  async branchesWithPrefix(repo, prefix) {
    const refs = (await this.maybe(this.request("GET", `/repos/${repo}/git/matching-refs/heads/${refPath(prefix)}/`))) ?? [];
    return refs.map((r) => ({ branch: r.ref.replace(/^refs\/heads\//, ""), sha: r.object.sha }));
  }

  /** Commits reachable from `sha` that touched `path`, newest first. */
  async commitsTouching(repo, sha, path, limit = 2000) {
    const out = [];
    for (let page = 1; out.length < limit; page++) {
      const batch = await this.request("GET", `/repos/${repo}/commits?sha=${sha}&path=${enc(path)}&per_page=100&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }
}
