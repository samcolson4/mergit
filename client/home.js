import { loadCore } from "./core.js";
import { STARTER, seedRepo } from "./templates.js";
import { api, currentUser, el, pushAllBranches, signOut } from "./util.js";

const $ = (id) => document.getElementById(id);

let toastTimer;
function toast(msg, isError = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (isError ? " error" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

const slug = (s) =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "board";

const setup = await api("/api/setup");
const me = setup.configured ? await currentUser() : null;
if (!setup.configured) {
  showSetup();
} else if (!me) {
  $("signed-out").hidden = false;
  $("installed-note").hidden = !new URLSearchParams(location.search).has("installed");
} else {
  $("signed-in").hidden = false;
  $("account").hidden = false;
  $("me").textContent = `@${me.login}`;
  $("sign-out").onclick = signOut;
  for (const id of ["install-link", "install-more"]) $(id).href = me.installUrl;
  listBoards().catch((e) => $("boards").replaceChildren(el("div", { className: "empty-state", textContent: `Couldn't load boards: ${e.message}` })));
}

/**
 * First run: create mergit's GitHub App with GitHub's own "create app from a
 * manifest" page, then install it. The server hands us the manifest; we post it
 * to GitHub as a form, as GitHub's flow requires.
 */
function showSetup() {
  $("setup").hidden = false;
  $("setup-token-row").hidden = !setup.needsSetupToken;
  for (const r of document.querySelectorAll('input[name="owner"]')) {
    r.onchange = () => ($("setup-org").disabled = r.value !== "org" || !r.checked);
  }
  $("setup-form").onsubmit = async (e) => {
    e.preventDefault();
    const org = document.querySelector('input[name="owner"]:checked').value === "org" ? $("setup-org").value.trim() : "";
    try {
      const { action, manifest } = await api("/setup/start", { method: "POST", body: { org, token: $("setup-token").value.trim() } });
      const form = el("form", { method: "post", action }, el("input", { type: "hidden", name: "manifest", value: manifest }));
      document.body.append(form);
      form.submit();
    } catch (err) {
      $("setup-error").textContent = err.message;
      $("setup-error").hidden = false;
    }
  };
}

async function listBoards() {
  const { boards } = await api("/api/boards");
  $("boards").replaceChildren(
    ...(boards.length
      ? boards.map((b) =>
          el(
            "a",
            { className: "board-card", href: `/b/${b.id}` },
            el("span", { className: "name", textContent: b.name }),
            b.role === "view" ? el("span", { className: "tag", textContent: "view only" }) : null,
            el("span", { className: "where", textContent: `${b.repo}/${b.path}` }),
          ),
        )
      : [el("div", { className: "empty-state", textContent: "No boards in your repositories yet. Create one to get started." })]),
  );
}

// ---- create dialog --------------------------------------------------------------

const dialog = $("create");
let pending = null; // { build(core) } for the board being created
let repos = [];
let chosenPath = "";
let pathChosenByHand = false;
let browsing = ""; // folder shown in the picker

function selectedRepo() {
  return repos.find((r) => r.repo === $("repo").value) ?? null;
}

async function loadRepos(refresh = false) {
  const res = await api(`/api/repos${refresh ? "?refresh" : ""}`);
  repos = res.repos.filter((r) => r.permission === "write");
  const previous = $("repo").value;
  $("repo").replaceChildren(...repos.map((r) => el("option", { value: r.repo, textContent: `${r.repo}${r.private ? " (private)" : ""}` })));
  if (repos.some((r) => r.repo === previous)) $("repo").value = previous;
  $("no-repos").hidden = repos.length > 0;
  $("location").hidden = repos.length === 0;
  $("create-submit").disabled = repos.length === 0;
}

function setPath(path) {
  chosenPath = path;
  $("path-display").textContent = path ? `${path}/` : "";
}

function defaultPath() {
  return `boards/${slug($("board-name-input").value)}`;
}

async function openCreate(title, defaultName, build) {
  pending = { build };
  pathChosenByHand = false;
  $("create-title").textContent = title;
  $("board-name-input").value = defaultName;
  $("create-error").hidden = true;
  $("picker").hidden = true;
  $("create-submit").textContent = "Create";
  setPath(defaultPath());
  dialog.showModal();
  $("board-name-input").select();
  try {
    await loadRepos();
  } catch (e) {
    showError(e.message);
  }
}

function showError(message) {
  $("create-error").textContent = message;
  $("create-error").hidden = false;
}

$("board-name-input").addEventListener("input", () => !pathChosenByHand && setPath(defaultPath()));
$("repo").addEventListener("change", () => {
  if (!$("picker").hidden) browse(browsing);
});
for (const b of document.querySelectorAll(".refresh-repos")) b.onclick = () => loadRepos(true).catch((e) => showError(e.message));
$("create-cancel").onclick = () => dialog.close();

// ---- folder picker ------------------------------------------------------------------

$("change-folder").onclick = () => {
  $("picker").hidden = !$("picker").hidden;
  if (!$("picker").hidden) browse(chosenPath.split("/").slice(0, -1).join("/"));
};

async function browse(path) {
  const repo = selectedRepo();
  if (!repo) return;
  browsing = path;
  $("folders").replaceChildren(el("div", { className: "empty", textContent: "Loading…" }));
  let info;
  try {
    info = await api(`/api/folders?repo=${encodeURIComponent(repo.repo)}&path=${encodeURIComponent(path)}`);
  } catch (e) {
    $("folders").replaceChildren(el("div", { className: "empty", textContent: e.message }));
    return;
  }
  if (browsing !== path) return;

  const parts = path ? path.split("/") : [];
  $("crumbs").replaceChildren(
    Object.assign(el("button", { type: "button", textContent: repo.repo }), { onclick: () => browse("") }),
    ...parts.flatMap((p, i) => [
      el("span", { textContent: "/" }),
      Object.assign(el("button", { type: "button", textContent: p }), { onclick: () => browse(parts.slice(0, i + 1).join("/")) }),
    ]),
  );

  $("folders").replaceChildren(
    ...(info.folders.length
      ? info.folders.map((f) =>
          Object.assign(
            el("button", { type: "button" }, el("span", { textContent: "📁" }), f.name, f.boardId ? el("span", { className: "tag", textContent: "board" }) : null),
            { onclick: () => browse(f.path) },
          ),
        )
      : [el("div", { className: "empty", textContent: info.exists ? "No sub-folders." : "New folder: it's created when the board is." })]),
  );

  // Which folders can hold a board: new or empty ones, or ones that already hold a mergit board (imported).
  const canUse = path !== "" && (!info.hasFiles || info.isBoard) && !info.boardId;
  $("use-folder").disabled = !canUse;
  $("picker-note").replaceChildren(
    info.boardId
      ? el("span", {}, "This folder already has a board. ", el("a", { href: `/b/${info.boardId}`, textContent: "Open it" }))
      : info.isBoard
        ? "This folder holds a mergit board: choosing it imports its history."
        : info.hasFiles
          ? "This folder has other files. Pick or create a sub-folder for the board."
          : path === ""
            ? "Pick or create a folder for the board."
            : "",
  );
}

$("add-folder").onclick = () => {
  const name = slug($("new-folder").value);
  if (!$("new-folder").value.trim()) return;
  $("new-folder").value = "";
  browse(browsing ? `${browsing}/${name}` : name);
};
$("new-folder").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    $("add-folder").click();
  }
});
$("use-folder").onclick = () => {
  setPath(browsing);
  pathChosenByHand = true;
  $("picker").hidden = true;
};

// ---- create ---------------------------------------------------------------------

$("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const repo = selectedRepo();
  if (!repo) return;
  const submit = $("create-submit");
  submit.disabled = true;
  submit.textContent = "Connecting to GitHub…";
  $("create-error").hidden = true;
  try {
    const { id, imported } = await api("/api/boards", {
      method: "POST",
      body: { name: $("board-name-input").value, repo: repo.repo, path: chosenPath },
    });
    if (!imported) {
      // A new board: build its first history here, then push it to GitHub.
      submit.textContent = "Writing to GitHub…";
      const core = await loadCore("/pkg/mergit_core.wasm");
      pending.build(core);
      await pushAllBranches(core, id);
    }
    location.href = `/b/${id}`;
  } catch (err) {
    if (err.data?.boardId) {
      showError("");
      $("create-error").replaceChildren("That folder already has a board. ", el("a", { href: `/b/${err.data.boardId}`, textContent: "Open it" }));
    } else {
      showError(err.message);
    }
    submit.disabled = false;
    submit.textContent = "Create";
  }
});

if (me) {
  const author = me.name;
  $("new-board").onclick = () =>
    openCreate("New board", "Untitled board", (core) => core.call("init", { board: STARTER, author, time: Date.now() }));
  $("example-board").onclick = () => openCreate("New example board", "Checkout system", (core) => seedRepo(core, author));
  $("import").onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const data = JSON.parse(await file.text().catch(() => "{}"));
    if (!data.repo) return toast("That doesn't look like a mergit export", true);
    openCreate("Import board", file.name.replace(/\.mergit\.json$|\.json$/, ""), (core) => core.call("import", { repo: data.repo }));
  };
}
