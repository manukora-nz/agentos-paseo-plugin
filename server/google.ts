// Per-person Google sign-in for the company service (optional, switched on by the service).
// Desktop OAuth with PKCE and a loopback redirect: the browser does the sign-in, the plugin keeps
// the ID token (refreshed when it expires) and sends it to the service with every call.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { run, stateDir } from "./util";

export interface IdentityConfig {
  required: boolean;
  clientId: string;
  clientSecret: string;
  domain: string;
  authUrl: string;
  tokenUrl: string;
}

interface Saved {
  idToken: string;
  refreshToken: string;
  expiresAt: number;
  email: string;
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
}

const file = () => path.join(stateDir(), "identity.json");
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

// No shell is involved, so characters in the URL are never treated as commands.
let openBrowser = async (url: string) => {
  if (process.platform === "win32") await run("rundll32", ["url.dll,FileProtocolHandler", url]);
  else if (process.platform === "darwin") await run("open", [url]);
  else await run("xdg-open", [url]);
};

function checkedUrl(value: string) {
  const url = new URL(value);
  const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopback) throw new Error("The sign-in address from the service is not secure.");
  return url;
}

// For tests: stand in for the browser.
export function setBrowserOpener(fn: (url: string) => Promise<void>) {
  openBrowser = fn;
}

function claimsOf(idToken: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

async function loadSaved(): Promise<Saved | null> {
  try {
    const saved = JSON.parse(await readFile(file(), "utf8")) as Saved;
    return saved.idToken ? saved : null;
  } catch {
    return null;
  }
}

// Every change to the saved sign-in (save, refresh, forget) runs one at a time, so a compare and
// the write that depends on it cannot interleave with another change.
let identityLock: Promise<unknown> = Promise.resolve();
function withIdentityLock<T>(work: () => Promise<T>): Promise<T> {
  const next = identityLock.then(work, work);
  identityLock = next.catch(() => undefined);
  return next;
}

async function save(saved: Saved) {
  await mkdir(stateDir(), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(saved), { mode: 0o600 });
  await rename(tmp, file());
}

export async function signedInEmail() {
  return (await loadSaved())?.email ?? "";
}

// Forget the saved sign-in. With a token, only if that exact sign-in is still the saved one, so a
// sign-in that completed meanwhile is kept.
export function signOut(onlyToken?: string) {
  return withIdentityLock(async () => {
    if (onlyToken && (await loadSaved())?.idToken !== onlyToken) return;
    await rm(file(), { force: true });
  });
}

async function tokenRequest(tokenUrl: string, form: Record<string, string>) {
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: (AbortSignal as unknown as { timeout(ms: number): AbortSignal }).timeout(30000),
  });
  const data = (await res.json().catch(() => ({}))) as { id_token?: string; refresh_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !data.id_token) throw new Error(`Google sign-in did not finish (${data.error ?? res.status}).`);
  return data;
}

function expiryOf(idToken: string, expiresIn?: number) {
  const exp = Number(claimsOf(idToken).exp);
  return exp ? exp * 1000 : Date.now() + (expiresIn ?? 3600) * 1000;
}

// The current ID token, refreshed when under 10 minutes remain (agents get a copy, so it should
// last). Empty when not signed in, signed in for a different client, or refresh failed.
const refreshes = new Map<string, Promise<string>>();
export async function identityToken(clientId?: string): Promise<string> {
  const saved = await loadSaved();
  if (!saved || (clientId && saved.clientId !== clientId)) return "";
  if (saved.expiresAt - 10 * 60000 > Date.now()) return saved.idToken;
  if (!saved.refreshToken) return "";
  // One refresh per saved sign-in, so a refresh for an older sign-in is never handed to a newer one.
  let pending = refreshes.get(saved.idToken);
  if (!pending) {
    pending = (async () => {
      try {
        const data = await tokenRequest(saved.tokenUrl, {
          grant_type: "refresh_token",
          refresh_token: saved.refreshToken,
          client_id: saved.clientId,
          client_secret: saved.clientSecret,
        });
        const idToken = data.id_token!;
        // Only replace the sign-in this refresh started from; a newer sign-in wins.
        return await withIdentityLock(async () => {
          if ((await loadSaved())?.idToken !== saved.idToken) return "";
          await save({ ...saved, idToken, expiresAt: expiryOf(idToken, data.expires_in), refreshToken: data.refresh_token || saved.refreshToken });
          return idToken;
        });
      } catch (error) {
        console.error(`AgentOS Google refresh failed: ${error instanceof Error ? error.message : error}`);
        return "";
      }
    })().finally(() => refreshes.delete(saved.idToken));
    refreshes.set(saved.idToken, pending);
  }
  const token = await pending;
  if (!token) {
    // A newer sign-in may have landed meanwhile: use it if it fits.
    const now = await loadSaved();
    if (now && now.idToken !== saved.idToken && (!clientId || now.clientId === clientId) && now.expiresAt > Date.now()) return now.idToken;
  }
  return token;
}

const page = (text: string) =>
  `<!doctype html><meta charset="utf-8"><title>AgentOS</title><body style="font-family:sans-serif;padding:3em">${text}</body>`;

// Opens the browser at Google, waits for the redirect, and saves the result. Resolves to the email.
export function signIn(config: IdentityConfig): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");
  return new Promise((resolve, reject) => {
    // Inside the promise, so a bad address rejects rather than throws.
    const authBase = checkedUrl(config.authUrl);
    checkedUrl(config.tokenUrl);
    let settled = false;
    let exchanging = false;
    const finish = (error: Error | null, email = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (error) reject(error);
      else resolve(email);
    };
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      if (url.searchParams.get("state") !== state) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(page("This sign-in link is out of date. Start again from AgentOS setup."));
        return;
      }
      if (exchanging || settled) {
        res.writeHead(200, { "Content-Type": "text/html" }).end(page("Already signing you in. You can close this tab."));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(page("Sign-in was cancelled. You can close this tab."));
        finish(new Error("Google sign-in was cancelled."));
        return;
      }
      exchanging = true;
      try {
        const redirect = `http://127.0.0.1:${(server.address() as { port: number }).port}/callback`;
        const data = await tokenRequest(config.tokenUrl, {
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: redirect,
          client_id: config.clientId,
          client_secret: config.clientSecret,
        });
        const idToken = data.id_token!;
        const claims = claimsOf(idToken);
        const email = String(claims.email ?? "").toLowerCase();
        if (String(claims.hd ?? "").toLowerCase() !== config.domain) {
          throw new Error(`Sign in with your ${config.domain} Google account, not ${email || "a personal one"}.`);
        }
        await withIdentityLock(() => save({
          idToken,
          refreshToken: data.refresh_token ?? "",
          expiresAt: expiryOf(idToken, data.expires_in),
          email,
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          tokenUrl: config.tokenUrl,
        }));
        res.writeHead(200, { "Content-Type": "text/html" }).end(page("Signed in. You can close this tab and go back to Paseo."));
        finish(null, email);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.writeHead(400, { "Content-Type": "text/html" }).end(page(message.replace(/[<>&]/g, "")));
        finish(new Error(message));
      }
    });
    const timer = setTimeout(() => finish(new Error("Google sign-in timed out. Press Sign in again.")), SIGN_IN_TIMEOUT_MS);
    timer.unref?.();
    server.listen(0, "127.0.0.1", () => {
      const redirect = `http://127.0.0.1:${(server.address() as { port: number }).port}/callback`;
      const auth = new URL(authBase.toString());
      for (const [key, value] of Object.entries({
        client_id: config.clientId,
        redirect_uri: redirect,
        response_type: "code",
        scope: "openid email profile",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        hd: config.domain,
        access_type: "offline",
        prompt: "consent",
      })) {
        auth.searchParams.set(key, value);
      }
      openBrowser(auth.toString()).catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
    });
  });
}
