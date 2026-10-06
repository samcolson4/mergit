// GitHub App authentication.
//
//  * App JWT (RS256, signed with the app's private key) → installation access
//    tokens: short-lived, scoped to the repos the app is installed on. All
//    writes to GitHub use these; they never leave the server.
//  * "Sign in with GitHub" (the App's user authorization flow) → a user token,
//    used only to identify the person and read which repos they can access.

import { GitHub } from "./github.js";

export const apiBase = (env) => (env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
export const webBase = (env) => (env.GITHUB_WEB_URL || "https://github.com").replace(/\/$/, "");

const REQUIRED = ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY"];
export const missingAppConfig = (env) => REQUIRED.filter((k) => !env[k]);

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

let keyPromise = null;
function signingKey(env) {
  keyPromise ??= (async () => {
    let pem = env.GITHUB_APP_PRIVATE_KEY.trim();
    if (!pem.includes("-----BEGIN")) pem = atob(pem); // allow base64-encoded PEM (handy for env vars)
    const body = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
    const pkcs8 = pem.includes("BEGIN RSA PRIVATE KEY") ? pkcs1ToPkcs8(body) : body;
    return crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  })();
  return keyPromise;
}

async function appJwt(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = b64url(encoder.encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(env.GITHUB_APP_ID) })));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await signingKey(env), encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
}

// ---- installation tokens --------------------------------------------------------

const installationTokens = new Map(); // installation id → { token, expires } (per isolate)

export async function installationToken(env, installationId) {
  const cached = installationTokens.get(installationId);
  if (cached && cached.expires - Date.now() > 5 * 60_000) return cached.token;
  const gh = new GitHub(await appJwt(env), apiBase(env));
  const res = await gh.request("POST", `/app/installations/${installationId}/access_tokens`);
  installationTokens.set(installationId, { token: res.token, expires: Date.parse(res.expires_at) });
  return res.token;
}

export async function installationClient(env, installationId) {
  return new GitHub(await installationToken(env, installationId), apiBase(env));
}

// ---- sign in with GitHub ----------------------------------------------------------

export function authorizeUrl(env, redirectUri, state) {
  const q = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: redirectUri, state });
  return `${webBase(env)}/login/oauth/authorize?${q}`;
}

/** Exchange an authorization code (or a refresh token) for a user access token. */
export async function userToken(env, params) {
  const res = await fetch(`${webBase(env)}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "mergit" },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, ...params }),
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

export const installUrl = (env) => `${webBase(env)}/apps/${env.GITHUB_APP_SLUG}/installations/new`;
