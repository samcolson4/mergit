// GitHub as the source of truth for a board's history.
//
// Every mergit commit is written as a real git commit whose tree is the
// repository's tree with the board's folder replaced:
//
//   <path>/board.json        frame ids, titles, geometry, file names
//   <path>/frames/*.mmd      one Mermaid file per frame
//   <path>/README.md         generated; GitHub renders the diagrams
//
// Trailers (Mergit-Commit / -Parents / -Time / -Author) carry what git can't,
// so the exact mergit history, hashes included, can be rebuilt from GitHub.
//
// Branches: mergit `main` ↔ the configured git branch (shared with whatever
// else lives in the repo); any other branch ↔ `<prefix>/<name>`.

import { blobJson, commitJson, normalize, sha256, treeJson } from "./objects.js";

export class ExternalEditError extends Error {
  status = 409;
}

const EMAIL = "noreply@mergit.invalid";
const short = (h) => h.slice(0, 7);

export function slug(text) {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "diagram"
  );
}

/**
 * The files that represent one board snapshot. `frames` must be sorted by id.
 * The README carries the commit hash, so every mergit commit changes the
 * folder and shows up in GitHub's path-filtered history (which rebuild uses).
 */
export function boardFiles(name, url, frames, hash) {
  const used = new Set();
  const manifest = frames.map((f) => {
    let file = `frames/${slug(f.title)}.mmd`;
    if (used.has(file)) file = `frames/${slug(f.title)}-${slug(f.id)}.mmd`;
    used.add(file);
    return { ...f, file };
  });
  const board = {
    format: "mergit/1",
    frames: manifest.map(({ id, title, x, y, w, h, file }) => ({ id, title, x, y, w, h, file })),
  };
  const readme = [
    `# ${name}`,
    "",
    `> Managed by [mergit](${url}). Edit the board there: changes made directly to this folder are refused by mergit.`,
    "",
    ...manifest.flatMap((f) => [`## ${f.title || "Untitled"}`, "", "```mermaid", f.source, "```", ""]),
    `<!-- mergit:${hash} -->`,
    "",
  ].join("\n");
  return [
    { path: "board.json", content: `${JSON.stringify(board, null, 2)}\n` },
    { path: "README.md", content: readme },
    ...manifest.map((f) => ({ path: f.file, content: `${f.source}\n` })),
  ];
}

function trailers(hash, c) {
  return [
    `Mergit-Commit: ${hash}`,
    `Mergit-Parents: ${c.parents.join(" ")}`,
    `Mergit-Time: ${c.time}`,
    `Mergit-Author: ${c.author}`,
  ].join("\n");
}

export function parseTrailers(message) {
  const at = message.lastIndexOf("\n\nMergit-Commit: ");
  if (at < 0) return null;
  const fields = {};
  for (const line of message.slice(at + 2).split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) fields[line.slice(0, colon)] = line.slice(colon + 1).trim();
  }
  return {
    hash: fields["Mergit-Commit"],
    parents: (fields["Mergit-Parents"] ?? "").split(/\s+/).filter(Boolean),
    time: Number(fields["Mergit-Time"]),
    author: fields["Mergit-Author"] ?? "",
    message: message.slice(0, at),
  };
}

export class GitStore {
  /**
   * @param gh  GitHub client
   * @param cfg { repo, path, branch, prefix, name, url }
   * @param db  { object(hash), mapping(hash), setMapping(hash, m), branchState(name), setBranchState(name, s) }
   */
  constructor(gh, cfg, db) {
    this.gh = gh;
    this.cfg = cfg;
    this.db = db;
  }

  gitBranch(name) {
    return name === "main" ? this.cfg.branch : `${this.cfg.prefix}/${name}`;
  }

  /** Commits reachable from `hash` that aren't on GitHub yet, parents first. */
  unwritten(hash) {
    const out = [];
    const seen = new Set();
    const stack = [[hash, false]];
    while (stack.length) {
      const [h, expanded] = stack.pop();
      if (expanded) {
        out.push(h);
        continue;
      }
      if (seen.has(h) || this.db.mapping(h)) continue;
      seen.add(h);
      stack.push([h, true]);
      for (const p of JSON.parse(this.db.object(h)).parents) stack.push([p, false]);
    }
    return out;
  }

  framesOf(commit) {
    const tree = JSON.parse(this.db.object(commit.tree));
    return tree.entries.map((e) => ({
      id: e.id, title: e.title, x: e.x, y: e.y, w: e.w, h: e.h,
      source: JSON.parse(this.db.object(e.blob)).data,
    }));
  }

  async writeCommit(hash, gitParents, baseRoot) {
    const { gh } = this;
    const { repo, path, name, url } = this.cfg;
    const c = JSON.parse(this.db.object(hash));
    const files = boardFiles(name, url, this.framesOf(c), hash);
    const folder = await gh.createTree(repo, files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.content })));
    const root = await gh.createTree(repo, [{ path, mode: "040000", type: "tree", sha: folder }], baseRoot);
    const git = await gh.createCommit(repo, {
      message: `${c.message}\n\n${trailers(hash, c)}`,
      tree: root,
      parents: gitParents,
      author: { name: c.author || "mergit", email: EMAIL, date: new Date(c.time).toISOString() },
    });
    const written = { git, root, folder };
    this.db.setMapping(hash, written);
    return written;
  }

  /**
   * Make GitHub reflect `name: old → next`. Throws (and changes nothing in
   * mergit) if GitHub refuses or the folder was edited outside mergit.
   */
  async writeBranch(name, old, next) {
    const { gh } = this;
    const { repo, path } = this.cfg;
    const branch = this.gitBranch(name);

    if (!next) {
      if (name === "main") throw new Error("main can't be deleted");
      await gh.deleteBranch(repo, branch);
      this.db.setBranchState(name, null);
      return;
    }

    const known = this.db.branchState(name); // what we last wrote to this git branch
    const tip = await gh.branchSha(repo, branch);
    let tipRoot = known?.git === tip ? known.root : null;
    if (tip && tip !== known?.git) {
      // The git branch has commits we didn't make. That's fine (code lives
      // here too) as long as none of them touched the board's folder.
      tipRoot = (await gh.getCommit(repo, tip)).tree.sha;
      const folderNow = await gh.treeAt(repo, tipRoot, path);
      if (folderNow !== (known?.folder ?? null)) {
        throw new ExternalEditError(
          `${path}/ was changed on GitHub (${branch}) outside mergit. ` +
            `Importing those edits isn't supported yet; revert them on GitHub to keep committing.`,
        );
      }
    }

    // Write new commits. Those continuing this branch ("the spine") sit on the
    // current git tip, so the git branch only ever fast-forwards.
    let base = tip;
    let baseRoot = tipRoot;
    let spine = old;
    for (const hash of this.unwritten(next)) {
      const c = JSON.parse(this.db.object(hash));
      const mapped = c.parents.map((p) => this.db.mapping(p).git);
      const onSpine = (c.parents[0] ?? null) === spine;
      let written;
      if (onSpine && base) {
        written = await this.writeCommit(hash, [base, ...mapped.slice(1)], baseRoot);
      } else {
        const parentRoot = c.parents.length ? this.db.mapping(c.parents[0]).root : baseRoot;
        written = await this.writeCommit(hash, mapped.length ? mapped : base ? [base] : [], parentRoot);
      }
      if (onSpine) {
        base = written.git;
        baseRoot = written.root;
        spine = hash;
      }
    }

    const target = this.db.mapping(next);
    let state = spine === next ? { git: base, root: baseRoot, folder: target.folder } : { ...target };
    if (!tip) {
      await gh.createBranch(repo, branch, state.git);
    } else if (state.git !== tip) {
      try {
        await gh.moveBranch(repo, branch, state.git);
      } catch (e) {
        if (e.status !== 422) throw e;
        // Not a fast-forward in git: e.g. fast-forwarding mergit `main` to a
        // branch while other commits landed on git `main`. Join them.
        const c = JSON.parse(this.db.object(next));
        const root = await gh.createTree(repo, [{ path, mode: "040000", type: "tree", sha: target.folder }], tipRoot);
        const git = await gh.createCommit(repo, {
          message: `${c.message}\n\n${trailers(next, c)}`,
          tree: root,
          parents: [tip, target.git],
          author: { name: c.author || "mergit", email: EMAIL, date: new Date(c.time).toISOString() },
        });
        await gh.moveBranch(repo, branch, git);
        state = { git, root, folder: target.folder };
      }
    }
    this.db.setBranchState(name, state);
  }

  /**
   * Reconstruct the board's full history from GitHub. Returns null if the
   * folder has no mergit history. Every rebuilt commit is checked against
   * the hash in its trailer.
   */
  async rebuild() {
    const { gh } = this;
    const { repo, path, prefix } = this.cfg;
    const branches = [{ name: "main", branch: this.cfg.branch }];
    for (const { branch } of await gh.branchesWithPrefix(repo, prefix)) {
      branches.push({ name: branch.slice(prefix.length + 1), branch });
    }

    const infos = new Map();
    const refs = {};
    const branchStates = {};
    for (const b of branches) {
      const tip = await gh.branchSha(repo, b.branch);
      if (!tip) continue;
      let head = null;
      for (const item of await gh.commitsTouching(repo, tip, path)) {
        const t = parseTrailers(item.commit.message);
        if (!t) {
          if (!head) {
            throw new ExternalEditError(`The latest change to ${path}/ on ${b.branch} wasn't made by mergit, so its history can't be imported.`);
          }
          continue;
        }
        head ??= t.hash;
        if (!infos.has(t.hash)) infos.set(t.hash, { ...t, git: item.sha });
      }
      if (!head) continue;
      refs[b.name] = head;
      const root = (await gh.getCommit(repo, tip)).tree.sha;
      branchStates[b.name] = { git: tip, root, folder: await gh.treeAt(repo, root, path) };
    }
    if (!refs.main) return null;

    const objects = new Map();
    const mappings = new Map();
    const blobText = new Map(); // git blob sha → text
    const readBlob = async (sha) => {
      if (!blobText.has(sha)) blobText.set(sha, await gh.getBlobText(repo, sha));
      return blobText.get(sha);
    };

    for (const info of infos.values()) {
      const missing = info.parents.find((p) => !infos.has(p));
      if (missing) throw new Error(`History on GitHub is incomplete: ${short(info.hash)}'s parent ${short(missing)} wasn't found`);

      const root = (await gh.getCommit(repo, info.git)).tree.sha;
      const folder = await gh.treeAt(repo, root, path);
      const files = new Map();
      const walk = async (sha, prefixPath) => {
        for (const e of (await gh.getTree(repo, sha)).tree) {
          const p = prefixPath + e.path;
          if (e.type === "tree") await walk(e.sha, `${p}/`);
          else files.set(p, e.sha);
        }
      };
      await walk(folder, "");
      const manifest = JSON.parse(await readBlob(files.get("board.json")));

      const entries = [];
      for (const f of manifest.frames) {
        const data = normalize(await readBlob(files.get(f.file)));
        const json = blobJson(data);
        const blob = await sha256(json);
        objects.set(blob, json);
        entries.push({ id: f.id, title: f.title, x: f.x, y: f.y, w: f.w, h: f.h, blob });
      }
      const tree = treeJson(entries);
      const treeHash = await sha256(tree);
      objects.set(treeHash, tree);
      const commit = commitJson({ tree: treeHash, parents: info.parents, message: info.message, author: info.author, time: info.time });
      const hash = await sha256(commit);
      if (hash !== info.hash) throw new Error(`Commit ${short(info.git)} on GitHub doesn't match its Mergit-Commit hash`);
      objects.set(hash, commit);
      mappings.set(hash, { git: info.git, root, folder });
    }
    return { objects, refs, mappings, branchStates, commits: infos.size };
  }
}
