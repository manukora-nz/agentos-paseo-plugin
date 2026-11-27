import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { Step, StatusResult } from "../shared/contracts";
import { claudePlugins, coreConnectors, paseoPlugins, roleConnectors } from "../shared/recommended";
import {
  defaultFolder,
  defaultFolderIsForced,
  exists,
  expandHome,
  home,
  lastLines,
  loadState,
  paseoCli,
  repoRoot,
  redactReport,
  run,
  scrubValues,
  testMode,
  toolEnvironment,
  updateState,
  type State,
} from "./util";
import { CLAUDE_INSTALL_ARGS, CLAUDE_WINGET_ARGS, ensureClaudeOnUserPath, installWindowsTools, isWindows, quoteForPowerShell, resolveWindowsCommand, windowsPreflight, wingetSucceeded } from "./windows";
import { bundleFile, bundledRepo, sourceDir, stateDir } from "./util";
import { identityToken, signIn, signedInEmail } from "./google";
import { connect, downloadAfterSignIn, fileReport, loadService, refreshSource, teamKeys } from "./source";
import { captureSlack, checkIdentity, realCaptureDeps, setPinnedForTests, slackIdentity, SLACK_DOMAIN, type AuthInfo, type CaptureDeps } from "./slack-connect";
import { deleteSession, markDisconnected, readStoredSession, saveSession, storeName, type SlackSession } from "./slack-store";

// The Paseo SDK surface this plugin uses.
export interface Paseo {
  workspaces: { open(cwd: string): Promise<WorkspaceHandle> };
  agents: { ref(id: string): { refresh(): Promise<unknown> } };
}
interface WorkspaceHandle {
  id: string;
  agents: { create(options: Record<string, unknown>): Promise<{ id: string }> };
  terminals: { create(options: Record<string, unknown>): Promise<unknown> };
}

interface ActionResult {
  message: string;
  workspaceId?: string;
  agentId?: string;
}

const jobs = new Map<string, { running: boolean; error?: string; note?: string }>();
let connectorCache: { at: number; connected: string[]; missing: string[]; key: string } | null = null;
let statusCache: { at: number; value: StatusResult } | null = null;
let statusInFlight: { generation: number; refresh: boolean; promise: Promise<StatusResult> } | null = null;
let generation = 0;

function invalidateStatus() {
  generation += 1;
  statusCache = null;
}

const STATUS_TTL_MS = 20000;
const CONNECTOR_TTL_MS = 120000;
const CLAUDE_AGENT = { provider: "claude/claude-opus-5-5", modeId: "auto" };
const SLACK_CONNECT_TEXT =
  "Press Connect Slack: a separate Chrome window opens on Slack. Sign in there with your Manukora Slack account and this step finishes on its own; the window then closes and is deleted. " +
  "AgentOS keeps the sign-in on this computer only so it can create drafts in your Slack. It never sends.";

const ok = (value?: string) => (value ?? "").startsWith("ok");

const COMPUTER = isWindows ? "PC" : "Mac";

async function preflight(folder: string) {
  if (isWindows) return windowsPreflight(run, [expandHome(folder)]);
  const root = await repoRoot();
  const result = await run("sh", [path.join(root, "scripts/setup/preflight.sh"), folder], {
    cwd: root,
    timeoutMs: 60000,
  });
  const facts: Record<string, string> = {};
  for (const line of result.out.split("\n")) {
    const at = line.indexOf(":");
    if (at > 0 && !facts[line.slice(0, at)]) facts[line.slice(0, at)] = line.slice(at + 1).trim();
  }
  return facts;
}

interface ClaudeAccount {
  loggedIn?: boolean;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
}

async function claudeAccount(): Promise<ClaudeAccount> {
  const result = await run("claude", ["auth", "status"], { timeoutMs: 30000 });
  try {
    return JSON.parse(result.out) as ClaudeAccount;
  } catch {
    return {};
  }
}

export function isManukoraTeam(account: ClaudeAccount) {
  return (
    /@manukora\.com$/i.test(account.email ?? "") && /team|enterprise/i.test(account.subscriptionType ?? "")
  );
}

async function readIfThere(file: string) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

function intakePhaseDone(intake: string, phase: string) {
  return new RegExp(`^- Phase ${phase}\\b[^:]*:\\s*done`, "im").test(intake);
}

function addOnChosen(intake: string, name: RegExp) {
  const section = intake.split(/^## Add-ons chosen/im)[1]?.split(/^## /m)[0] ?? "";
  return name.test(section);
}

function rolePicks(intake: string) {
  return intake.split(/\*\*Role picks:\*\*/i)[1]?.split("\n")[0] ?? "";
}

function wantsN8n(intake: string) {
  return addOnChosen(intake, /n8n/i);
}

function codexLoggedIn(result: { code: number; out: string }) {
  return result.code === 0 && /logged in/i.test(result.out) && !/not logged in/i.test(result.out);
}

export function connectedInLine(line: string) {
  if (/needs auth|failed|not connected|disconnected/i.test(line)) return false;
  return /\bconnected\b/i.test(line);
}

// "claude.ai Cin7: https://... - ✔ Connected" -> "Cin7". Empty for anything that is not an account connector.
export function connectorName(line: string) {
  return /^claude\.ai (.+?):\s/.exec(line.trim())?.[1]?.trim() ?? "";
}

// The same connector: the exact name, or the name with a qualifier in brackets ("Gmail (Manukora)").
export function connectorNameMatches(actual: string, wanted: string) {
  const a = actual.toLowerCase();
  const w = wanted.toLowerCase();
  return a === w || a.startsWith(`${w} (`);
}

type PaseoPluginInventory = Map<string, { enabled: boolean; status: string }>;

// The installed Paseo plugins, or null when Paseo could not be asked. A failed or timed-out list
// must never read as "nothing installed": that would start installs during a status read.
export function parsePaseoPlugins(result: { code: number; out: string }): PaseoPluginInventory | null {
  if (result.code !== 0) return null;
  const start = result.out.indexOf("[");
  if (start < 0) return null;
  try {
    const list = JSON.parse(result.out.slice(start)) as unknown;
    if (!Array.isArray(list)) return null;
    const inventory: PaseoPluginInventory = new Map();
    for (const item of list as Array<{ id?: unknown; enabled?: unknown; status?: unknown }>) {
      if (typeof item?.id !== "string") return null;
      inventory.set(item.id, { enabled: item.enabled !== false, status: String(item.status ?? "") });
    }
    return inventory;
  } catch {
    return null;
  }
}

async function paseoPluginInventory() {
  return parsePaseoPlugins(await run(paseoCli(), ["plugin", "ls", "--json"], { timeoutMs: 30000 }));
}

export function pluginState(inventory: PaseoPluginInventory, id: string): "running" | "disabled" | "failed" | "absent" {
  const plugin = inventory.get(id);
  if (!plugin) return "absent";
  if (!plugin.enabled || plugin.status === "disabled") return "disabled";
  return plugin.status === "running" ? "running" : "failed";
}

async function connectors(folder: string, intake: string, refresh: boolean) {
  const picks = rolePicks(intake);
  // Without a Grain seat there is nothing to connect, so Grain is not asked for.
  const noGrain = /meeting_provider:\s*none/i.test(intake);
  const wanted = [
    ...coreConnectors.filter((name) => !(noGrain && name === "Grain")),
    ...roleConnectors.filter((name) => new RegExp(name, "i").test(picks)),
  ];
  const key = wanted.join(",");
  const known = connectorCache && connectorCache.key === key ? connectorCache : null;
  if (known && !refresh && Date.now() - known.at < CONNECTOR_TTL_MS) return { ...known, wanted, checking: false };
  // `claude mcp list` probes every connector on the account; with many organisation connectors it
  // takes 30 seconds or more, longer than Paseo waits for this screen. Run it in the background and
  // show the last result (or "checking") meanwhile.
  if (!connectorRun) {
    connectorRun = run("claude", ["mcp", "list"], { cwd: folder, timeoutMs: 120000 })
      .then((result) => {
        const connected: string[] = [];
        const missing: string[] = [];
        for (const name of wanted) {
          // Exact connector name, so an organisation connector whose name merely contains "Cin7" can no
          // longer stand in for Cin7. Any matching line that is connected counts.
          const lines = result.out.split("\n").filter((l) => connectorNameMatches(connectorName(l), name));
          if (lines.some((l) => connectedInLine(l))) connected.push(name);
          else missing.push(name);
        }
        connectorCache = { at: Date.now(), connected, missing, key };
        // Every connected account connector (names only), for the shared-skill readiness check.
        const all = result.out.split("\n")
          .filter((l) => connectedInLine(l))
          .map(connectorName)
          .filter(Boolean);
        if (result.code === 0) void writeConnectorStatus(all);
      })
      .finally(() => {
        connectorRun = null;
        invalidateStatus();
      });
  }
  if (testMode) await connectorRun;
  const now = connectorCache && connectorCache.key === key ? connectorCache : null;
  if (now) return { ...now, wanted, checking: Boolean(connectorRun) && !testMode };
  return { at: 0, connected: [] as string[], missing: [] as string[], key, wanted, checking: true };
}
let connectorRun: Promise<void> | null = null;

async function writeConnectorStatus(connected: string[]) {
  try {
    const file = path.join(stateDir(), "connector-status.json");
    const tmp = `${file}.${process.pid}.tmp`;
    await mkdir(stateDir(), { recursive: true });
    // Tied to the signed-in account, so another account's result is never read as this one's.
    const account = await signedInEmail();
    await writeFile(tmp, `${JSON.stringify({ checkedAt: new Date().toISOString(), account, connected }, null, 2)}\n`);
    await rename(tmp, file);
  } catch {
    // Readiness checks then say "not checked yet"; nothing else depends on this file.
  }
}

async function keyIsSet(folder: string, key: string) {
  const text = await readIfThere(path.join(folder, ".env"));
  return new RegExp(`^${key}=\\S+`, "m").test(text);
}

function startJob(id: string, work: () => Promise<string | void>) {
  if (jobs.get(id)?.running) return;
  jobs.set(id, { running: true });
  invalidateStatus();
  void work()
    .then((note) => jobs.set(id, { running: false, note: note ?? undefined }))
    .catch((error: Error) => jobs.set(id, { running: false, error: error.message }))
    .finally(() => invalidateStatus());
}

function applyJob(step: Step): Step {
  const current = jobs.get(step.id);
  if (current?.running) {
    const hint = isWindows && (step.id === "tools" || step.id === "claude-install" || step.id === "devtools")
      ? " Windows asks for permission for each install: look for a flashing shield icon in the taskbar at the bottom of the screen, click it and choose Yes. Installs can take 5 to 10 minutes."
      : "";
    if (step.id === "slack-drafts") {
      return { ...step, status: "working", detail: "Waiting for you to sign in to Manukora's Slack in the Chrome window that opened. This finishes on its own; the window then closes." };
    }
    return { ...step, status: "working", detail: `Working on it...${hint}` };
  }
  // A failed Slack attempt never hides the card's real state (connected, signed out): say what went wrong.
  if (current?.error && step.id === "slack-drafts") return { ...step, detail: `${step.detail} Last attempt: ${current.error}` };
  if (current?.note && step.id === "slack-drafts") return { ...step, detail: `${step.detail} ${current.note}` };
  if (current?.error && step.status !== "done") return { ...step, status: "failed", detail: current.error };
  if (current?.note && step.status !== "done") return { ...step, detail: `${step.detail} ${current.note}` };
  return step;
}

let lastShown: StatusResult | null = null;
const STATUS_BUDGET_MS = 20000;
export const STILL_CHECKING_ID = "still-checking";
async function stillChecking(): Promise<StatusResult> {
  const state = await loadState().catch(() => ({ folder: undefined, workspaceId: undefined }) as Awaited<ReturnType<typeof loadState>>);
  return {
    steps: [
      {
        id: STILL_CHECKING_ID,
        group: "Checking",
        title: "Still checking your computer",
        detail: "This first check can take up to a minute. The list appears here on its own.",
        status: "working",
        skippable: false,
        repeatable: false,
        inputs: [],
      },
    ],
    folder: state.folder ?? defaultFolder(),
    workspaceId: state.workspaceId,
    restartNeeded: false,
  };
}


// Restart guidance (2.3.1). A change that Paseo picks up only after a full quit records its step here.
export const RESTART_NAMES: Record<string, string> = {
  plugins: "the AgentOS plugins",
  "claude-install": "Claude Code",
  "claude-signin": "your Claude sign-in",
  tools: "the new tools",
  voice: "voice",
  onboard: "your onboarding",
  "shared-keys": "your team keys",
  "slack-drafts": "Slack drafts",
  "slack-disconnect": "Slack drafts",
  "role-tools": "your role tools",
  codex: "Codex",
};
// Later steps depend on these, so the page says "restart now" rather than "at the end".
const RESTART_NOW = new Set(["claude-install", "claude-signin", "tools"]);
const PICKED_UP_SHOWN_MS = 10 * 60 * 1000;

export function restartName(id: string) {
  return RESTART_NAMES[id] ?? "the last change";
}

export function markRestartFor(state: State, stepId: string) {
  // A new Paseo process since the last mark means that restart already happened: start a new list.
  if (state.restartDaemon !== process.ppid) state.restartFor = [];
  state.restartDaemon = process.ppid;
  state.restartFor = [...new Set([...(state.restartFor ?? []), stepId])];
}

// Moves a finished restart's list to "picked up". Works on the state inside the write: a restart marked
// for this Paseo since the caller looked is left alone.
export function settleRestart(s: State, now = Date.now()) {
  if (!s.restartDaemon || s.restartDaemon === process.ppid) return;
  const done = s.restartFor ?? [];
  if (done.length) s.restartPickedUp = { steps: done, at: now };
  delete s.restartDaemon;
  delete s.restartFor;
}

export interface RestartView {
  needed: boolean;
  steps: string[];
  names: string[];
  now: boolean;
  pickedUp: string[];
}

// Reads (and, after a restart, settles) the restart record. actionable: steps the person can still work
// on; with none left, the restart is the last thing to do, so it is "now".
export async function restartView(actionable?: number): Promise<RestartView> {
  let state = await loadState();
  if (state.restartDaemon && state.restartDaemon !== process.ppid) {
    // Settle from the state inside the write, never from the snapshot above: a step may have marked a
    // new restart for this Paseo in between, and that one must survive.
    state = await updateState(settleRestart);
  }
  const needed = Boolean(state.restartDaemon && state.restartDaemon === process.ppid);
  const steps = needed ? state.restartFor ?? [] : [];
  const picked = state.restartPickedUp && Date.now() - state.restartPickedUp.at < PICKED_UP_SHOWN_MS ? state.restartPickedUp.steps : [];
  return {
    needed,
    steps,
    names: steps.map(restartName),
    now: needed && (steps.length === 0 || steps.some((id) => RESTART_NOW.has(id)) || actionable === 0),
    pickedUp: picked.map(restartName),
  };
}


export async function status(refresh: boolean, budgetMs = STATUS_BUDGET_MS): Promise<StatusResult> {
  const full = statusNow(refresh).then((value) => (lastShown = value));
  if (testMode && budgetMs === STATUS_BUDGET_MS) return full;
  // Paseo gives up on a slow plugin call. Answer within the budget: with the last result, or on the
  // first load a "still checking" placeholder. The check carries on and the next poll shows it.
  const previous = lastShown;
  return Promise.race([
    full,
    new Promise<StatusResult>((resolve) => setTimeout(() => resolve(previous ?? stillChecking()), budgetMs).unref?.()),
  ]);
}

async function statusNow(refresh: boolean): Promise<StatusResult> {
  if (statusInFlight && statusInFlight.generation === generation && (statusInFlight.refresh || !refresh)) {
    return statusInFlight.promise;
  }
  if (!refresh && statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.value;
  const startedGeneration = generation;
  const promise: Promise<StatusResult> = computeStatus(refresh)
    .then((value): StatusResult => {
      // A button press during this check does not restart it (restarting made presses wait behind
      // repeated slow checks). Show this result now; it is not cached, so the next poll re-checks.
      if (startedGeneration === generation) statusCache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      if (statusInFlight?.promise === promise) statusInFlight = null;
    });
  statusInFlight = { generation: startedGeneration, refresh, promise };
  return promise;
}

async function agentosBehind(folder: string) {
  const root = await repoRoot();
  const revision = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).out.split("\n")[0]?.trim();
  if (!revision) return false;
  const known = await run("git", ["-C", folder, "cat-file", "-e", `${revision}^{commit}`]);
  if (known.code !== 0) return true;
  return (await run("git", ["-C", folder, "merge-base", "--is-ancestor", revision, "HEAD"])).code !== 0;
}

const SERVICE_URL = process.env.AGENTOS_SERVICE_URL || "https://agentos.manukora.com";
const WHERE_TO_START_GUIDE = "https://app.notion.com/p/41a188a620a381aa9e72ea1bf1122927";

const KEY_LABELS: Record<string, string> = {
  TRANSCRIPTION_API_KEY: "transcription",
  DATADOE_MCP_KEY: "Amazon (DataDoe)",
  XERO_MNK_CLIENT_ID: "Xero NZ",
  XERO_MNK_CLIENT_SECRET: "",
  XERO_ORA_CLIENT_ID: "Xero US",
  XERO_ORA_CLIENT_SECRET: "",
  N8N_API_KEY: "n8n",
  NOTION_TOKEN: "full-workspace Notion",
  N8N_API_URL: "",
  XERO_SCOPES: "",
};
function keysInFromService(names: string[]) {
  return names.includes("TRANSCRIPTION_API_KEY");
}

function friendlyKey(name: string) {
  return KEY_LABELS[name] ?? name;
}

// A Monday-morning suggestion at a minute that differs per person, so the whole team does not
// update in the same minute.
function suggestedTuneUp(seed: string) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `${5 + (h % 50)} ${9 + ((h >> 8) % 2)} * * 1`;
}

// The setup screen asks for a day and a clock time, never cron. These turn the saved cron into
// what a person reads ("Monday", "9:24 AM") and back.
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_WORDS: Record<string, string> = { "every day": "*", daily: "*", everyday: "*", weekdays: "1-5" };
const own = (record: Record<string, string>, key: string) => (Object.hasOwn(record, key) ? record[key] : undefined);

export function cronToDayTime(cron: string): { day: string; time: string } | undefined {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour) || dayOfMonth !== "*" || month !== "*") return undefined;
  const h = Number(hour);
  const m = Number(minute);
  if (h > 23 || m > 59) return undefined;
  let day: string;
  if (dayOfWeek === "*") day = "Every day";
  else if (dayOfWeek === "1-5") day = "Weekdays";
  // One day or a list of days ("1,3" is "Monday, Wednesday"), so a custom choice is shown as set.
  else if (/^[0-7](,[0-7])*$/.test(dayOfWeek)) day = [...new Set(dayOfWeek.split(",").map((d) => Number(d) % 7))].map((d) => WEEKDAYS[d]).join(", ");
  else return undefined;
  const time = `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  return { day, time };
}

export function dayTimeToCron(dayText: string, timeText: string): string {
  const dayKey = dayText.trim().toLowerCase().replace(/\s+/g, " ");
  // Own keys only: "constructor" or "toString" must not read as a day.
  let dayOfWeek = own(DAY_WORDS, dayKey);
  if (!dayOfWeek) {
    // Day names or any start of one with at least three letters, one or several:
    // "Mon", "Tues", "Thursday", "Mon, Wed", "Tuesday and Friday".
    const indexes = dayKey.split(/\s*(?:,|&|\band\b)\s*/).filter(Boolean).map((word) =>
      word.length >= 3 ? WEEKDAYS.findIndex((d) => d.toLowerCase().startsWith(word)) : -1,
    );
    if (!indexes.length || indexes.some((i) => i < 0)) throw new Error("Enter a day like Monday, Mon and Thu, Weekdays or Every day.");
    dayOfWeek = [...new Set(indexes)].sort((a, b) => a - b).join(",");
  }
  const t = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/i.exec(timeText.trim().replace(/\s+/g, " "));
  if (!t) throw new Error("Enter a time like 9:30 AM or 14:30.");
  let hour = Number(t[1]);
  const minute = Number(t[2] ?? "0");
  const meridiem = t[3]?.toLowerCase().replace(/\./g, "");
  if (meridiem) {
    if (hour < 1 || hour > 12) throw new Error("Enter a time like 9:30 AM or 14:30.");
    hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) throw new Error("Enter a time like 9:30 AM or 14:30.");
  return `${minute} ${hour} * * ${dayOfWeek}`;
}

const TUNE_UP_NAME = "AgentOS tune-up";

// The live tune-up schedule, null when there is none, or undefined when Paseo could not be asked
// (a failed list must never lead to a second schedule).
export function findTuneUp(result: { code: number; out: string }): { id: string; cron: string; timezone: string } | null | undefined {
  if (result.code !== 0) return undefined;
  const start = result.out.indexOf("[");
  if (start < 0) return undefined;
  try {
    const list = JSON.parse(result.out.slice(start)) as Array<{ id?: string; name?: string; cadence?: string; status?: string }>;
    if (!Array.isArray(list)) return undefined;
    const found = list.find((item) => item?.name === TUNE_UP_NAME && item.status !== "completed");
    if (!found?.id) return null;
    const cadence = /^cron:(.+?)\s*(?:\(([^)]+)\))?\s*$/.exec(found.cadence ?? "");
    return { id: found.id, cron: cadence?.[1]?.trim() ?? "", timezone: cadence?.[2]?.trim() ?? "" };
  } catch {
    return undefined;
  }
}

async function liveTuneUp() {
  return findTuneUp(await run(paseoCli(), ["schedule", "ls", "--json"], { timeoutMs: 30000 }));
}

async function mtimeOf(file: string) {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return 0;
  }
}

// On a new Mac /usr/bin/git is only a stub until Apple's developer tools are installed. Ask
// xcode-select, which (unlike the stub) never pops up an install window by itself.
async function appleDeveloperTools() {
  if (testMode && process.env.AGENTOS_TEST_NO_DEVTOOLS === "1") return false;
  // On Windows the download only needs Git.
  if (isWindows) return (await run("git", ["--version"], { timeoutMs: 15000 })).code === 0;
  return (await run("/usr/bin/xcode-select", ["-p"], { timeoutMs: 15000 })).code === 0;
}

function connectStep(done: boolean, detail: string): Step {
  return applyJob({
    id: "connect",
    group: "Manukora",
    title: "Connect to Manukora",
    detail,
    status: done ? "done" : "todo",
    actionLabel: "Connect",
    skippable: false,
    repeatable: false,
    inputs: done
      ? []
      : [
          { key: "url", label: "Service address", secret: false, value: SERVICE_URL },
          { key: "key", label: "Access key (only if AI & Systems gave you one)", secret: true, value: "" },
        ],
  });
}

function googleStep(email: string, required: boolean): Step {
  return applyJob({
    id: "google",
    group: "Manukora",
    title: "Sign in with your Manukora Google account",
    detail: email
      ? `Signed in as ${email}.`
      : required
        ? "Manukora asks each person to sign in, so access can be managed one person at a time. A Google page opens in your browser."
        : "Optional. Lets AI & Systems see reports under your name.",
    status: email ? "done" : "todo",
    actionLabel: email ? "Sign in again" : "Sign in",
    skippable: !required,
    repeatable: Boolean(email),
    inputs: [],
  });
}

async function computeStatus(refresh: boolean): Promise<StatusResult> {
  const state = await loadState();
  const bundled = await bundledRepo();
  // Refresh first, so a service that just switched sign-in on is seen on this pass.
  if (!bundled) await refreshSource(refresh);
  const service = bundled ? null : await loadService();
  const sourceReady = await exists(path.join(sourceDir(), "scripts/setup/preflight.sh"));
  const googleEmail = service?.identity && (await identityToken(service.identity.clientId)) ? await signedInEmail() : "";
  if (service?.identity?.required && !sourceReady) {
    return {
      steps: [
        connectStep(true, service.key ? "Your access key was accepted." : "Connected to Manukora."),
        googleStep(googleEmail, true),
        ...(googleEmail
          ? [
              applyJob({
                id: "download",
                group: "Manukora",
                title: "Download AgentOS",
                detail: "The download has not finished yet.",
                status: "todo",
                actionLabel: "Download",
                skippable: false,
                repeatable: false,
                inputs: [],
              }),
            ]
          : []),
      ],
      folder: state.folder ?? defaultFolder(),
      workspaceId: state.workspaceId,
      restartNeeded: false,
    };
  }
  if (!bundled && !(service && (await exists(path.join(sourceDir(), "scripts/setup/preflight.sh"))))) {
    // Connecting downloads AgentOS with Git, so a new Mac needs Apple's developer tools first.
    const devTools = await appleDeveloperTools();
    return {
      steps: [
        ...(devTools
          ? []
          : [
              applyJob({
                id: "devtools",
                group: "Manukora",
                title: isWindows ? "Install Git" : "Install Apple developer tools",
                detail: isWindows
                  ? "AgentOS needs Git to download. This takes a minute or two; Windows may ask for permission."
                  : "AgentOS needs these to download. macOS shows an install window; it takes a few minutes.",
                status: "todo",
                actionLabel: "Install",
                skippable: false,
                repeatable: false,
                inputs: [],
              }),
            ]),
        connectStep(
          false,
          devTools
            ? "Press Connect, then sign in with your Manukora Google account. This downloads AgentOS and keeps it up to date."
            : `After ${isWindows ? "Git is installed" : "the developer tools"}, press Connect and sign in with your Manukora Google account.`,
        ),
      ],
      folder: state.folder ?? defaultFolder(),
      workspaceId: state.workspaceId,
      restartNeeded: false,
    };
  }
  let facts = await preflight(state.folder ?? defaultFolder());
  let folder = state.folder ?? defaultFolder();
  const found = facts["existing-agentos"];
  const adopted = !state.folder && !defaultFolderIsForced() && found && found !== "none";
  if (adopted) {
    folder = found;
    facts = await preflight(folder);
  }
  const hasFolder = await exists(path.join(folder, "AGENTS.md"));
  const intake = hasFolder ? await readIfThere(path.join(folder, "aios-intake.md")) : "";
  const steps: Step[] = [
    connectStep(true, bundled ? "Using the AgentOS copy that came with the plugin." : "Connected. AgentOS updates arrive from Manukora automatically."),
    ...(service?.identity ? [googleStep(googleEmail, service.identity.required)] : []),
  ];
  const add = (
    step: Omit<Step, "skippable" | "inputs" | "repeatable"> & Partial<Pick<Step, "skippable" | "inputs" | "repeatable">>,
  ) => steps.push(applyJob({ skippable: false, inputs: [], repeatable: false, ...step }));

  const missingTools = ["git", "node", "powershell", "python"].filter((tool) => !ok(facts[tool]));
  const devTools = ok(facts["developer-tools"]);
  add({
    id: "tools",
    group: `Your ${COMPUTER}`,
    title: "Install the tools AgentOS needs",
    detail:
      missingTools.length || !devTools
        ? `Missing: ${[...(devTools ? [] : ["Apple developer tools"]), ...missingTools].join(", ")}.`
        : "Git, Node, PowerShell and Python are ready.",
    status: missingTools.length || !devTools ? "todo" : "done",
    actionLabel: "Install them",
  });

  const claudeInstalled = ok(facts["claude-code"]);
  add({
    id: "claude-install",
    group: `Your ${COMPUTER}`,
    title: "Install Claude Code",
    detail: claudeInstalled
      ? `Installed (${facts["claude-code"].replace("ok ", "")}).`
      : "Paseo runs Claude through Claude Code, which is separate from the Claude app.",
    status: claudeInstalled ? "done" : missingTools.length ? "waiting" : "todo",
    actionLabel: "Install Claude Code",
  });

  const folderReady = hasFolder && Boolean(state.workspaceId);
  add({
    id: "folder",
    group: "AgentOS",
    title: "Create your AgentOS folder",
    detail: folderReady
      ? `Ready at ${folder}.`
      : hasFolder
        ? `Found your AgentOS at ${folder}. It will be kept as it is. Change the folder if this is the wrong one.`
        : "New to AgentOS? Leave the folder as it is, add your name and work email, and press Create it. Already using AgentOS on this computer? Put its folder in the first box instead: everything in it is kept (your answers, context, memory and projects), nothing is overwritten, and onboarding only asks what is new.",
    status: folderReady ? "done" : missingTools.length ? "waiting" : "todo",
    actionLabel: hasFolder ? "Use this folder" : "Create it",
    inputs: folderReady
      ? []
      : [
          { key: "folder", label: "Folder", secret: false, value: folder },
          { key: "name", label: hasFolder ? "Your full name (only for a new folder)" : "Your full name (first and last)", secret: false, value: "" },
          { key: "email", label: hasFolder ? "Your work email (only for a new folder)" : "Your work email", secret: false, value: "" },
        ],
  });

  const account = claudeInstalled ? await claudeAccount() : {};
  const signedIn = account.loggedIn === true;
  const onTeam = isManukoraTeam(account);
  add({
    id: "claude-signin",
    group: "AgentOS",
    title: "Sign in to Claude",
    detail: !claudeInstalled || !folderReady
      ? `Waiting for ${[...(!claudeInstalled ? ["Install Claude Code"] : []), ...(!folderReady ? ["Create your AgentOS folder"] : [])].join(" and ")} above.`
      : !signedIn
      ? "Opens a sign-in terminal. Choose your Manukora account in the browser, and if it shows a code, paste it into the terminal and press Enter (the code does not show while you paste)."
      : onTeam
        ? `Signed in as ${account.email}. If a chat ever says your Claude session expired or could not be refreshed, press Sign in again and choose your Manukora account.`
        : `Signed in as ${account.email ?? "an account"}, which is not the Manukora Team plan. Your connectors would read the wrong account. Switch accounts, or skip only if you know this is right.`,
    status: signedIn && onTeam ? "done" : !claudeInstalled || !folderReady ? "waiting" : "needs-you",
    // The local sign-in check cannot tell when Claude has ended the session on its side (chats then
    // fail with "OAuth session expired"), so a signed-in card always offers Sign in again.
    actionLabel: signedIn ? "Sign in again" : "Open sign-in",
    repeatable: signedIn && claudeInstalled && folderReady,
    skippable: signedIn,
  });

  const accountAccepted = signedIn && (onTeam || state.skipped.includes("claude-signin"));
  // These steps run in a Claude chat: while Paseo still needs a restart to pick up Claude, wait for it.
  const claudeRestartPending =
    state.restartDaemon === process.ppid && (state.restartFor ?? []).some((id) => id === "claude-signin" || id === "claude-install");
  const claudeChecking = !claudeRestartPending && (claudeCheckPending(state) || (signedIn && onTeam && signInHandedOff(state)));
  const canStart = folderReady && accountAccepted && !claudeRestartPending && !claudeChecking;
  const afterRestart = claudeRestartPending
    ? " Restart Paseo first, so it picks up Claude."
    : claudeChecking
      ? ` ${CLAUDE_CHECKING_TEXT}`
      : "";
  const behind = folderReady && (await agentosBehind(folder));
  add({
    id: "agentos-update",
    group: "AgentOS",
    title: "Bring AgentOS up to date",
    detail: !folderReady
      ? "Checked once your folder is ready."
      : behind
        ? `A newer AgentOS is available from AI & Systems.${afterRestart}`
        : "You have the latest AgentOS.",
    status: !folderReady ? "waiting" : !behind ? "done" : canStart ? "todo" : "waiting",
    actionLabel: "Update",
  });

  const scaffolded = intakePhaseDone(intake, "A");
  add({
    id: "onboard",
    group: "Onboarding",
    title: "Tell AgentOS about you",
    detail: scaffolded
      ? "Your context is written."
      : `A short interview about your role, priorities and tools. Takes about 15 minutes.${afterRestart}`,
    status: scaffolded ? "done" : canStart ? "todo" : "waiting",
    actionLabel: state.onboardAgentId ? "Go back to it" : "Start",
  });

  add({
    id: "theme",
    group: "Your interface",
    title: "Switch to the Manukora look",
    detail: "Open Settings, then Appearance, and choose Manukora or Manukora Dark.",
    status: state.confirmed.includes("theme") ? "done" : "needs-you",
    actionLabel: "Done",
    skippable: true,
  });

  // The AgentOS Paseo plugins (Usage remaining, Awaiting you, Skills library, Keep awake) are for
  // everyone, so they do not wait for onboarding and are installed automatically as soon as the
  // folder is current. Claude plugins depend on the role, so they still wait for onboarding.
  const claudeList = claudeInstalled && scaffolded ? (await run("claude", ["plugin", "list"], { timeoutMs: 30000 })).out : "";
  const paseoReady = paseoPlugins.length > 0 && folderReady && !behind;
  const inventory = paseoReady ? await paseoPluginInventory() : null;
  const wanted = scaffolded ? claudePlugins.filter((p) => p.when !== "n8n" || wantsN8n(intake)) : [];
  const absentPaseo = inventory ? paseoPlugins.filter((p) => pluginState(inventory, p.id) !== "running") : [];
  const absent = [
    ...wanted.filter((p) => !claudeList.includes(p.id)).map((p) => p.title),
    ...absentPaseo.map((p) => p.title),
  ];
  // The Paseo plugins install on their own, once per Paseo session, and only from a successful
  // inventory (a failed or slow "paseo plugin ls" must not look like "nothing installed"). Claude
  // role plugins stay on the button: they need onboarding's choices. A failure shows on the step
  // and the button retries; it never loops.
  if (absentPaseo.length && !jobs.has("plugins")) startJob("plugins", () => installPlugins(folder, false));
  add({
    id: "plugins",
    group: "Your interface",
    title: "Add the AgentOS plugins",
    detail: !folderReady || behind
      ? "Added automatically once AgentOS is up to date."
      : paseoReady && !inventory
        ? "Could not check your Paseo plugins just now. Press Add them to try again."
        : absent.length
        ? `Required. Adding: ${absent.join(", ")}. Then quit and reopen Paseo.`
        : scaffolded
          ? "All added."
          : "AgentOS plugins added. Role plugins are added after onboarding.",
    status: !folderReady || behind ? "waiting" : absent.length || (paseoReady && !inventory) ? "todo" : "done",
    actionLabel: "Add them",
  });

  const live = scaffolded && Boolean(state.workspaceId);
  const conn = live ? await connectors(folder, intake, refresh) : null;
  add({
    id: "connectors",
    group: "Full capability",
    title: "Connect your accounts",
    detail: !conn
      ? "Notion, Slack, Gmail, Calendar, Drive, Grain and the tools for your role."
      : conn.checking && !conn.at
        ? "Checking your connected accounts in the background. With many connectors this takes up to a minute; the screen updates by itself."
      : conn.missing.length
        ? `Connected: ${conn.connected.length} of ${conn.wanted.length}. Still to do: ${conn.missing.join(", ")}. Turn each on at claude.ai, Settings, Customize, Connectors. Then in the terminal choose Yes if asked, type /mcp, sign in to each and type /exit. Press Check again when you are done. Not using one of these (for example Slack)? Press Skip for now: the rest of setup carries on, and this step turns Done by itself once everything is connected.`
        : "All your accounts are connected.",
    status: !conn ? "waiting" : conn.checking && !conn.at ? "working" : conn.missing.length ? "needs-you" : "done",
    actionLabel: "Open sign-in terminal",
    link: "https://claude.ai/new#customize/connectors",
    skippable: true,
    repeatable: Boolean(conn),
  });

  // With Manukora's service, the team's keys arrive with the person's sign-in: no 1Password token.
  const team = service?.identity && googleEmail ? await teamKeys(false, refresh) : null;
  const teamNames = team ? Object.keys(team.keys) : [];
  const viaService = Boolean(service?.identity);
  const opReady = !viaService && ok(facts["1password-cli"]);
  const tokenStored =
    opReady && live
      ? /Stored for your tools:\s*yes/i.test(
          (await run("pwsh", ["-NoProfile", "-File", "scripts/op-service-account.ps1", "-Status"], { cwd: folder, timeoutMs: 30000 })).out,
        )
      : false;
  const connectedLabels = [...new Set(teamNames.map(friendlyKey).filter(Boolean))];
  const missingLabels = [...new Set((team?.unavailable ?? []).map(friendlyKey).filter(Boolean))];
  if (viaService) {
    add({
      id: "team-keys",
      group: "Full capability",
      title: "Your team's keys",
      detail: !team
        ? "Checked once you are signed in."
        : !team.configured
          ? "Manukora's service is not handing out keys yet. AI & Systems is setting it up; nothing for you to do."
          : connectedLabels.length
            ? `Connected by Manukora: ${connectedLabels.join(", ")}. Nothing to paste; they reach AgentOS each time it starts.${missingLabels.length ? ` Not available yet: ${missingLabels.join(", ")}.` : ""}`
            : missingLabels.length
              ? `Not available yet: ${missingLabels.join(", ")}. Usually temporary; tell AI & Systems if it lasts a day.`
              : "No keys arrived for your account. Ask AI & Systems.",
      status: keysInFromService(teamNames) ? "done" : "waiting",
      skippable: false,
    });
  }
  if (!viaService) add({
    id: "onepassword",
    group: "Full capability",
    title: "Set up 1Password",
    detail: tokenStored
      ? "Your token is stored, so tools can read the vault without prompting."
      : opReady
        ? "The 1Password CLI is installed. Copy your team's AgentOS token from 1Password (AI & Systems gives your team access) and store it here, so tools read the vault without asking each time."
        : "Install the 1Password CLI, then come back. Needed for transcription and role tools.",
    status: tokenStored ? "done" : live ? "needs-you" : "waiting",
    actionLabel: opReady ? "Store my token" : "Download it",
    link: opReady ? undefined : "https://1password.com/downloads/command-line",
    skippable: true,
  });

  // A key the person already has in .env (an older 1Password setup) counts too.
  const keysIn =
    (viaService && teamNames.includes("TRANSCRIPTION_API_KEY")) || (hasFolder && (await keyIsSet(folder, "TRANSCRIPTION_API_KEY")));
  const keysSkipped = state.skipped.includes("shared-keys");
  if (!viaService) add({
    id: "shared-keys",
    group: "Full capability",
    title: "Bring in the shared keys",
    detail: state.keysOutstanding
      ? `Some keys could not be connected: ${state.keysOutstanding} Ask AI & Systems for access, then try again.`
      : keysIn
        ? "Shared keys are referenced from 1Password. No values are stored in your files."
        : "Connects transcription and your role's tools to the company vault.",
    // Waits for a stored token, not just an installed CLI, so it cannot run without one.
    status: state.keysOutstanding ? "needs-you" : keysIn ? "done" : !live || !opReady || !tokenStored ? "waiting" : "todo",
    actionLabel: "Connect them",
    skippable: true,
  });

  const ffmpegOk = (await run("ffmpeg", ["-version"], { timeoutMs: 15000 })).code === 0;
  add({
    id: "voice",
    group: "Full capability",
    title: "Voice memos and Looms",
    detail: !keysIn
      ? keysSkipped
        ? "Bring back the shared keys step to turn this on."
        : viaService
          ? "Turns on once your team's keys arrive from Manukora."
          : "Turns on once the shared keys are in."
      : ffmpegOk
        ? "Set up. Your first real voice memo or Loom is the test."
        : "Loom screenshots need ffmpeg. Voice memos do not. Press Install ffmpeg (no Terminal, no Homebrew; a few minutes), or skip it if you do not use Looms.",
    status: keysSkipped && !keysIn ? "skipped" : keysIn ? (ffmpegOk ? "done" : "needs-you") : "waiting",
    actionLabel: keysIn && !ffmpegOk ? "Install ffmpeg" : undefined,
    skippable: keysIn && !ffmpegOk,
  });

  const slackRead = hasFolder ? await readStoredSession() : ({ state: "missing" } as const);
  const slackSession = slackRead.state === "ok" ? slackRead.session : null;
  // "The older way" only before the first Connect: after a Disconnect a kept copy is not a connection.
  const slackLegacy = slackRead.state === "missing" && hasFolder && (await legacySlackPair(folder)) !== null;
  // A Disconnect whose settings change did not finish: drafts already refuse, but keep it retryable.
  const disconnectUnfinished = slackRead.state === "disconnected" && hasFolder && (await enabledInSettings(folder, "slack-drafts"));
  const slackHealth = slackSession ? await slackStillWorks(slackSession) : "unknown";
  const store = storeName();
  // The setup plugin can be newer than the folder: until the folder has the session reader, Connect
  // Slack would save a sign-in that folder cannot use and remove the copies it still needs.
  const slackFolderOk = !hasFolder || (await slackFolderReady(folder));
  const readingOn = slackLegacy && (await slackReadingServerMayRun(folder));
  add({
    id: "slack-drafts",
    group: "Full capability",
    title: "Slack drafts",
    detail:
      slackRead.state === "error"
        ? `AgentOS could not read your ${store}. Unlock it (or sign in to this computer again), then press Check again.`
        : slackSession
          ? slackHealth === "signed-out"
            ? "Slack has signed this session out (for example after you signed out of Slack). Press Reconnect Slack and sign in again."
            : `Connected as ${slackSession.user || "you"} in Manukora's Slack. AgentOS keeps your Slack sign-in in your ${store} so it can create drafts in your Slack, and it never sends. Disconnect below removes it.`
          : !slackFolderOk
            ? "Update AgentOS first (Bring AgentOS up to date, above), then press Connect Slack."
            : slackLegacy
              ? readingOn
                ? `Connected the older way, with the values in plain files. Press Connect Slack to move Slack drafts into your ${store}. Your optional Slack reading tools are switched on and keep using their own copy in plain files; that copy is removed only if you switch them off.`
                : `Connected the older way, with the values in plain files. Press Connect Slack to move them into your ${store} and remove the plain copies.`
              : SLACK_CONNECT_TEXT,
    status:
      slackRead.state === "error"
        ? "needs-you"
        : slackSession
          ? slackHealth === "signed-out"
            ? "needs-you"
            : "done"
          : slackLegacy
            ? "done"
            : live && slackFolderOk
              ? "needs-you"
              : "waiting",
    actionLabel: slackRead.state === "error" || (!slackFolderOk && !slackSession) ? undefined : slackSession ? "Reconnect Slack" : "Connect Slack",
    skippable: true,
    repeatable: Boolean((slackSession || slackLegacy) && live),
  });
  if (slackSession || slackLegacy || disconnectUnfinished) {
    add({
      id: "slack-disconnect",
      group: "Full capability",
      title: "Switch Slack account",
      detail: disconnectUnfinished
        ? "Disconnect did not finish switching Slack drafts off. Press Disconnect again."
        : slackSession
          ? `Removes the saved Slack sign-in (${slackSession.user || "this account"}) from this computer and switches Slack drafts off. Use it before connecting a different Slack account.`
          : "Stops AgentOS using the older Slack setup and switches Slack drafts off. Connect Slack then tidies the older plain copies. Use it before connecting a different Slack account.",
      status: disconnectUnfinished ? "needs-you" : "done",
      actionLabel: "Disconnect",
      repeatable: true,
    });
  }

  const roleServers = hasFolder ? await roleServerPicks(folder, intake) : [];
  const roleOff = roleServers.filter((s) => !s.enabled).map((s) => s.name);
  const roleReady = keysIn && !state.keysOutstanding;
  add({
    id: "role-tools",
    group: "Full capability",
    title: "Your role's tools",
    detail: !scaffolded
      ? "Decided by your answers in onboarding."
      : !roleServers.length
        ? "Nothing extra for your role."
        : roleOff.length
          ? `To turn on: ${roleOff.join(", ")}.`
          : roleReady
            ? "All on."
            : "Switched on, and waiting for the shared keys.",
    status: !scaffolded ? "waiting" : !roleServers.length || (!roleOff.length && roleReady) ? "done" : roleOff.length && roleReady ? "todo" : "waiting",
    actionLabel: "Turn them on",
    skippable: scaffolded && roleServers.length > 0 && !(roleReady && !roleOff.length),
  });

  const wantsCodex = addOnChosen(intake, /codex/i);
  const codexLinked = hasFolder && (await exists(path.join(folder, ".codex/config.toml")));
  const codexSignedIn = wantsCodex && codexLoggedIn(await run("codex", ["login", "status"], { timeoutMs: 30000 }));
  const codexWired = codexLinked && codexSignedIn;
  add({
    id: "codex",
    group: "Full capability",
    title: "Codex or ChatGPT work seat",
    detail: !scaffolded
      ? "Decided by your answers in onboarding."
      : !wantsCodex
        ? "Not requested. Tell AgentOS if you get a seat."
        : codexWired
          ? "Codex can use AgentOS. Its safety checks are weaker, so do destructive and connector-heavy work in Claude."
          : "Installs Codex if needed. Sign in with your work seat, then press this again to link AgentOS.",
    status: !scaffolded ? "waiting" : !wantsCodex || codexWired ? "done" : "todo",
    actionLabel: "Set up Codex",
    skippable: scaffolded && wantsCodex && !codexWired,
  });

  const health = intakePhaseDone(intake, "C");
  add({
    id: "resume",
    group: "Finish",
    title: "Check everything and learn your writing voice",
    detail: health
      ? "All checks have run."
      : "Runs read-only checks, learns how you write, and shows what you can do with it.",
    status: health ? "done" : live ? "todo" : "waiting",
    actionLabel: "Run it",
  });
  const tuneUp = /^Tune-up:\s*(.+?)\s*$/im.exec(await readIfThere(path.join(folder, "context/about-me.md")))?.[1] ?? "";
  const liveSchedule = live ? await liveTuneUp() : null;
  const scheduled = Boolean(liveSchedule);
  // A sleeping computer misses its tune-up, so show it as overdue after eight days.
  const lastTuneUp = scheduled ? await mtimeOf(path.join(folder, "data/tune-up/latest.md")) : 0;
  if (scheduled && !state.tuneUpScheduledAt) {
    // Scheduled before this was recorded: start counting from now, so it can become overdue.
    await updateState((s) => {
      s.tuneUpScheduledAt ??= Date.now();
    });
  }
  const since = Math.max(lastTuneUp, state.tuneUpScheduledAt ?? Date.now(), state.tuneUpRunAt ?? 0);
  // The live schedule wins, then the one saved at onboarding, then a suggestion. A custom cron that
  // cannot be shown as a day and a time is kept and shown as it is, never replaced by the suggestion.
  const savedCron = liveSchedule?.cron || tuneUp.split(/\s+/).slice(0, 5).join(" ");
  const savedZone = liveSchedule?.timezone || tuneUp.split(/\s+/)[5] || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const customCron = /^(\S+\s+){4}\S+$/.test(savedCron) && !cronToDayTime(savedCron) ? savedCron : "";
  const tuneUpWhen = cronToDayTime(savedCron) ?? cronToDayTime(suggestedTuneUp(folder)) ?? { day: "Monday", time: "9:30 AM" };
  const whenInputs = [
    ...(customCron
      ? [{ key: "cron", label: "Schedule (your own, in cron form)", secret: false, value: customCron }]
      : [
          { key: "day", label: "Day (Monday, Mon and Thu, Weekdays or Every day)", secret: false, value: tuneUpWhen.day },
          { key: "time", label: "Time (for example 9:30 AM)", secret: false, value: tuneUpWhen.time },
        ]),
    { key: "timezone", label: "Time zone", secret: false, value: savedZone },
  ];
  const overdue = scheduled && Date.now() - since > 8 * 24 * 3600 * 1000;
  add({
    id: "tune-up",
    group: "Finish",
    title: "Schedule your tune-up",
    detail: overdue
      ? "Your tune-up has not run for over a week, probably because the computer was asleep. Run it now?"
      : scheduled
        ? `Your tune-up runs ${customCron ? `on your own schedule (${customCron})` : `${tuneUpWhen.day === "Every day" || tuneUpWhen.day === "Weekdays" ? tuneUpWhen.day.toLowerCase() : `every ${tuneUpWhen.day}`} at ${tuneUpWhen.time}`}. Leave your computer on at that time. To change it, edit below and press Change it.`
        : "Keeps AgentOS fast and tidy, and updates it, its connections and Claude Code. Your computer needs to be on at the time you choose.",
    status: overdue ? "needs-you" : scheduled ? "done" : live ? "todo" : "waiting",
    actionLabel: overdue ? "Run it now" : scheduled ? "Change it" : "Schedule it",
    skippable: true,
    repeatable: overdue || scheduled,
    inputs: overdue ? [] : whenInputs,
  });

  // A short guide on organising work in Paseo (workspaces, tabs, 10 rules of thumb from Mike Bell).
  // Optional reading, so it is always "done": it never counts as a step left and never reopens a
  // finished setup. The button just opens the guide, any number of times.
  add({
    id: "where-to-start",
    group: "Finish",
    title: "Where to start in Paseo",
    detail: "Optional: a two-minute guide to organising your work, when to start a new workspace, when a tab is enough, and 10 rules of thumb.",
    status: "done",
    actionLabel: "Open the guide",
    link: WHERE_TO_START_GUIDE,
    repeatable: true,
  });

  const auditStarted = state.confirmed.includes("audit");
  add({
    id: "audit",
    group: "Finish",
    title: "Run your first audit",
    detail: auditStarted ? "Your audit was started. You can run another any time." : "Recommended. Gives you a health baseline for your AgentOS.",
    status: auditStarted ? "done" : health ? "todo" : "waiting",
    actionLabel: "Run /audit",
    skippable: true,
    repeatable: auditStarted,
  });

  // Hand-offs: say where a step is running until it is verified done, then forget it.
  const handoffs = state.handoffs ?? {};
  const finished = steps.filter((step) => handoffs[step.id] && step.status === "done").map((step) => step.id);
  // Signed in to Claude in a terminal, but Paseo may still show Claude as Unavailable until it
  // re-reads the sign-in. Ask Paseo once; if so, show the restart banner.
  // After a first sign-in, ask Paseo whether it sees Claude. "loading" is not an answer yet: keep a
  // separate check (not the terminal hand-off) and ask again on the next poll, up to CLAUDE_CHECK_MS
  // from the sign-in; still loading after that, or "unavailable"/"error", means a restart.
  const check = state.claudeCheck;
  const checkLive = !!check && check.daemon === process.ppid;
  let restartForClaude = false;
  let nextCheck: State["claudeCheck"] | null = check && !checkLive ? null : undefined;
  if (finished.includes("claude-signin") || checkLive) {
    const since = checkLive ? check!.since : Date.now();
    const providers = await run(paseoCli(), ["provider", "ls", "--json"], { timeoutMs: 15000 });
    // A failed call is not an answer either: it is asked again within the window, and still no answer
    // at the end of it means a restart, like a provider that never finishes loading.
    const claude = providers.code === 0 ? claudeProviderState(providers.out) : "loading";
    const expired = Date.now() - since > CLAUDE_CHECK_MS;
    restartForClaude = claude === "unavailable" || (claude === "loading" && expired);
    nextCheck = claude === "loading" && !expired ? { since, daemon: process.ppid } : checkLive ? null : undefined;
  }
  if (finished.length || restartForClaude || nextCheck !== undefined) {
    await updateState((s) => {
      for (const id of finished) delete s.handoffs?.[id];
      if (nextCheck === null) delete s.claudeCheck;
      else if (nextCheck) s.claudeCheck = nextCheck;
      if (restartForClaude) markRestartFor(s, "claude-signin");
    });
  }
  // While Paseo is checking Claude, the page polls quickly so the waiting steps free up soon after.
  let watching = !!nextCheck || finished.includes("claude-signin");
  const shown = steps.map((step) => {
    const handoff = handoffs[step.id];
    if (!handoff || step.status === "done" || step.status === "working" || Date.now() - handoff.at > HANDOFF_FRESH_MS) return step;
    watching = true;
    const where = handoff.kind === "chat" ? `the "${handoff.name}" chat` : `the "${handoff.name}" terminal tab`;
    return { ...step, detail: `Running in ${where}. Finish there; this step updates on its own when it is done. ${step.detail}` };
  });
  const settled = shown.map((step) =>
    state.skipped.includes(step.id) && step.status !== "done" && step.skippable
      ? { ...step, status: "skipped" as const }
      : step,
  );
  const restart = await restartView(settled.filter((step) => ["todo", "needs-you", "failed"].includes(step.status)).length);
  return {
    // Steps stay "done" on the wire so an older setup page still reads this answer; the page shows
    // the ones listed in restartSteps as "Waiting for restart".
    steps: settled,
    restartSteps: settled.filter((step) => step.status === "done" && restart.steps.includes(step.id)).map((step) => step.id),
    folder,
    workspaceId: state.workspaceId,
    restartNeeded: restart.needed,
    restartFor: restart.names,
    restartNow: restart.now,
    restartPickedUp: restart.pickedUp,
    watching,
  };
}

const HANDOFF_FRESH_MS = 45 * 60 * 1000;
// How long Setup waits for Paseo to finish checking Claude after a first sign-in.
const CLAUDE_CHECK_MS = 10 * 60 * 1000;
const CLAUDE_CHECKING_TEXT = "Paseo is still checking Claude after your sign-in. This updates on its own in a moment.";

// A first sign-in handed to a terminal and not yet checked against Paseo (the next status pass checks it).
function signInHandedOff(state: State) {
  const handoff = state.handoffs?.["claude-signin"];
  return !!handoff && Date.now() - handoff.at <= HANDOFF_FRESH_MS;
}

// A Claude check left by this Paseo process (one left by an earlier process ended with the restart).
export function claudeCheckPending(state: State) {
  return !!state.claudeCheck && state.claudeCheck.daemon === process.ppid;
}

// "unavailable": Paseo still has not picked up the sign-in, so a restart is needed. "loading": Paseo 0.17
// is still checking its providers, so the answer is not known yet. Anything unreadable counts as "ok".
export function claudeProviderState(out: string): "ok" | "loading" | "unavailable" {
  try {
    const list = JSON.parse(out.slice(Math.max(0, out.indexOf("[")))) as Array<{ provider?: string; status?: string }>;
    const claude = Array.isArray(list) ? list.find((p) => p?.provider === "claude") : undefined;
    if (!claude || claude.status === "available") return "ok";
    return claude.status === "loading" ? "loading" : "unavailable";
  } catch {
    return "ok";
  }
}

export function claudeProviderUnavailable(out: string) {
  return claudeProviderState(out) === "unavailable";
}

async function roleServerPicks(folder: string, intake: string) {
  const picks = rolePicks(intake);
  const names: string[] = [];
  if (/xero/i.test(picks)) {
    const nz = /xero-manukora|xero[^,]*\b(nz|manukora)\b/i.test(picks);
    const us = /xero-ora|xero[^,]*\b(us|ora)\b/i.test(picks);
    if (nz || !us) names.push("xero-manukora");
    if (us || !nz) names.push("xero-ora");
  }
  if (/datadoe/i.test(picks)) names.push("datadoe");
  // datahub-postgres is retired (DataHub goes through the DataHub (org) connector, AIS-278), so an
  // old pick never turns it back on.
  if (/higgsfield/i.test(picks)) names.push("higgsfield");
  if (/better-notion/i.test(picks)) names.push("better-notion-mcp");
  if (wantsN8n(intake)) names.push("n8n-mcp");
  if (addOnChosen(intake, /github/i)) names.push("github");
  const raw = (await readIfThere(path.join(folder, ".claude/settings.json"))) || "{}";
  const enabled = (JSON.parse(raw) as { enabledMcpjsonServers?: string[] }).enabledMcpjsonServers ?? [];
  return names.map((name) => ({ name, enabled: enabled.includes(name) }));
}

function quoteForShell(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function assertRan(result: { code: number; out: string }, what: string) {
  if (result.code !== 0) throw new Error(`${what} did not finish: ${lastLines(result.out)}`);
  return result.out;
}

// Installs the AgentOS Paseo plugins from the person's own folder (kept current by the update step),
// and, once onboarding has chosen them, the role's Claude plugins.
async function installPlugins(folder: string, includeClaude: boolean) {
  const intake = await readIfThere(path.join(folder, "aios-intake.md"));
  if (includeClaude) {
    for (const plugin of claudePlugins) {
      if (plugin.when === "n8n" && !wantsN8n(intake)) continue;
      await run("claude", ["plugin", "marketplace", "add", plugin.marketplace], { timeoutMs: 120000 });
      assertRan(await run("claude", ["plugin", "install", plugin.install], { timeoutMs: 180000 }), `Adding ${plugin.title}`);
    }
  }
  const installed = await paseoPluginInventory();
  if (!installed) throw new Error("Could not list your Paseo plugins. Check Paseo is open, then press Add them again.");
  let changed = false;
  // Paseo 0.16 starts a plugin as soon as it is installed or enabled (observed in testing, and in
  // Paseo's install path). Ask for a restart only if one is still not running afterwards.
  const needsRestart = async () => undefined;
  for (const plugin of paseoPlugins) {
    const state = pluginState(installed, plugin.id);
    if (state === "running") continue;
    if (state === "disabled") {
      assertRan(await run(paseoCli(), ["plugin", "enable", plugin.id], { timeoutMs: 60000 }), `Turning on ${plugin.title}`);
      changed = true;
      await needsRestart();
      continue;
    }
    // A broken copy with the same id (left by the desktop pilot) is replaced.
    if (state === "failed") await run(paseoCli(), ["plugin", "remove", plugin.id], { timeoutMs: 60000 });
    const source = path.join(folder, plugin.source);
    if (!(await exists(path.join(source, "paseo-plugin.json")))) throw new Error(`${plugin.title} is not in your AgentOS folder yet. Run "Bring AgentOS up to date" first.`);
    assertRan(await run(paseoCli(), ["plugin", "install", source], { timeoutMs: 180000 }), `Adding ${plugin.title}`);
    changed = true;
    await needsRestart();
  }
  const after = await paseoPluginInventory();
  // Could not read the list: say so rather than guess either way.
  if (!after) return changed ? "Added. Press Check again to confirm they are running." : "";
  const waiting = paseoPlugins.filter((plugin) => pluginState(after, plugin.id) !== "running");
  if (!waiting.length) {
    // All running: an older "plugins" restart reason no longer applies; other reasons stay.
    await updateState((state) => {
      if (!state.restartFor?.includes("plugins")) return;
      state.restartFor = state.restartFor.filter((id) => id !== "plugins");
      if (!state.restartFor.length) {
        delete state.restartFor;
        delete state.restartDaemon;
      }
    });
    return changed ? "Added. They are running now." : "";
  }
  await updateState((state) => {
    markRestartFor(state, "plugins");
  });
  return "Quit and reopen Paseo to finish adding them.";
}

async function regenerateCodex(folder: string) {
  if (await exists(path.join(folder, ".codex/config.toml"))) {
    assertRan(await run("pwsh", ["-NoProfile", "-File", "scripts/gen-codex-config.ps1"], { cwd: folder }), "Updating Codex");
  }
}

async function enableServers(folder: string, names: string[]) {
  if (!names.length) return;
  const file = path.join(folder, ".claude/settings.json");
  const raw = await readFile(file, "utf8");
  const settings = JSON.parse(raw) as { enabledMcpjsonServers?: string[]; disabledMcpjsonServers?: string[] };
  settings.enabledMcpjsonServers = [...new Set([...(settings.enabledMcpjsonServers ?? []), ...names])];
  if (settings.disabledMcpjsonServers) {
    settings.disabledMcpjsonServers = settings.disabledMcpjsonServers.filter((s) => !names.includes(s));
  }
  const backups = path.join(folder, "data/backups");
  await mkdir(backups, { recursive: true });
  await writeFile(path.join(backups, `settings.json.plugin.${Date.now()}`), raw);
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
  await regenerateCodex(folder);
}

async function ensureLocalKeysFile(folder: string) {
  const target = path.join(folder, ".env");
  if (!(await exists(target))) await copyFile(path.join(folder, ".env.example"), target);
  await chmod(target, 0o600);
}

async function installFolder(values: Record<string, string>, fallback: string) {
  const folder = path.resolve(expandHome((values.folder || fallback).trim()));
  if (!(await exists(path.join(folder, "AGENTS.md")))) {
    if (await exists(folder)) throw new Error(`${folder} already exists and is not AgentOS. Choose another folder.`);
    const name = values.name?.trim();
    const email = values.email?.trim() ?? "";
    if (!name || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error("Enter your name and work email first.");
    const root = await repoRoot();
    const revision = assertRan(await run("git", ["rev-parse", "HEAD"], { cwd: root }), "Reading the AgentOS version")
      .split("\n")[0]
      .trim();
    assertRan(await run("git", ["clone", "-q", "--no-hardlinks", root, folder], { timeoutMs: 300000 }), "Copying AgentOS");
    assertRan(await run("git", ["-C", folder, "checkout", "-q", "-B", "main", revision]), "Selecting the version");
    assertRan(
      await run("git", ["-C", folder, "remote", "set-url", "origin", "https://github.com/manukora-nz/manukora-agentos.git"]),
      "Setting the update source",
    );
    await run("git", ["-C", folder, "branch", "--unset-upstream"]);
    assertRan(await run("git", ["-C", folder, "config", "user.name", name]), "Saving your name");
    assertRan(await run("git", ["-C", folder, "config", "user.email", email]), "Saving your email");
  }
  await updateState((state) => {
    state.folder = folder;
  });
  return folder;
}

// The vault script exits successfully even when keys are missing, and lists them under these headings.
export function outstandingKeys(out: string) {
  const keys: string[] = [];
  let inSection = false;
  for (const line of out.split("\n")) {
    if (/^(Field name not recognised|Not found in the vault)/.test(line.trim())) inSection = true;
    else if (!line.trim()) inSection = false;
    else if (inSection) {
      const key = /^\s*([A-Z][A-Z0-9_]+)\s/.exec(line)?.[1];
      if (key) keys.push(key);
    }
  }
  return keys;
}

// Run through a login shell so a token stored moments ago is visible without restarting Paseo.
async function fillSharedKeys(folder: string) {
  const shell = process.env.SHELL || "/bin/zsh";
  const out = assertRan(
    isWindows
      ? await run("pwsh", ["-NoProfile", "-File", "scripts/fill-env-from-vault.ps1", "-Apply"], { cwd: folder, timeoutMs: 180000 })
      : await run(shell, ["-lc", "pwsh -NoProfile -File scripts/fill-env-from-vault.ps1 -Apply"], { cwd: folder, timeoutMs: 180000 }),
    "Connecting shared keys",
  );
  const problems = outstandingKeys(out);
  await updateState((state) => {
    state.keysOutstanding = problems.length ? problems.slice(0, 8).join(", ") : undefined;
  });
}

async function currentFolder() {
  const state = await loadState();
  if (!state.folder) throw new Error("Create your AgentOS folder first.");
  return state.folder;
}

async function setupCodex(folder: string) {
  const args = ["-NoProfile", "-File", "scripts/setup-codex.ps1"];
  if (testMode) args.push("-SkipGlobalSkills");
  assertRan(await run("pwsh", args, { cwd: folder }), "Linking Codex");
  if (testMode) return;
  const target = path.join(home, ".codex");
  await mkdir(target, { recursive: true });
  for (const name of ["AGENTS.md", "config.toml"]) {
    const destination = path.join(target, name);
    if (!(await exists(destination))) {
      await copyFile(path.join(folder, ".codex/global-templates", name), destination);
    }
  }
}

const SLACK_C = /^xoxc-[A-Za-z0-9._-]+$/;
const SLACK_D = /^xoxd-[A-Za-z0-9%+/=._-]+$/;

export function slackValuesLookRight(xoxc: string, xoxd: string) {
  return SLACK_C.test(xoxc) && SLACK_D.test(xoxd) && xoxd.length >= 40;
}

// Checked before anything is stored, so a bad pair never replaces a working one.
export async function slackAccepts(xoxc: string, xoxd: string, send: typeof fetch = fetch) {
  const response = await send("https://manukorageneral.slack.com/api/auth.test", {
    method: "POST",
    headers: { Cookie: `d=${xoxd}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: xoxc }).toString(),
    signal: (AbortSignal as unknown as { timeout(ms: number): AbortSignal }).timeout(20000),
  });
  const data = (await response.json()) as { ok?: boolean };
  return data.ok === true;
}

export async function verifySlackOrThrow(xoxc: string, xoxd: string, send: typeof fetch = fetch) {
  const accepted = await slackAccepts(xoxc, xoxd, send).catch(() => {
    throw new Error("Could not reach Slack to check those values. Nothing was changed.");
  });
  if (!accepted) throw new Error("Slack did not accept those values, so nothing was changed. Copy both again from the same Slack session.");
}

// ---- Connect Slack (AIS-479) ----

let slackCaptureDeps: CaptureDeps = realCaptureDeps;
let identify: (xoxc: string, xoxd: string) => Promise<AuthInfo> = (xoxc, xoxd) => slackIdentity(xoxc, xoxd);
export function setSlackForTests(parts: { capture?: CaptureDeps; identify?: typeof identify; teamId?: string }) {
  if (!testMode) return;
  if (parts.teamId) setPinnedForTests(parts.teamId);
  if (parts.capture) slackCaptureDeps = parts.capture;
  if (parts.identify) identify = parts.identify;
}

let slackCancelled = false;

let slackChain: Promise<unknown> = Promise.resolve();
function withSlackLock<T>(work: () => Promise<T>): Promise<T> {
  const next = slackChain.then(work, work);
  slackChain = next.catch(() => undefined);
  return next;
}

// Saves only after Slack confirms the workspace and the person; a failure leaves the working pair alone.
const SLACK_FOLDER_FIRST = "Update AgentOS first (Bring AgentOS up to date), then press Connect Slack. Nothing was changed.";
async function slackFolderReady(folder: string) {
  return exists(path.join(folder, "scripts", "slack_session.py"));
}

export async function connectSlack(folder: string, pair: { xoxc: string; xoxd: string; teamId: string }, cancelled: () => boolean = () => false) {
  if (!(await slackFolderReady(folder))) throw new Error(SLACK_FOLDER_FIRST);
  // Preflight: settings must be readable before anything changes, so a later step cannot fail halfway.
  try {
    JSON.parse(await readFile(path.join(folder, ".claude/settings.json"), "utf8"));
  } catch {
    throw new Error("Could not read .claude/settings.json in your AgentOS folder. Nothing was changed.");
  }
  const info = await identify(pair.xoxc, pair.xoxd).catch(() => {
    throw new Error("Could not reach Slack to check the session. Nothing was changed.");
  });
  const problem = checkIdentity(info);
  if (problem) throw new Error(problem);
  if (pair.teamId && pair.teamId !== info.teamId) throw new Error("Slack answered for a different workspace than the one signed in. Nothing was saved.");
  // The person already set up: the store, or before the first Connect the older plain setup.
  // After an explicit Disconnect there is nobody to compare against: Disconnect was the confirmation.
  const stored = await readStoredSession();
  if (stored.state === "error") throw new Error(`Could not read your ${storeName()}, so the Slack account could not be checked. Nothing was changed.`);
  let previousUser = stored.state === "ok" ? { id: stored.session.userId, name: stored.session.user } : null;
  if (stored.state === "missing") {
    const legacy = await legacySlackPair(folder);
    if (legacy) {
      const unknown = () =>
        new Error('Could not tell whose older Slack setup is on this computer. Press Disconnect on "Switch Slack account" to confirm it can be replaced, then press Connect Slack. Nothing was changed.');
      // A 1Password reference or an inherited value cannot be checked here: confirm by Disconnect.
      if (legacy.unresolved) throw unknown();
      const old = await identify(legacy.xoxc, legacy.xoxd).catch(() => null);
      if (!old) throw new Error("Could not reach Slack to check the older Slack setup on this computer. Nothing was changed; try again.");
      // Only a session Slack says is dead belongs to nobody; any other unclear answer needs confirming.
      const dead = !old.ok && SLACK_SIGNED_OUT.has(old.error ?? "");
      if (old.ok && old.userId) previousUser = { id: old.userId, name: old.user };
      else if (!dead) throw unknown();
    }
  }
  if (previousUser?.id && previousUser.id !== info.userId) {
    throw new Error(
      `That is a different Slack account (${info.user || "unknown"}) from the one already set up (${previousUser.name || "unknown"}). To switch, press Disconnect on "Switch Slack account" first. Nothing was changed.`,
    );
  }
  if (cancelled()) throw new Error("Connect Slack was cancelled. Nothing was saved.");
  const session: SlackSession = {
    xoxc: pair.xoxc,
    xoxd: pair.xoxd,
    teamId: info.teamId,
    userId: info.userId,
    user: info.user,
    domain: SLACK_DOMAIN,
    savedAt: new Date().toISOString(),
  };
  try {
    await saveSession(session);
  } catch (error) {
    // Put back exactly what was there before, and say so if that also fails.
    const undo =
      stored.state === "ok"
        ? saveSession(stored.session)
        : stored.state === "disconnected"
          ? markDisconnected()
          : deleteSession();
    const undone = await undo.then(() => true, () => false);
    throw new Error(`${(error as Error).message}${undone ? " The previous state was put back." : " The previous state could not be put back; press Connect Slack again."}`);
  }
  forgetSlackHealth();
  // Drafts on first (only drafts: the optional Slack reading server is left exactly as it was), so a
  // settings failure never follows a cleanup; older copies are removed only once that has worked.
  await enableServers(folder, ["slack-drafts"]);
  const removed = await removeOldSlackCopies(folder);
  return `Connected as ${info.user || "you"}.${removed ? ` ${removed}` : ""}`;
}

// The older setup's pair, read the way scripts/run-with-env.ps1 reads .env (trimmed, quotes removed,
// the last non-empty assignment wins), then this process's environment.
async function legacySlackPair(folder: string, includeEnvironment = true) {
  const values: Record<string, string> = {};
  for (const raw of (await readIfThere(path.join(folder, ".env"))).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at < 0) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim().replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, "");
    if (value) values[key] = value;
  }
  const fromEnv = (key: string) => (includeEnvironment ? process.env[key] ?? "" : "");
  const xoxc = values.SLACK_MCP_XOXC_TOKEN || fromEnv("SLACK_MCP_XOXC_TOKEN");
  const xoxd = values.SLACK_MCP_XOXD_TOKEN || fromEnv("SLACK_MCP_XOXD_TOKEN");
  if (!xoxc && !xoxd) return null;
  const unresolved = !xoxc || !xoxd || xoxc.startsWith("op://") || xoxd.startsWith("op://");
  return { xoxc, xoxd, unresolved };
}

const SLACK_HEALTH_TTL_MS = 10 * 60 * 1000;
let slackHealth: { key: string; at: number; result: "ok" | "signed-out" | "unknown" } | null = null;
function forgetSlackHealth() {
  slackHealth = null;
}
export function forgetSlackHealthForTests() {
  if (testMode) slackHealth = null;
}

// A cached check that the saved session still works, so the step can offer Reconnect.
// Slack answers that mean this session will not work again (connectSlack treats them as dead too).
const SLACK_SIGNED_OUT = new Set(["invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired"]);

async function slackStillWorks(session: SlackSession): Promise<"ok" | "signed-out" | "unknown"> {
  const key = `${session.userId}:${session.savedAt}`;
  if (slackHealth && slackHealth.key === key && Date.now() - slackHealth.at < SLACK_HEALTH_TTL_MS) return slackHealth.result;
  let result: "ok" | "signed-out" | "unknown" = "unknown";
  try {
    const info = await identify(session.xoxc, session.xoxd);
    result = info.ok ? "ok" : SLACK_SIGNED_OUT.has(String(info.error)) ? "signed-out" : "unknown";
  } catch {}
  slackHealth = { key, at: Date.now(), result };
  return result;
}

// Exactly the lines the older AgentOS setup wrote (scripts/set-slack-tokens.ps1): `export KEY='value'`
// at the start of a line, single-quoted, nothing after it. A Slack line in any other form (indented,
// double-quoted, with a comment, without export) was written by the person or another tool and stays.
// A value counts only if that script would have accepted it: xoxc `^xoxc-[A-Za-z0-9._-]+$` (prefix checked
// case-insensitively, as PowerShell did), xoxd `^[A-Za-z0-9%+/=._-]+$`, at least 40 long, not an xoxc.
// Anything else on such a line is the person's and stays.
const EXPORT_LINE = /^export (SLACK_MCP_XOXC_TOKEN|SLACK_MCP_XOXD_TOKEN)='([^'\r\n]*)'\r?$/;
function isAgentosSlackLine(line: string) {
  const m = EXPORT_LINE.exec(line);
  if (!m) return false;
  const value = m[2];
  if (m[1] === "SLACK_MCP_XOXC_TOKEN") return /^xoxc-/i.test(value) && /^[A-Za-z0-9._-]+$/.test(value);
  return /^[A-Za-z0-9%+/=._-]+$/.test(value) && value.length >= 40 && !/^xoxc-/i.test(value);
}
const ANY_SLACK_LINE = /^\s*(export\s+)?SLACK_MCP_XOX[CD]_TOKEN\s*=/;

// Removes only AgentOS's own export lines from one file and leaves every other byte as it was: other
// lines, blank lines, line endings, the file's permissions, and a symlinked profile (the link's
// target is edited, the link stays). Returns whether anything was removed and whether a Slack line
// that AgentOS did not write is still there.
export async function stripAgentosSlackLines(file: string): Promise<{ removed: boolean; othersLeft: boolean }> {
  let target: string;
  try {
    target = await realpath(file);
  } catch {
    return { removed: false, othersLeft: false };
  }
  const info = await stat(target);
  if (!info.isFile()) return { removed: false, othersLeft: false };
  const text = await readFile(target, "utf8");
  const lines = text.split("\n");
  const kept = lines.filter((line) => !isAgentosSlackLine(line));
  const othersLeft = kept.some((line) => ANY_SLACK_LINE.test(line));
  if (kept.length === lines.length) return { removed: false, othersLeft };
  const mode = info.mode & 0o777;
  // A fresh, unguessable name created exclusively ("wx"), removed again if anything fails.
  const tmp = `${target}.agentos-tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(tmp, kept.join("\n"), { mode, flag: "wx" });
    await chmod(tmp, mode);
    // Something else (an editor, a dotfile manager) may have saved the profile meanwhile: replace it
    // only if it is still the same file with the same contents, otherwise leave it alone.
    const now = await stat(target);
    if (now.ino !== info.ino || now.size !== info.size || now.mtimeMs !== info.mtimeMs || (await readFile(target, "utf8")) !== text) {
      await rm(tmp, { force: true });
      return { removed: false, othersLeft };
    }
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  return { removed: true, othersLeft };
}

// The older setup left the pair in plain text: a login-profile export (and its backups) on a Mac, user
// environment variables on Windows, and .env. Remove those copies; .env keeps them only while the
// optional Slack reading server is switched on, because that server still reads .env.
async function removeOldSlackCopies(folder: string) {
  const notes: string[] = [];
  // The optional Slack reading server still uses the older copies (from .env, the login profile or
  // Windows user settings): while it can run, leave every one of them in place.
  if (await slackReadingServerMayRun(folder)) {
    return "The optional Slack reading tools keep using their own older copy; switch them off to have it removed.";
  }
  const envFile = path.join(folder, ".env");
  const envText = await readIfThere(envFile);
  if ((await legacySlackPair(folder, false)) !== null || /^\s*SLACK_MCP_XOX[CD]_TOKEN\s*=\s*\S/m.test(envText)) {
    await writeFile(envFile, envText.replace(/^(\s*SLACK_MCP_XOX[CD]_TOKEN\s*)=.*$/gm, "$1="), { mode: 0o600 });
    notes.push("Removed the plain copy from .env.");
  }
  if (isWindows) {
    if (!testMode) {
      const cleared = await run("powershell.exe", [
        "-NoProfile",
        "-Command",
        "foreach ($k in 'SLACK_MCP_XOXC_TOKEN','SLACK_MCP_XOXD_TOKEN') { if ([Environment]::GetEnvironmentVariable($k, 'User')) { [Environment]::SetEnvironmentVariable($k, $null, 'User'); Write-Output 'removed' } }; if ([Environment]::GetEnvironmentVariable('SLACK_MCP_XOXC_TOKEN', 'User') -or [Environment]::GetEnvironmentVariable('SLACK_MCP_XOXD_TOKEN', 'User')) { exit 1 }",
      ]);
      // Say "removed" only when there was something to remove (a new PC never had these).
      if (cleared.code !== 0) notes.push("Could not remove the plain copy from your Windows user settings; AI & Systems can help.");
      else if (cleared.out.includes("removed")) notes.push("Removed the plain copy from your Windows user settings.");
    }
  } else {
    const profile = testMode ? path.join(path.dirname(folder), "plugin-test-zprofile") : path.join(os.homedir(), ".zprofile");
    const dir = path.dirname(profile);
    const name = path.basename(profile);
    const files = [profile];
    try {
      // Backups the older setup made before it edited the profile.
      for (const entry of await readdir(dir)) {
        if (!entry.startsWith(`${name}.agentos-backup-`)) continue;
        const full = path.join(dir, entry);
        if ((await lstat(full)).isFile()) files.push(full);
      }
    } catch {}
    let cleaned = 0;
    let othersLeft = false;
    for (const file of files) {
      try {
        const result = await stripAgentosSlackLines(file);
        if (result.removed) cleaned += 1;
        if (result.othersLeft && file === profile) othersLeft = true;
      } catch {
        notes.push(`Could not tidy ${path.basename(file)}; nothing in it was changed.`);
      }
    }
    if (cleaned) notes.push(`Removed the plain copy AgentOS had put in your login profile${cleaned > 1 ? " and its backups" : ""}.`);
    if (othersLeft) notes.push("Your login profile still has a Slack line AgentOS did not write; it was left as it is. AgentOS uses the saved sign-in, not that line.");
  }
  return notes.join(" ");
}

// Whether the optional Slack reading server can start: either settings file enables it, or every
// project server is enabled. Unreadable settings count as "maybe", so .env is kept.
async function slackReadingServerMayRun(folder: string) {
  for (const name of ["settings.json", "settings.local.json"]) {
    const file = path.join(folder, ".claude", name);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return true; // present but unreadable: assume it may run
    }
    try {
      const settings = JSON.parse(text) as { enabledMcpjsonServers?: string[]; enableAllProjectMcpServers?: boolean };
      if (settings.enableAllProjectMcpServers === true || (settings.enabledMcpjsonServers ?? []).includes("slack")) return true;
    } catch {
      return true;
    }
  }
  return false;
}

async function enabledInSettings(folder: string, name: string) {
  try {
    return ((JSON.parse(await readFile(path.join(folder, ".claude/settings.json"), "utf8")) as { enabledMcpjsonServers?: string[] }).enabledMcpjsonServers ?? []).includes(name);
  } catch {
    return false;
  }
}

async function disableServers(folder: string, names: string[]) {
  const file = path.join(folder, ".claude/settings.json");
  const raw = await readFile(file, "utf8");
  const settings = JSON.parse(raw) as { enabledMcpjsonServers?: string[]; disabledMcpjsonServers?: string[] };
  settings.enabledMcpjsonServers = (settings.enabledMcpjsonServers ?? []).filter((s) => !names.includes(s));
  settings.disabledMcpjsonServers = [...new Set([...(settings.disabledMcpjsonServers ?? []), ...names])];
  const backups = path.join(folder, "data/backups");
  await mkdir(backups, { recursive: true });
  await writeFile(path.join(backups, `settings.json.plugin.${Date.now()}`), raw);
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
  await regenerateCodex(folder);
}

export async function runAction(paseo: Paseo, stepId: string, values: Record<string, string>): Promise<ActionResult> {
  invalidateStatus();
  const openWorkspace = async () => {
    const workspace = await paseo.workspaces.open(await currentFolder());
    await updateState((state) => {
      state.workspaceId = workspace.id;
    });
    return workspace;
  };
  const requireAccount = async () => {
    const account = await claudeAccount();
    const state = await loadState();
    if (account.loggedIn !== true || !(isManukoraTeam(account) || state.skipped.includes("claude-signin"))) {
      throw new Error("Sign in to your Manukora Claude account first.");
    }
    return account;
  };
  const handedOff = (kind: "chat" | "terminal", name: string) =>
    updateState((state) => {
      state.handoffs = { ...(state.handoffs ?? {}), [stepId]: { kind, name, at: Date.now() } };
    });
  const startAgent = async (prompt: string, title: string) => {
    const account = await requireAccount();
    const now = await loadState();
    if (now.restartDaemon === process.ppid && (now.restartFor ?? []).some((id) => id === "claude-signin" || id === "claude-install")) {
      throw new Error("Restart Paseo first, so it picks up Claude. Fully quit it and open it again; your progress is saved.");
    }
    if (claudeCheckPending(now) || (isManukoraTeam(account) && signInHandedOff(now))) throw new Error(CLAUDE_CHECKING_TEXT);
    const workspace = await openWorkspace();
    const agent = await workspace.agents.create({ config: CLAUDE_AGENT, title, prompt });
    await handedOff("chat", title);
    return { workspaceId: workspace.id, agentId: agent.id };
  };
  const openTerminal = async (name: string, command: string, args: string[] = [], track = true) => {
    const workspace = await openWorkspace();
    if (isWindows) {
      // PowerShell 7 when it is there, otherwise the one built into Windows.
      // Full path to the shell, so the terminal never depends on how Paseo searches PATH.
      const searchPath = String(toolEnvironment().PATH ?? "");
      const pwshPath = resolveWindowsCommand("pwsh", searchPath);
      const usePwsh = pwshPath ? (await run(pwshPath, ["-NoProfile", "-Command", "exit 0"], { timeoutMs: 15000 })).code === 0 : false;
      const shell = (usePwsh ? pwshPath : resolveWindowsCommand("powershell", searchPath)) ?? "powershell.exe";
      // Re-read PATH from Windows first, so a tool installed a minute ago is found without restarting Paseo.
      const refresh = "$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ';' + $env:USERPROFILE + '\\.local\\bin'";
      // The .exe or .cmd, never an npm .ps1 shim that a locked-down PC refuses to run.
      const target = resolveWindowsCommand(command, searchPath) ?? command;
      const line = `${refresh}; & ${[target, ...args].map(quoteForPowerShell).join(" ")}`;
      await workspace.terminals.create({ name, command: shell, args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-NoExit", "-Command", line] });
      if (track) await handedOff("terminal", name);
      return { message: `Opened ${name}. Look for the new terminal tab at the top of the window; this step updates on its own when you finish there.`, workspaceId: workspace.id };
    }
    const resolved = (await run("/usr/bin/which", [command], { timeoutMs: 10000 })).out.split("\n")[0]?.trim();
    const shell = process.env.SHELL || "/bin/zsh";
    const target = [resolved?.startsWith("/") ? resolved : command, ...args].map(quoteForShell).join(" ");
    // A login shell gives the terminal the same tools the person has in Terminal.
    await workspace.terminals.create({ name, command: shell, args: ["-lc", `exec ${target}`] });
    if (track) await handedOff("terminal", name);
    return { message: `Opened ${name}. Look for the new terminal tab at the top of the window; this step updates on its own when you finish there.`, workspaceId: workspace.id };
  };
  const markRestart = () =>
    updateState((state) => {
      markRestartFor(state, stepId);
    });
  const confirm = (id: string) =>
    updateState((state) => {
      if (!state.confirmed.includes(id)) state.confirmed.push(id);
    });

  switch (stepId) {
    case "tools": {
      const facts = await preflight((await loadState()).folder ?? defaultFolder());
      if (isWindows) {
        const missing = ["git", "node", "powershell", "python"].filter((tool) => !ok(facts[tool]));
        startJob("tools", async () => {
          await installWindowsTools(run, missing);
          await markRestart();
        });
        return { message: "Installing. This can take a few minutes, and Windows may ask for permission." };
      }
      const root = await repoRoot();
      if (!ok(facts["developer-tools"])) {
        await run("xcode-select", ["--install"]);
        return { message: "macOS is showing an install window. Finish it, then press Install them again." };
      }
      startJob("tools", async () => {
        assertRan(
          await run("sh", ["scripts/setup/install-tools.sh", "--manifest", "docs/setup/tools-manifest.json"], { cwd: root, timeoutMs: 900000 }),
          "Installing tools",
        );
        await markRestart();
      });
      return { message: "Installing. This can take a few minutes." };
    }
    case "voice": {
      // ffmpeg for Looms, without Homebrew: a pinned, checksummed build on Mac, winget on Windows.
      startJob("voice", async () => {
        if (isWindows) await installWindowsTools(run, ["ffmpeg"]);
        else {
          const root = await repoRoot();
          assertRan(
            await run("sh", ["scripts/setup/install-tools.sh", "--manifest", "docs/setup/tools-manifest.json", "--ffmpeg"], { cwd: root, timeoutMs: 900000 }),
            "Installing ffmpeg",
          );
        }
        // Chats started before the install do not see the new command until Paseo restarts.
        await markRestart();
      });
      return { message: "Installing ffmpeg. This takes a few minutes." };
    }
    case "claude-install": {
      startJob("claude-install", async () => {
        if (isWindows) {
          // Anthropic's installer first; winget's Anthropic.ClaudeCode package if that fails.
          const direct = await run("powershell", CLAUDE_INSTALL_ARGS, { timeoutMs: 600000 });
          if (direct.code !== 0) {
            const viaWinget = await run("winget", CLAUDE_WINGET_ARGS, { timeoutMs: 600000 });
            if (!wingetSucceeded(viaWinget)) {
              assertRan({ code: direct.code, out: `Anthropic installer: ${direct.out}\nwinget: ${viaWinget.out}` }, "Installing Claude Code");
            }
          }
        } else {
          assertRan(await run("bash", ["-c", "set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash"], { timeoutMs: 600000 }), "Installing Claude Code");
        }
        if (isWindows) await ensureClaudeOnUserPath(run);
        await markRestart();
      });
      return { message: "Installing Claude Code." };
    }
    case "folder": {
      const state = await loadState();
      await installFolder(values, state.folder ?? (await status(false)).folder);
      await openWorkspace();
      return { message: `AgentOS is ready at ${await currentFolder()}. Carry on down the list.` };
    }
    case "agentos-update": {
      // Run the update script from the release Manukora just sent, not the folder's own /update:
      // older folders (the desktop pilot) carry an /update that refuses to update them (report #113).
      const script = path.join(await repoRoot(), ".claude", "skills", "update", "scripts", "update.ps1");
      if (!(await exists(script))) return { message: "Updating your AgentOS.", ...(await startAgent("/update", "Update AgentOS")) };
      // Name Manukora's release explicitly: a folder whose remote is GitHub would otherwise update to
      // GitHub main, which can be behind the release, and this step would never clear.
      const releaseSource = (await exists(bundleFile())) ? ` -Source ${JSON.stringify(bundleFile())}` : "";
      const prompt =
        "Update this AgentOS folder to the latest Manukora release. Run exactly this command from the folder root " +
        `and follow what it prints:\n\npwsh -NoProfile -File ${JSON.stringify(script)} -NodePath .${releaseSource}\n\n` +
        "Use this command even if this folder's own /update skill says the folder cannot be updated: that skill may be " +
        "from an older AgentOS. If the script reports conflicts with my own changes, explain them in plain words and ask " +
        "me before changing anything. Describe what is new only from the WHAT'S NEW lines it prints, never from commit " +
        "messages. If it prints UP TO DATE, tell me AgentOS is current: that is success, not a block, and " +
        "GitHub access is never needed. When it updates, tell me to restart Paseo.";
      return { message: "Updating your AgentOS.", ...(await startAgent(prompt, "Update AgentOS")) };
    }
    case "claude-signin": {
      // Signing in again: the step is already done, so it is not tracked as a hand-off (that would
      // clear at once and ask for a restart while the browser sign-in is still open). New chats start
      // a fresh Claude that reads the new sign-in, so no restart is needed.
      if ((await claudeAccount()).loggedIn === true) {
        const opened = await openTerminal("Claude sign-in", "claude", ["auth", "login"], false);
        return { ...opened, message: "Opened Claude sign-in in a new terminal tab. Choose your Manukora account in the browser. When the terminal says you are signed in, press Check again and make sure this step shows your Manukora address; then start a new chat. No restart is needed." };
      }
      return openTerminal("Claude sign-in", "claude", ["auth", "login"]);
    }
    case "theme":
      await confirm("theme");
      return { message: "Thanks." };
    case "where-to-start":
      return { message: "Opening the guide in your browser." };
    case "audit": {
      const launched = await startAgent("/audit", "First audit");
      await confirm("audit");
      return { message: "Audit started.", ...launched };
    }
    case "plugins": {
      const folder = await currentFolder();
      const intake = await readIfThere(path.join(folder, "aios-intake.md"));
      if (!jobs.get("plugins")?.running) jobs.delete("plugins");
      startJob("plugins", () => installPlugins(folder, intakePhaseDone(intake, "A")));
      return { message: "Adding your plugins." };
    }
    case "onboard": {
      const state = await loadState();
      if (state.onboardAgentId) {
        const still = await paseo.agents
          .ref(state.onboardAgentId)
          .refresh()
          .catch(() => null);
        if (still) return { message: "Back to your onboarding.", agentId: state.onboardAgentId, workspaceId: state.workspaceId };
      }
      // On Windows, Paseo cannot start Claude until Claude Code's folder is on the search path.
      const paseoSeesClaude = !isWindows || Boolean(resolveWindowsCommand("claude", process.env.PATH ?? ""));
      if (isWindows && ((await ensureClaudeOnUserPath(run)) || !paseoSeesClaude)) {
        await markRestart();
        return { message: "Claude Code was added to Windows' search path. Open Task Manager, end every Paseo task, open Paseo again, then press this again." };
      }
      const launched = await startAgent("/onboard", "AgentOS onboarding");
      await updateState((next) => {
        next.onboardAgentId = launched.agentId;
      });
      return { message: "Onboarding started.", ...launched };
    }
    case "connectors":
      connectorCache = null;
      return openTerminal("Connect your accounts", "claude");
    case "onepassword": {
      const facts = await preflight(await currentFolder());
      if (!ok(facts["1password-cli"])) return { message: "Install the 1Password CLI from the page that just opened, then come back." };
      return openTerminal("Store 1Password token", "pwsh", ["-NoProfile", "-File", "scripts/op-service-account.ps1", "-Set", "-FromClipboard"]);
    }
    case "shared-keys": {
      const folder = await currentFolder();
      startJob("shared-keys", async () => {
        await ensureLocalKeysFile(folder);
        const intake = await readIfThere(path.join(folder, "aios-intake.md"));
        await enableServers(folder, (await roleServerPicks(folder, intake)).filter((s) => !s.enabled).map((s) => s.name));
        await fillSharedKeys(folder);
        await markRestart();
      });
      return { message: "Connecting your shared keys." };
    }
    case "slack-drafts": {
      const folder = await currentFolder();
      // One Slack action at a time: a second press while the window is open does nothing new.
      if (jobs.get("slack-drafts")?.running) return { message: "The Slack sign-in window is already open. Finish there, or close it to stop." };
      if (!(await slackFolderReady(folder))) return { message: SLACK_FOLDER_FIRST };
      slackCancelled = false;
      startJob("slack-drafts", async () => {
        const pair = await captureSlack(slackCaptureDeps, () => slackCancelled);
        try {
          // Connect and Disconnect never overlap; a Disconnect that came in meanwhile wins.
          const note = await withSlackLock(async () => {
            if (slackCancelled) throw new Error("Connect Slack was cancelled. Nothing was saved.");
            return connectSlack(folder, pair, () => slackCancelled);
          });
          await markRestart();
          // A Disconnect pressed after the save supersedes it: never publish a "Connected as" note then.
          return slackCancelled ? undefined : note;
        } catch (error) {
          throw new Error(scrubValues((error as Error).message, [pair.xoxc, pair.xoxd]));
        }
      });
      return { message: "A Slack window is opening. Sign in there with your Manukora Slack account; this step finishes on its own." };
    }
    case "slack-disconnect": {
      const folder = await currentFolder();
      // Stop a waiting Connect, then queue behind any save already in progress: the disconnected
      // marker is always written last and verified before this reports done.
      slackCancelled = true;
      await withSlackLock(async () => {
        slackCancelled = true;
        // The marker stops the drafts helper at once (it checks the store on every request), even in a
        // session that is already running, and never lets an older plain copy stand in.
        await markDisconnected();
        forgetSlackHealth();
        await disableServers(folder, ["slack-drafts"]);
        // An earlier "Connected as ..." note must not stay on the card after Disconnect; any other note
        // (a Connect that this Disconnect cancelled) is still worth showing.
        const last = jobs.get("slack-drafts");
        if (last && !last.running && last.note?.startsWith("Connected as")) jobs.delete("slack-drafts");
      });
      await markRestart();
      return { message: "Disconnected, and Slack drafts are off. Restart Paseo to finish (a chat that is already open keeps its tools until then). Press Connect Slack to connect again." };
    }
    case "role-tools": {
      const folder = await currentFolder();
      const intake = await readIfThere(path.join(folder, "aios-intake.md"));
      const picks = (await roleServerPicks(folder, intake)).filter((s) => !s.enabled).map((s) => s.name);
      await enableServers(folder, picks);
      await ensureLocalKeysFile(folder);
      await fillSharedKeys(folder);
      await markRestart();
      return { message: `Turned on ${picks.join(", ")}. Fully quit and reopen Paseo.` };
    }
    case "codex": {
      const folder = await currentFolder();
      const present = await run("codex", ["--version"], { timeoutMs: 20000 });
      if (present.code !== 0) {
        startJob("codex", async () => {
          assertRan(await run("npm", ["install", "-g", "--prefix", path.join(home, ".local"), "@openai/codex"], { timeoutMs: 300000 }), "Installing Codex");
          await markRestart();
          return "Codex is installed. Press Set up Codex again to sign in.";
        });
        return { message: "Installing Codex." };
      }
      const login = await run("codex", ["login", "status"], { timeoutMs: 30000 });
      if (!codexLoggedIn(login)) {
        const opened = await openTerminal("Sign in to Codex", "codex", ["login"]);
        return { ...opened, message: "Sign in to your work seat in the terminal, then come back and press Set up Codex again." };
      }
      await setupCodex(folder);
      return { message: "Codex is linked to AgentOS." };
    }
    case "devtools":
      if (isWindows) {
        startJob("devtools", async () => {
          await installWindowsTools(run, ["git"]);
        });
        return { message: "Installing Git. Windows may ask for permission. Press Check again when it finishes." };
      }
      await run("xcode-select", ["--install"]);
      return { message: "macOS is showing an install window. Finish it, then press Check again." };
    case "connect": {
      if (!(await appleDeveloperTools())) throw new Error(`Install ${isWindows ? "Git" : "Apple developer tools"} first, using the step above.`);
      const result = await connect(values.url ?? SERVICE_URL, values.key ?? "");
      invalidateStatus();
      return {
        message:
          result === "needs-sign-in"
            ? "Connected. Now sign in with your Manukora Google account."
            : "Connected. AgentOS is downloaded and will stay up to date.",
      };
    }
    case "google": {
      const service = await loadService();
      if (!service?.identity) throw new Error("This Manukora service does not use Google sign-in.");
      const config = service.identity;
      startJob("google", async () => {
        const email = await signIn(config);
        if (!(await exists(path.join(sourceDir(), "scripts/setup/preflight.sh")))) await downloadAfterSignIn();
        return `Signed in as ${email}.`;
      });
      return { message: "A Google sign-in page is opening in your browser." };
    }
    case "download":
      startJob("download", async () => {
        await downloadAfterSignIn();
      });
      return { message: "Downloading AgentOS." };
    case "tune-up": {
      if ((await status(false)).steps.find((s) => s.id === "tune-up")?.status === "needs-you") {
        // Recorded only once the tune-up has actually started, so a failed start keeps the reminder.
        const started = await startAgent("/os-tune-up unattended", "AgentOS tune-up");
        await updateState((state) => {
          state.tuneUpRunAt = Date.now();
        });
        return { message: "Running your tune-up now.", ...started };
      }
      // Older setup screens sent a cron field; current ones send a day and a time.
      const cron = values.cron !== undefined ? values.cron.trim() : dayTimeToCron(values.day ?? "", values.time ?? "");
      const timezone = (values.timezone ?? "").trim();
      if (!/^(\S+\s+){4}\S+$/.test(cron)) throw new Error("That schedule does not look right. Use five parts, like 0 9 * * 1.");
      const [, , dayOfMonth, , dayOfWeek] = cron.split(/\s+/);
      if (dayOfMonth !== "*" && dayOfWeek !== "*") {
        throw new Error("Choose either days of the month or days of the week, not both: cron runs on either, which means many more tune-ups.");
      }
      if (!/^[A-Za-z_]+(\/[A-Za-z_+-]+)*$/.test(timezone)) throw new Error("Enter a time zone like Pacific/Auckland or America/Los_Angeles.");
      const folder = await currentFolder();
      // Change the existing tune-up in place; never add a second one beside it.
      const existing = await liveTuneUp();
      if (existing === undefined) throw new Error("Could not check your schedules just now. Try again in a moment.");
      if (existing) {
        assertRan(
          await run(paseoCli(), ["schedule", "update", existing.id, "--cron", cron, "--timezone", timezone], { timeoutMs: 60000 }),
          "Changing the tune-up",
        );
        return { message: "Your tune-up time is changed." };
      }
      assertRan(
        await run(paseoCli(), ["schedule", "create", "--name", TUNE_UP_NAME, "--cron", cron, "--timezone", timezone,
          "--provider", CLAUDE_AGENT.provider, "--mode", CLAUDE_AGENT.modeId, "--cwd", folder, "/os-tune-up unattended"], { timeoutMs: 60000 }),
        "Scheduling the tune-up",
      );
      await updateState((state) => {
        state.tuneUpScheduledAt = Date.now();
      });
      return { message: "Your tune-up is scheduled." };
    }
    case "resume":
      return { message: "Checking everything.", ...(await startAgent("onboard resume", "AgentOS checks and voice")) };
    default:
      throw new Error(`Unknown step ${stepId}`);
  }
}

export async function setSkip(stepId: string, skipped: boolean) {
  await updateState((state) => {
    state.skipped = state.skipped.filter((id) => id !== stepId);
    if (skipped) state.skipped.push(stepId);
  });
  invalidateStatus();
  return { ok: true };
}

export async function report(paseo: Paseo, text: string) {
  const state = await loadState();
  const service = await loadService();
  if (service) {
    const reporter = state.folder ? (await run("git", ["-C", state.folder, "config", "user.name"])).out.split("\n")[0]?.trim() : "";
    // Strip tokens and the person's own access key before anything leaves the Mac.
    text = redactReport(text, [service.key]);
    const first = text.split("\n")[0].trim();
    const title = first.length <= 80 ? first : `${first.slice(0, 80).replace(/\s+\S*$/, "")}...`;
    const number = await fileReport(title, text, reporter || "AgentOS user");
    // Staff have no GitHub seat, so give the report number rather than a link they cannot open.
    return { message: number ? `Thanks. Your report is filed with AI & Systems as report ${number}.` : "Thanks. Your report is filed with AI & Systems." };
  }
  const cwd = state.folder ?? (await repoRoot());
  const workspace = await paseo.workspaces.open(cwd);
  const agent = await workspace.agents.create({
    config: CLAUDE_AGENT,
    title: "Report to AI & Systems",
    prompt: `/report ${text}\n\nShow me the report before filing it, and file it only after I say yes.`,
  });
  return { message: "Your report is drafted. Check it and say yes to file it.", agentId: agent.id, workspaceId: workspace.id };
}

function updateText(result: { code: number; out: string }, success: string) {
  const text = lastLines(result.out, 6);
  if (result.code !== 0) throw new Error(text || "The update check could not run.");
  return { text: text || success };
}

export async function updatesCheck() {
  return updateText(await run(paseoCli(), ["plugin", "update", "manukora-agentos", "--check"], { timeoutMs: 120000 }), "No update information.");
}

export async function updatesApply() {
  return updateText(await run(paseoCli(), ["plugin", "update", "manukora-agentos", "--yes"], { timeoutMs: 300000 }), "Updated.");
}
