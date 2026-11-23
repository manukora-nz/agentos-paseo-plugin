import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { execFileSync } from "node:child_process";
import { testMode } from "./util";

// Connect Slack (AIS-479, council-revised design of 20 Nov 2026, build review fixes the same day).
// The Slack web session is read from a throwaway Chrome profile that exists only for this sign-in:
// never the agent browser, which agents can drive. Chrome is driven over a private DevTools pipe to
// the child this plugin started (no debugging port anyone else could reach). The page is read in an
// isolated script world, so the page's own scripts cannot change what is reported. Only the Manukora
// team's token and the d cookie are read; Chrome is then closed and the profile deleted.

export const SLACK_ORIGIN = "https://app.slack.com";
const DOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TEAM_RE = /^T[A-Z0-9]{6,15}$/;

// Manukora's Slack workspace. Pinned: a session for any other workspace is refused. Only the plugin's
// own test mode (a throwaway test home) can point these elsewhere, through setPinnedForTests.
export let SLACK_DOMAIN = "manukorageneral";
// Confirmed 22 Nov 2026 from Slack's own auth.test for manukorageneral (the earlier T02LWJNH7J0, taken
// from a channel link, was wrong and Connect correctly refused).
export let SLACK_TEAM_ID = "T01KMTF8HMH";
export function setPinnedForTests(teamId: string, domain = SLACK_DOMAIN) {
  if (!testMode || !TEAM_RE.test(teamId) || !DOMAIN_RE.test(domain)) return;
  SLACK_TEAM_ID = teamId;
  SLACK_DOMAIN = domain;
}

const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 2000;
const CALL_TIMEOUT_MS = 10000;
const ABANDONED_MS = 30 * 60 * 1000;
const PROFILE_PREFIX = "agentos-slack-signin-";
const MAX_BUFFER = 8 * 1024 * 1024;

export interface AuthInfo {
  ok: boolean;
  teamId: string;
  userId: string;
  user: string;
  url: string;
  error?: string;
}

export type ReadResult =
  | { state: "waiting" }
  | { state: "closed" }
  | { state: "several"; count: number }
  | { state: "wrong-workspace" }
  | { state: "ok"; xoxc: string; xoxd: string; teamId: string };

// ---- pure checks (unit-tested) ----

// The d cookie only; every other cookie is dropped here and never kept.
export function pickCookie(cookies: unknown): string {
  const list = Array.isArray(cookies) ? (cookies as { name?: string; domain?: string; value?: string }[]) : [];
  const d = list.find((c) => c?.name === "d" && typeof c.domain === "string" && /^(.+\.)?slack\.com$/.test(c.domain.replace(/^\./, "")));
  return typeof d?.value === "string" ? d.value : "";
}

// What the isolated-world expression returned, checked field by field before anything is used.
export function interpret(page: unknown, xoxd: string, teamId = SLACK_TEAM_ID): ReadResult {
  const p = (page ?? {}) as { origin?: unknown; count?: unknown; token?: unknown; teamId?: unknown };
  if (p.origin !== SLACK_ORIGIN) return { state: "waiting" };
  const count = typeof p.count === "number" && Number.isInteger(p.count) && p.count >= 0 ? p.count : 0;
  if (count > 1) return { state: "several", count };
  if (count === 0 || !xoxd) return { state: "waiting" };
  if (p.teamId !== teamId) return { state: "wrong-workspace" };
  // Manukora is there but Slack has not finished setting up the session yet: keep waiting.
  if (typeof p.token !== "string" || !p.token) return { state: "waiting" };
  if (!/^xoxc-[A-Za-z0-9._-]{8,}$/.test(p.token) || !/^xoxd-[A-Za-z0-9%+/=._-]{20,}$/.test(xoxd)) return { state: "waiting" };
  return { state: "ok", xoxc: p.token, xoxd, teamId };
}

// The workspace and the person, both from Slack's own answer, checked against the pinned team.
export function checkIdentity(info: AuthInfo, domain = SLACK_DOMAIN, teamId = SLACK_TEAM_ID): string {
  if (!info.ok) return info.error === "invalid_auth" ? "Slack did not accept that session." : "Slack did not confirm the session.";
  let host = "";
  try {
    host = new URL(info.url).host;
  } catch {}
  if (host !== `${domain}.slack.com` || info.teamId !== teamId) return "That is not the Manukora Slack workspace. Sign in to Manukora's Slack instead.";
  if (!info.userId) return "Slack did not say which account this is. Nothing was saved.";
  return "";
}

// ---- Slack ----

export async function slackIdentity(xoxc: string, xoxd: string, send: typeof fetch = fetch): Promise<AuthInfo> {
  // The host is built only from the pinned, validated workspace name; redirects are refused.
  const response = await send(`https://${SLACK_DOMAIN}.slack.com/api/auth.test`, {
    method: "POST",
    headers: { Cookie: `d=${xoxd}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: xoxc }).toString(),
    redirect: "error",
    signal: (AbortSignal as unknown as { timeout(ms: number): AbortSignal }).timeout(20000),
  });
  const data = (await response.json()) as { ok?: unknown; team_id?: unknown; user_id?: unknown; user?: unknown; url?: unknown; error?: unknown };
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return { ok: data.ok === true, teamId: str(data.team_id), userId: str(data.user_id), user: str(data.user).slice(0, 80), url: str(data.url), error: str(data.error) };
}

// ---- DevTools over a private pipe (fd 3 in, fd 4 out, NUL-separated JSON) ----

export class PipeCdp {
  private buffer = Buffer.alloc(0);
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  closed = false;

  constructor(
    private readonly input: Writable,
    output: Readable,
  ) {
    output.on("data", (chunk: Buffer) => this.receive(chunk));
    output.on("error", () => this.close());
    output.on("close", () => this.close());
    input.on("error", () => this.close());
  }

  private receive(chunk: Buffer) {
    if (this.closed) return; // nothing is buffered after close
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_BUFFER) {
      this.close();
      return;
    }
    let end: number;
    while ((end = this.buffer.indexOf(0)) >= 0) {
      const raw = this.buffer.subarray(0, end).toString("utf8");
      this.buffer = this.buffer.subarray(end + 1);
      let message: { id?: unknown; result?: unknown; error?: unknown } | null;
      try {
        message = JSON.parse(raw) as typeof message;
      } catch {
        continue; // a malformed frame is dropped, never thrown out of the stream callback
      }
      if (!message || typeof message !== "object" || typeof message.id !== "number") continue;
      const waiting = this.pending.get(message.id);
      if (!waiting) continue;
      this.pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new Error("DevTools refused the request"));
      else waiting.resolve(message.result ?? {});
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.buffer = Buffer.alloc(0);
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error("DevTools closed"));
    }
    this.pending.clear();
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
    if (this.closed) return Promise.reject(new Error("DevTools closed"));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("DevTools did not answer"));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.input.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error("DevTools closed"));
      }
    });
  }
}

// ---- the throwaway browser ----

export function chromeCandidates(platform = process.platform, env = process.env, home = os.homedir()): string[] {
  if (platform === "win32") {
    const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter(Boolean) as string[];
    return [
      ...roots.map((r) => path.win32.join(r, "Google", "Chrome", "Application", "chrome.exe")),
      ...roots.map((r) => path.win32.join(r, "Microsoft", "Edge", "Application", "msedge.exe")),
    ];
  }
  const testing = path.join(home, ".cache", "chrome-for-testing", "chrome");
  const cft: string[] = [];
  try {
    for (const build of readdirSync(testing)) {
      for (const sub of readdirSync(path.join(testing, build))) {
        cft.push(path.join(testing, build, sub, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"));
      }
    }
  } catch {}
  return [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    path.join(home, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
    ...cft,
  ];
}

export function findChrome(exists: (p: string) => boolean = existsSync, candidates = chromeCandidates()): string {
  return candidates.find((p) => exists(p)) ?? "";
}

export interface Capture {
  cdp: PipeCdp;
  exited(): boolean;
  stop(): Promise<void>;
}

async function removeProfile(profile: string) {
  for (let i = 0; i < 20; i += 1) {
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
    if (!existsSync(profile)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// Whether a running process still uses this profile (then it is not abandoned). Windows has no cheap
// check, so there only the age decides.
function profileInUse(profile: string) {
  if (process.platform === "win32") return false;
  try {
    return execFileSync("ps", ["-axo", "command"], { encoding: "utf8", timeout: 5000 }).includes(profile);
  } catch {
    return true; // cannot tell: leave it
  }
}

// A capture that crashed or was killed can leave a signed-in profile behind: remove old ones first.
// Returns what was removed and what could not be (so the caller can say so).
export async function removeAbandonedProfiles(dir = os.tmpdir(), now = Date.now(), inUse = profileInUse) {
  let removed = 0;
  const stuck: string[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.startsWith(PROFILE_PREFIX)) continue;
    const full = path.join(dir, name);
    const info = await stat(full).catch(() => null);
    // Only this user's own sign-in folders, old enough, and with no browser still using them.
    const mine = typeof process.getuid !== "function" || info?.uid === process.getuid();
    if (!info?.isDirectory() || !mine || now - info.mtimeMs <= ABANDONED_MS || inUse(full)) continue;
    if (await removeProfile(full)) removed += 1;
    else stuck.push(full);
  }
  return { removed, stuck };
}

export async function launchCapture(): Promise<Capture> {
  const chrome = findChrome();
  if (!chrome) throw new Error("Connect Slack needs Google Chrome (or Microsoft Edge on Windows). Install it, then press Connect Slack again.");
  const { stuck } = await removeAbandonedProfiles();
  if (stuck.length) {
    throw new Error("An earlier Slack sign-in folder could not be removed. Restart the computer (that releases it), then press Connect Slack: AgentOS removes the folder then.");
  }
  const profile = await mkdtemp(path.join(os.tmpdir(), PROFILE_PREFIX));
  await chmod(profile, 0o700);
  const child: ChildProcess = spawn(
    chrome,
    [
      `--user-data-dir=${profile}`,
      "--remote-debugging-pipe",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--new-window",
      // Straight to Manukora's workspace sign-in (not Slack's workspace picker); Slack moves to
      // app.slack.com once signed in, which is the only page the plugin reads.
      `https://${SLACK_DOMAIN}.slack.com/`,
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: false },
  );
  child.on("error", () => undefined);
  const cdp = new PipeCdp(child.stdio[3] as Writable, child.stdio[4] as Readable);
  const exited = () => child.exitCode !== null || child.signalCode !== null || cdp.closed;
  const gone = () => child.exitCode !== null || child.signalCode !== null;
  const waitExit = async (ms: number) => {
    for (let waited = 0; waited < ms && !gone(); waited += 100) await new Promise((r) => setTimeout(r, 100));
  };
  const stop = async () => {
    await cdp.send("Browser.close", {}, undefined, 3000).catch(() => undefined);
    await waitExit(3000);
    if (!gone()) {
      child.kill();
      await waitExit(3000);
    }
    if (!gone()) {
      child.kill("SIGKILL");
      await waitExit(3000);
    }
    cdp.close();
    // Never delete under a browser that may still be running; the next launch cleans it up instead.
    if (!gone()) throw new Error("The Slack sign-in window did not close. Close it, then press Connect Slack again.");
    if (!(await removeProfile(profile))) throw new Error("The Slack sign-in window closed, but its temporary folder could not be removed. Restart the computer; the next Connect Slack removes it.");
  };
  try {
    await cdp.send("Browser.getVersion", {}, undefined, 30000);
  } catch {
    const cleaned = await stop().then(() => true, () => false);
    throw new Error(
      `Chrome did not start for the Slack sign-in. Press Connect Slack again.${cleaned ? "" : " Its temporary folder could not be removed; restart the computer to clear it."}`,
    );
  }
  return { cdp, exited, stop };
}

const PAGE_EXPRESSION = (teamId: string) => `(() => {
  const origin = location.origin;
  if (origin !== ${JSON.stringify(SLACK_ORIGIN)}) return { origin };
  try {
    const teams = Object.values((JSON.parse(localStorage.getItem("localConfig_v2") || "{}").teams) || {});
    const one = teams.find((t) => t && t.id === ${JSON.stringify(teamId)});
    return { origin, count: teams.length, token: one ? String(one.token || "") : "", teamId: one ? String(one.id) : "" };
  } catch (e) { return { origin, count: 0 }; }
})()`;

// One look at the window: is Slack signed in to Manukora (and only Manukora) yet?
export async function readSession(capture: Capture, seenPage: { value: boolean }): Promise<ReadResult> {
  if (capture.exited()) return { state: "closed" };
  const { targetInfos } = await capture.cdp.send<{ targetInfos?: { targetId?: string; type?: string; url?: string }[] }>("Target.getTargets");
  const pages = (targetInfos ?? []).filter((t) => t.type === "page");
  if (pages.length) seenPage.value = true;
  else return seenPage.value ? { state: "closed" } : { state: "waiting" };
  const target = pages.find((t) => {
    try {
      return new URL(String(t.url)).origin === SLACK_ORIGIN;
    } catch {
      return false;
    }
  });
  if (!target?.targetId) return { state: "waiting" };
  const { sessionId } = await capture.cdp.send<{ sessionId?: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  if (!sessionId) return { state: "waiting" };
  try {
    const tree = await capture.cdp.send<{ frameTree?: { frame?: { id?: string; url?: string } } }>("Page.getFrameTree", {}, sessionId);
    const frame = tree.frameTree?.frame;
    let frameOrigin = "";
    try {
      frameOrigin = new URL(String(frame?.url)).origin;
    } catch {}
    if (!frame?.id || frameOrigin !== SLACK_ORIGIN) return { state: "waiting" };
    // An isolated world: the page's own scripts cannot replace JSON, localStorage or Object here.
    const world = await capture.cdp.send<{ executionContextId?: number }>(
      "Page.createIsolatedWorld",
      { frameId: frame.id, worldName: "agentos-connect-slack", grantUniveralAccess: false },
      sessionId,
    );
    if (typeof world.executionContextId !== "number") return { state: "waiting" };
    const evaluated = await capture.cdp.send<{ result?: { value?: unknown } }>(
      "Runtime.evaluate",
      { expression: PAGE_EXPRESSION(SLACK_TEAM_ID), contextId: world.executionContextId, returnByValue: true },
      sessionId,
    );
    const value = evaluated.result?.value;
    // Everything but the cookie must already check out (one workspace, the pinned team, a token of the
    // right shape) before the cookie is even requested.
    const preview = interpret(value, PLACEHOLDER_D);
    if (preview.state !== "ok") return preview.state === "waiting" ? interpret(value, "") : preview;
    const cookies = await capture.cdp.send<{ cookies?: unknown }>("Network.getCookies", { urls: [SLACK_ORIGIN] }, sessionId);
    return interpret(value, pickCookie(cookies.cookies));
  } finally {
    await capture.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
  }
}

const PLACEHOLDER_D = `xoxd-${"0".repeat(20)}`;

// ---- the whole capture, with injectable parts for tests ----

export interface CaptureDeps {
  launch(): Promise<Capture>;
  read(capture: Capture, seenPage: { value: boolean }): Promise<ReadResult>;
  sleep(ms: number): Promise<void>;
  timeoutMs?: number;
}

export const realCaptureDeps: CaptureDeps = {
  launch: launchCapture,
  read: readSession,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export async function captureSlack(deps: CaptureDeps = realCaptureDeps, cancelled: () => boolean = () => false): Promise<{ xoxc: string; xoxd: string; teamId: string }> {
  const capture = await deps.launch();
  try {
    const deadline = Date.now() + (deps.timeoutMs ?? SIGN_IN_TIMEOUT_MS);
    const seenPage = { value: false };
    while (Date.now() < deadline) {
      if (cancelled()) throw new Error("Connect Slack was cancelled. Nothing was saved.");
      const result = await deps.read(capture, seenPage).catch((): ReadResult => (capture.exited() ? { state: "closed" } : { state: "waiting" }));
      if (result.state === "ok") return { xoxc: result.xoxc, xoxd: result.xoxd, teamId: result.teamId };
      if (result.state === "closed") throw new Error("The Slack window was closed before sign-in finished. Press Connect Slack to try again.");
      if (result.state === "several") {
        throw new Error(`That window is signed in to ${result.count} Slack workspaces. Use only Manukora's Slack there, then press Connect Slack again.`);
      }
      if (result.state === "wrong-workspace") throw new Error("That window is signed in to a different Slack workspace. Sign in to Manukora's Slack instead.");
      await deps.sleep(POLL_MS);
    }
    throw new Error("Slack sign-in timed out. Press Connect Slack to try again.");
  } finally {
    await capture.stop();
  }
}
