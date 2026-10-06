import { loadCore } from "./core.js";
import { github as githubAuth, githubButton, openGithubSettings } from "./settings.js";
import { STARTER, seedRepo } from "./templates.js";
import { api, el, identity, pushAllBranches, rename } from "./util.js";

const $ = (id) => document.getElementById(id);
let me = identity();
$("me").textContent = me.name;
$("rename").after(" · ", githubButton());

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
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60);

const config = await api("/api/config").catch(() => ({ github: null }));

async function listBoards() {
  const { boards } = await api("/api/boards");
  $("boards").replaceChildren(
    ...(boards.length
      ? boards.map((b) =>
          el(
            "a",
            { className: "board-card", href: `/b/${b.id}` },
            el("span", { className: "name", textContent: b.name }),
            el("span", { className: "when", textContent: new Date(b.created).toLocaleString() }),
          ),
        )
      : [el("div", { className: "empty-state", textContent: "No boards yet. Create one to get started." })]),
  );
}

// ---- create dialog --------------------------------------------------------------

const dialog = $("create");
let pending = null; // { build(core) } for the board being created
let pathEdited = false;

function storage() {
  return dialog.querySelector('input[name="storage"]:checked').value;
}

function syncStorage() {
  $("github-fields").hidden = storage() !== "github";
  for (const id of ["gh-repo", "gh-path"]) $(id).required = storage() === "github";
}

function openCreate(title, defaultName, build) {
  pending = { build };
  pathEdited = false;
  $("create-title").textContent = title;
  $("board-name-input").value = defaultName;
  $("create-error").hidden = true;
  $("storage").hidden = !config.github;
  dialog.querySelector(`input[value="${config.github ? "github" : "local"}"]`).checked = true;
  if (config.github) {
    $("gh-repo").value ||= config.github.repo;
    $("gh-branch").value ||= config.github.branch;
    $("gh-path").value = `${config.github.dir ? `${config.github.dir}/` : ""}${slug(defaultName)}`;
  }
  syncStorage();
  dialog.showModal();
  $("board-name-input").select();
}

$("board-name-input").addEventListener("input", () => {
  if (config.github && !pathEdited) {
    $("gh-path").value = `${config.github.dir ? `${config.github.dir}/` : ""}${slug($("board-name-input").value)}`;
  }
});
$("gh-path").addEventListener("input", () => (pathEdited = true));
dialog.querySelectorAll('input[name="storage"]').forEach((r) => r.addEventListener("change", syncStorage));
$("create-cancel").onclick = () => dialog.close();

$("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const submit = $("create-submit");
  const github =
    storage() === "github"
      ? { repo: $("gh-repo").value.trim(), path: $("gh-path").value.trim(), branch: $("gh-branch").value.trim() }
      : null;
  if (github && !githubAuth.token() && !config.github?.serverToken) {
    if (!(await openGithubSettings("Boards stored on GitHub are written with your own token. Add it to continue."))) return;
  }
  submit.disabled = true;
  submit.textContent = github ? "Connecting to GitHub…" : "Creating…";
  $("create-error").hidden = true;
  try {
    const { id, imported } = await api("/api/boards", { method: "POST", body: { name: $("board-name-input").value, github } });
    if (!imported) {
      // A new board: build its first history here, then push it (to GitHub, if chosen).
      submit.textContent = github ? "Writing to GitHub…" : "Saving…";
      const core = await loadCore("/pkg/mergit_core.wasm");
      pending.build(core);
      await pushAllBranches(core, id, me.name);
    }
    location.href = `/b/${id}`;
  } catch (err) {
    $("create-error").textContent = err.message;
    $("create-error").hidden = false;
    submit.disabled = false;
    submit.textContent = "Create";
  }
});

$("new-board").onclick = () =>
  openCreate("New board", "Untitled board", (core) => core.call("init", { board: STARTER, author: me.name, time: Date.now() }));

$("example-board").onclick = () => openCreate("New example board", "Checkout system", (core) => seedRepo(core, me.name));

$("import").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const data = JSON.parse(await file.text().catch(() => "{}"));
  if (!data.repo) return toast("That doesn't look like a mergit export", true);
  const name = file.name.replace(/\.(mergit|gitmer)\.json$|\.json$/, "");
  openCreate("Import board", name, (core) => core.call("import", { repo: data.repo }));
};

$("rename").onclick = () => {
  if (rename()) {
    me = identity();
    $("me").textContent = me.name;
  }
};

listBoards().catch((e) => {
  $("boards").replaceChildren(el("div", { className: "empty-state", textContent: `Couldn't load boards: ${e.message}` }));
});
