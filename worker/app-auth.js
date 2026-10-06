// GitHub App authentication.
//
//  * App JWT (RS256, signed with the app's private key) → installation access
//    tokens: short-lived, scoped to the repos the app is installed on. All
//    writes to GitHub use these; they never leave the server.
//  * "Sign in with GitHub" (the App's user authorization) → a user token,
//    used only to identify the person and read which repos they can access.
//
// The app's credentials come from one of:
//  * environment (GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_CLIENT_ID,
//    GITHUB_CLIENT_SECRET, GITHUB_APP_PRIVATE_KEY): set by hand, takes priority
//  * the Directory's storage: written by the in-app setup, which creates the
//    app through GitHub's manifest flow (see directory.js)

import { GitHub } from "./github.js";

export const apiBase = (env) => (env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
export const webBase = (env) => (env.GITHUB_WEB_URL || "https://github.com").replace(/\/$/, "");

/** App credentials from the environment, or null if they aren't all set there. */
export function envAppConfig(env) {
  const cfg = {
    appId: env.GITHUB_APP_ID,
    slug: env.GITHUB_APP_SLUG,
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
  };
  return Object.values(cfg).every(Boolean) ? cfg : null;
}

let cached = { cfg: null, at: 0 };

/** The Directory holds the stored config; it passes it here instead of fetching from itself. */
export function primeAppConfig(cfg) {
  if (cfg) cached = { cfg, at: Date.now() };
}

/** The app's credentials (from env, else from the Directory), or null before setup. */
export async function appConfig(env) {
  const fromEnv = envAppConfig(env);
  if (fromEnv) return fromEnv;
  if (cached.cfg && Date.now() - cached.at < 60_000) return cached.cfg;
  const res = await env.DIRECTORY.get(env.DIRECTORY.idFromName("directory")).fetch("https://directory/internal/app-config");
  const cfg = res.ok ? await res.json() : null;
  if (cfg) cached = { cfg, at: Date.now() };
  return cfg;
}

export async function requireAppConfig(env) {
  const cfg = await appConfig(env);
  if (!cfg) throw Object.assign(new Error("mergit isn't connected to GitHub yet. Open the home page to set it up."), { status: 503 });
  return cfg;
}

// ---- manifest flow (in-app setup) ----------------------------------------------------

/** The app GitHub will create: just what mergit needs, nothing more. */
export function appManifest(origin, name) {
  return {
    name,
    url: origin,
    redirect_url: `${origin}/setup/callback`, // GitHub returns here with a code after creating the app
    callback_urls: [`${origin}/auth/callback`], // sign-in
    setup_url: `${origin}/?installed=1`, // after installing on repos
    public: false,
    default_permissions: { contents: "write", metadata: "read" },
    default_events: [],
    hook_attributes: { url: `${origin}/webhooks/github`, active: false },
  };
}

/** Where to send the manifest: a personal account, or an organization. */
export function manifestAction(env, org, state) {
  const base = org ? `${webBase(env)}/organizations/${encodeURIComponent(org)}/settings/apps/new` : `${webBase(env)}/settings/apps/new`;
  return `${base}?state=${encodeURIComponent(state)}`;
}

/** Exchange the code GitHub returned for the new app's credentials. */
export async function convertManifest(env, code) {
  const res = await fetch(`${apiBase(env)}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "user-agent": "mergit" },
  });
  const app = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub couldn't finish creating the app: ${app.message ?? res.status}`);
  return {
    appId: String(app.id),
    slug: app.slug,
    clientId: app.client_id,
    clientSecret: app.client_secret,
    privateKey: app.pem,
    owner: app.owner?.login ?? null,
    htmlUrl: app.html_url ?? null,
  };
}

// ---- private key & JWT ----------------------------------------------------------

const encoder = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function derLength(n) {
  if (n < 128) return [n];
  const bytes = [];
  for (; n > 0; n >>= 8) bytes.unshift(n & 255);
  return [0x80 | bytes.length, ...bytes];
}

const der = (tag, content) => new Uint8Array([tag, ...derLength(content.length), ...content]);

/** GitHub issues PKCS#1 ("BEGIN RSA PRIVATE KEY") keys; WebCrypto wants PKCS#8. */
function pkcs1ToPkcs8(pkcs1) {
  const version = [0x02, 0x01, 0x00];
  const rsaEncryption = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  return der(0x30, [...version, ...rsaEncryption, ...der(0x04, pkcs1)]);
}

const keys = new Map(); // pem → CryptoKey promise
function signingKey(privateKey) {
  if (!keys.has(privateKey)) {
    keys.set(privateKey, (async () => {
      let pem = privateKey.trim();
      if (!pem.includes("-----BEGIN")) pem = atob(pem); // allow base64-encoded PEM (handy for env vars)
      const body = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
      const pkcs8 = pem.includes("BEGIN RSA PRIVATE KEY") ? pkcs1ToPkcs8(body) : body;
      return crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    })());
  }
  return keys.get(privateKey);
}

async function appJwt(cfg) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = b64url(encoder.encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(cfg.appId) })));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await signingKey(cfg.privateKey), encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
}

// ---- installation tokens --------------------------------------------------------

const installationTokens = new Map(); // `${appId}:${installation}` → { token, expires } (per isolate)

export async function installationToken(env, installationId) {
  const cfg = await requireAppConfig(env);
  const key = `${cfg.appId}:${installationId}`;
  const hit = installationTokens.get(key);
  if (hit && hit.expires - Date.now() > 5 * 60_000) return hit.token;
  const gh = new GitHub(await appJwt(cfg), apiBase(env));
  const res = await gh.request("POST", `/app/installations/${installationId}/access_tokens`);
  installationTokens.set(key, { token: res.token, expires: Date.parse(res.expires_at) });
  return res.token;
}

export async function installationClient(env, installationId) {
  return new GitHub(await installationToken(env, installationId), apiBase(env));
}

// ---- sign in with GitHub ----------------------------------------------------------

export function authorizeUrl(env, cfg, redirectUri, state) {
  const q = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: redirectUri, state });
  return `${webBase(env)}/login/oauth/authorize?${q}`;
}

/** Exchange an authorization code (or a refresh token) for a user access token. */
export async function userToken(env, cfg, params) {
  const res = await fetch(`${webBase(env)}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "mergit" },
    body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || !data.access_token) {
    throw new Error(data.error_description ?? data.error ?? `GitHub sign-in failed (${res.status})`);
  }
  const now = Date.now();
  return {
    token: data.access_token,
    // Tokens without expiry (if the App has expiring tokens turned off) get a far-future date.
    expires: data.expires_in ? now + data.expires_in * 1000 : now + 365 * 86_400_000,
    refresh: data.refresh_token ?? null,
    refreshExpires: data.refresh_token_expires_in ? now + data.refresh_token_expires_in * 1000 : null,
  };
}

export const installUrl = (env, cfg) => `${webBase(env)}/apps/${cfg.slug}/installations/new`;
