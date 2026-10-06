import { loadCore } from "./core.js";
import { STARTER, seedRepo } from "./templates.js";
import { api, el, identity, pushAllBranches, rename } from "./util.js";

const $ = (id) => document.getElementById(id);
let me = identity();
$("me").textContent = me.name;

let toastTimer;
function toast(msg, isError = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (isError ? " error" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
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
            el("span", { className: "when", textContent: new Date(b.created).toLocaleString() }),
          ),
        )
      : [el("div", { className: "empty-state", textContent: "No boards yet. Create one to get started." })]),
  );
}

/** Create a board on the server, build its history locally, push it, and open it. */
async function createBoard(defaultName, build) {
  const name = prompt("Board name", defaultName)?.trim();
  if (!name) return;
  try {
    const core = await loadCore("/pkg/mergit_core.wasm");
    build(core);
    const { id } = await api("/api/boards", { method: "POST", body: { name } });
    await pushAllBranches(core, id, me.name);
    location.href = `/b/${id}`;
  } catch (e) {
    toast(e.message, true);
  }
}

$("new-board").onclick = () =>
  createBoard("Untitled board", (core) => core.call("init", { board: STARTER, author: me.name, time: Date.now() }));

$("example-board").onclick = () => createBoard("Checkout system", (core) => seedRepo(core, me.name));

$("import").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const data = JSON.parse(await file.text().catch(() => "{}"));
  if (!data.repo) return toast("That doesn't look like a mergit export", true);
  createBoard(file.name.replace(/\.(mergit|gitmer)\.json$|\.json$/, ""), (core) => core.call("import", { repo: data.repo }));
};

$("rename").onclick = () => {
  const name = rename();
  if (name) {
    me = identity();
    $("me").textContent = me.name;
  }
};

listBoards().catch((e) => {
  $("boards").replaceChildren(el("div", { className: "empty-state", textContent: `Couldn't load boards: ${e.message}` }));
});
