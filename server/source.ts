// Where AgentOS comes from when the plugin is installed on its own (staff): the company service.
// The plugin holds no company content; it downloads the AgentOS release as a Git bundle.
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { identityToken, signedInEmail, signOut, type IdentityConfig } from "./google";
import { bundleFile, exists, lastLines, run, serviceFile, sourceDir, stateDir } from "./util";

export interface Service {
  url: string;
  key: string;
  // Present when the service asks for per-person Google sign-in.
  identity?: IdentityConfig | null;
}

export class IdentityRequired extends Error {}

let lastCheck = 0;
const CHECK_EVERY_MS = 60 * 60 * 1000;

export async function loadService(): Promise<Service | null> {
  try {
    const parsed = JSON.parse(await readFile(serviceFile(), "utf8")) as Service;
    // The key is optional when the service lets people connect with Google sign-in alone.
    return parsed.url ? { ...parsed, key: parsed.key ?? "" } : null;
  } catch {
    return null;
  }
}

async function saveService(service: Service) {
  await mkdir(stateDir(), { recursive: true });
  const tmp = `${serviceFile()}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(service), { mode: 0o600 });
  await rename(tmp, serviceFile());
  await chmod(serviceFile(), 0o600);
}

export function normaliseUrl(value: string) {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("The service address must start with https://.");
  }
  return url.toString().replace(/\/$/, "");
}

async function headers(service: Service): Promise<Record<string, string>> {
  const out: Record<string, string> = service.key ? { Authorization: `Bearer ${service.key}` } : {};
  if (service.identity) {
    const token = await identityToken(service.identity.clientId);
    if (token) out["X-AgentOS-Identity"] = token;
  }
  return out;
}

async function refusal(res: Response) {
  const data = (await res.clone().json().catch(() => ({}))) as { code?: string; error?: string };
  if (data.code === "identity_required") return new IdentityRequired("Sign in with your Manukora Google account first.");
  if (data.code === "revoked") return new Error(data.error || "Your AgentOS access was turned off. Ask AI & Systems.");
  if (res.status === 401) return new Error("That access key was not accepted. Copy it again from 1Password.");
  return null;
}

async function call(service: Service, route: string, timeoutMs = 120000) {
  const sent = await headers(service);
  const res = await fetch(`${service.url}${route}`, {
    headers: sent,
    signal: (AbortSignal as unknown as { timeout(ms: number): AbortSignal }).timeout(timeoutMs),
  });
  const refused = await refusal(res);
  // The service rejected the saved sign-in: forget it, so the screen asks for a fresh one.
  if (refused instanceof IdentityRequired && sent["X-AgentOS-Identity"]) await signOut(sent["X-AgentOS-Identity"]);
  if (refused) throw refused;
  if (!res.ok) throw new Error(`The Manukora service answered ${res.status}. Try again, or tell AI & Systems.`);
  return res;
}

async function sourceHead() {
  if (!(await exists(path.join(sourceDir(), ".git")))) return "";
  return (await run("git", ["-C", sourceDir(), "rev-parse", "HEAD"])).out.split("\n")[0]?.trim() ?? "";
}

// One download at a time: a double click or a status refresh must not share the temp file or
// run two Git operations in the same folder.
let downloading: Promise<void> = Promise.resolve();
function download(service: Service) {
  const next = downloading.then(() => downloadNow(service));
  downloading = next.catch(() => undefined);
  return next;
}

async function downloadNow(service: Service) {
  const res = await call(service, "/v1/bundle");
  await mkdir(stateDir(), { recursive: true });
  const tmp = `${bundleFile()}.${process.pid}.tmp`;
  await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  const verify = await run("git", ["bundle", "list-heads", tmp]);
  if (verify.code !== 0 || !/refs\/heads\/main/.test(verify.out)) {
    await rm(tmp, { force: true });
    throw new Error("The AgentOS download was incomplete. Try again.");
  }
  const dir = sourceDir();
  if (!(await exists(path.join(dir, ".git")))) {
    await rm(dir, { recursive: true, force: true });
    const clone = await run("git", ["clone", "-q", "--branch", "main", tmp, dir], { timeoutMs: 300000 });
    if (clone.code !== 0) throw new Error(`Copying AgentOS did not finish: ${lastLines(clone.out)}`);
  } else {
    const fetched = await run("git", ["-C", dir, "fetch", "-q", tmp, "main"], { timeoutMs: 300000 });
    if (fetched.code !== 0) throw new Error(`Updating AgentOS did not finish: ${lastLines(fetched.out)}`);
    await run("git", ["-C", dir, "reset", "-q", "--hard", "FETCH_HEAD"]);
  }
  await rename(tmp, bundleFile());
}

// Check the key and connect for the first time. Nothing is saved unless the key works. When the
// service asks for Google sign-in, the key is saved and the download waits for the sign-in.
export async function connect(url: string, key: string): Promise<"downloaded" | "needs-sign-in"> {
  const service: Service = { url: normaliseUrl(url), key: key.trim() };
  const config = (await (await call(service, "/v1/config")).json()) as { identity?: IdentityConfig | null; keyNeeded?: boolean };
  service.identity = config.identity ?? null;
  if (!service.key && config.keyNeeded !== false) throw new Error("Paste your AgentOS access key first.");
  if (service.identity?.required && !(await identityToken(service.identity.clientId))) {
    await saveService(service);
    return "needs-sign-in";
  }
  try {
    await fetchRelease(service);
  } catch (error) {
    // A leftover or revoked sign-in: keep the accepted key and ask for a fresh sign-in.
    if (error instanceof IdentityRequired) {
      await saveService(service);
      return "needs-sign-in";
    }
    throw error;
  }
  await saveService(service);
  return "downloaded";
}

async function fetchRelease(service: Service) {
  const release = (await (await call(service, "/v1/release")).json()) as { sha?: string };
  if (!release.sha) throw new Error("The Manukora service did not say which release to use.");
  await download(service);
  lastCheck = Date.now();
}

// The service can switch Google sign-in on (or off) after someone connected. Pick that up.
async function refreshConfig(service: Service) {
  const config = (await (await call(service, "/v1/config", 10000)).json()) as { identity?: IdentityConfig | null };
  const identity = config.identity ?? null;
  if (JSON.stringify(identity) !== JSON.stringify(service.identity ?? null)) {
    service.identity = identity;
    await saveService(service);
  }
  return service;
}

// After Google sign-in: download the release now.
export async function downloadAfterSignIn() {
  const service = await loadService();
  if (!service) throw new Error("Connect to Manukora first.");
  await fetchRelease(service);
}

// At most hourly, fetch a newer release if the service has one. Failures never block the screen.
// Callers during a check share it, so nobody returns early while the old bundle is still in place.
// For tests: forget when the release was last checked.
export function forgetReleaseCheck() {
  lastCheck = 0;
}

let refreshing: Promise<void> | null = null;
export function refreshSource(force = false): Promise<void> {
  // A forced check must really check, so it runs after one already under way.
  if (refreshing) return force ? refreshing.then(() => refreshSource(true)) : refreshing;
  refreshing = (async () => {
    const service = await loadService();
    if (!service || (!force && Date.now() - lastCheck < CHECK_EVERY_MS)) return;
    try {
      // The release check is small, so a slow or hung service fails it quickly and later agents
      // skip the check until the next hour instead of each waiting on it.
      // Shares the short timeout: if the service is unreachable this fails fast and is recorded.
      await refreshConfig(service);
      const release = (await (await call(service, "/v1/release", 10000)).json()) as { sha?: string };
      if (release.sha && release.sha !== (await sourceHead())) await download(service);
      lastCheck = Date.now();
    } catch (error) {
      lastCheck = Date.now();
      console.error(`AgentOS release check failed: ${error instanceof Error ? error.message : error}`);
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export async function fileReport(title: string, body: string, reporter: string) {
  const service = await loadService();
  if (!service) return null;
  const res = await fetch(`${service.url}/v1/reports`, {
    method: "POST",
    headers: { ...(await headers(service)), "Content-Type": "application/json" },
    body: JSON.stringify({ title, body, reporter }),
    signal: (AbortSignal as unknown as { timeout(ms: number): AbortSignal }).timeout(60000),
  });
  const data = (await res.json().catch(() => ({}))) as { number?: number; error?: string };
  if (!res.ok) throw new Error(data.error || `The report could not be filed (${res.status}).`);
  return data.number ? `#${data.number}` : "";
}

export interface TeamKeys {
  configured: boolean;
  roles: string[];
  keys: Record<string, string | true>;
  unavailable: string[];
}

// The person's team keys from Manukora's service. Values are fetched fresh for every starting
// session (never cached), so turning someone off or changing their role takes effect at once.
// Names for the setup screen are cached for a minute per signed-in person, and only when the
// answer is complete: an unconfigured service or a missing key is asked again next time.
const keyCache = new Map<string, { at: number; value: TeamKeys }>();
export async function teamKeys(withValues: boolean, refresh = false): Promise<TeamKeys | null> {
  const service = await loadService();
  if (!service?.identity) return null;
  const who = (await signedInEmail()) || "unknown";
  if (refresh) keyCache.delete(who);
  const hit = withValues ? undefined : keyCache.get(who);
  if (hit && Date.now() - hit.at < 60 * 1000) return hit.value;
  try {
    const res = await call(service, withValues ? "/v1/keys" : "/v1/keys?names=1", 10000);
    const value = (await res.json()) as TeamKeys;
    if (!withValues && value.configured && !value.unavailable.length) keyCache.set(who, { at: Date.now(), value });
    return value;
  } catch (error) {
    keyCache.delete(who);
    console.error(`AgentOS key check failed: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

// For tests.
export function forgetTeamKeys() {
  keyCache.clear();
}
