// Per-person GitHub access. Each person's token stays in their own browser and
// is sent (as `x-github-token`) only with requests that write to GitHub. The
// server uses it for that request and never stores it.

import { api, el } from "./util.js";

const KEY = "mergit.github";

export const github = {
  get() {
    try {
      return JSON.parse(localStorage.getItem(KEY)) ?? null; // { token, login, name }
    } catch {
      return null;
    }
  },
  set(value) {
    try {
      if (value) localStorage.setItem(KEY, JSON.stringify(value));
      else localStorage.removeItem(KEY);
    } catch {}
    listeners.forEach((fn) => fn(value));
  },
  token() {
    return this.get()?.token ?? null;
  },
};

const listeners = new Set();
export const onGithubChange = (fn) => listeners.add(fn);

let dialog;

function build() {
  const input = el("input", { type: "password", autocomplete: "off", spellcheck: false, placeholder: "github_pat_…" });
  const reason = el("p", { className: "notice" });
  const status = el("p", { className: "muted small" });
  const error = el("p", { className: "form-error", hidden: true });
  const remove = el("button", { type: "button", className: "btn ghost danger", textContent: "Disconnect" });
  const cancel = el("button", { type: "button", className: "btn ghost", textContent: "Cancel" });
  const save = el("button", { type: "submit", className: "btn primary", textContent: "Save" });
  const link = el("a", {
    href: "https://github.com/settings/personal-access-tokens/new",
    target: "_blank",
    rel: "noopener",
    textContent: "Create a fine-grained token",
  });
  const form = el(
    "form",
    {},
    el("h2", { textContent: "GitHub" }),
    reason,
    el("label", {}, "Personal access token", input),
    el(
      "p",
      { className: "muted small" },
      link,
      " with access to the repositories your boards use, and the permission ",
      el("strong", { textContent: "Contents: Read and write" }),
      ". It's kept in this browser only and sent just with commits; your commits appear on GitHub as you.",
    ),
    status,
    error,
    el("div", { className: "row end" }, remove, el("span", { className: "grow" }), cancel, save),
  );
  dialog = el("dialog", { className: "dialog" }, form);
  document.body.append(dialog);
  return { dialog, form, input, reason, status, error, remove, cancel, save };
}

/** Open the GitHub settings. Resolves true if a token is saved. */
export function openGithubSettings(why = "") {
  const ui = dialog ? openGithubSettings.ui : (openGithubSettings.ui = build());
  const current = github.get();
  ui.reason.textContent = why;
  ui.reason.hidden = !why;
  ui.input.value = "";
  ui.input.placeholder = current ? "Paste a new token to replace it" : "github_pat_…";
  ui.status.textContent = current ? `Connected as @${current.login}${current.name ? ` (${current.name})` : ""}.` : "Not connected.";
  ui.error.hidden = true;
  ui.remove.hidden = !current;
  ui.save.disabled = false;
  ui.save.textContent = "Save";

  return new Promise((resolve) => {
    const done = (saved) => {
      ui.form.onsubmit = ui.cancel.onclick = ui.remove.onclick = ui.dialog.onclose = null;
      if (ui.dialog.open) ui.dialog.close();
      resolve(saved);
    };
    ui.cancel.onclick = () => done(false);
    ui.dialog.onclose = () => done(false);
    ui.remove.onclick = () => {
      github.set(null);
      done(false);
    };
    ui.form.onsubmit = async (e) => {
      e.preventDefault();
      const token = ui.input.value.trim();
      if (!token) return done(Boolean(current));
      ui.save.disabled = true;
      ui.save.textContent = "Checking…";
      try {
        const user = await api("/api/github/user", { token });
        github.set({ token, login: user.login, name: user.name ?? "" });
        done(true);
      } catch (err) {
        ui.error.textContent = err.message;
        ui.error.hidden = false;
        ui.save.disabled = false;
        ui.save.textContent = "Save";
      }
    };
    ui.dialog.showModal();
    ui.input.focus();
  });
}

/** A small "Connect GitHub" / "@login" button that opens the settings. */
export function githubButton() {
  const button = el("button", { className: "btn ghost github-button", type: "button" });
  const render = (value) => {
    button.textContent = value ? `@${value.login}` : "Connect GitHub";
    button.title = value ? "GitHub connected: change or disconnect" : "Add your GitHub token to commit to GitHub-backed boards";
  };
  render(github.get());
  onGithubChange(render);
  button.onclick = () => openGithubSettings();
  return button;
}
