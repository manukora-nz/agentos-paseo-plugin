import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
} from "./util";
import { CLAUDE_INSTALL_ARGS, CLAUDE_WINGET_ARGS, ensureClaudeOnUserPath, installWindowsTools, isWindows, quoteForPowerShell, resolveWindowsCommand, windowsPreflight, wingetSucceeded } from "./windows";
import { bundledRepo, sourceDir } from "./util";
import { identityToken, signIn, signedInEmail } from "./google";
import { connect, downloadAfterSignIn, fileReport, loadService, refreshSource, teamKeys } from "./source";

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
const SLACK_STEPS =
  "In Chrome, open app.slack.com and press Command-Option-J (on Windows: Ctrl-Shift-J). Paste this line, then copy the xoxc- value without quotes: " +
  "JSON.parse(localStorage.localConfig_v2).teams[Object.keys(JSON.parse(localStorage.localConfig_v2).teams)[0]].token. " +
  "Chrome may ask you to type allow pasting first. Then open Application, Cookies, app.slack.com, and copy the value of d. Never paste these into a chat.";

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

function pluginState(list: string, id: string): "running" | "failed" | "absent" {
  const line = list.split("\n").find((l) => l.trim().split(/\s+/)[0] === id);
  if (!line) return "absent";
  return /\bfailed\b/i.test(line) ? "failed" : "running";
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
          const line = result.out.split("\n").find((l) => new RegExp(`claude\\.ai .*${name}`, "i").test(l));
          if (line && connectedInLine(line)) connected.push(name);
          else missing.push(name);
        }
        connectorCache = { at: Date.now(), connected, missing, key };
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
    return { ...step, status: "working", detail: `Working on it...${hint}` };
  }
  if (current?.error && step.status !== "done") return { ...step, status: "failed", detail: current.error };
  if (current?.note && step.status !== "done") return { ...step, detail: `${step.detail} ${current.note}` };
  return step;
}

let lastShown: StatusResult | null = null;
const STATUS_BUDGET_MS = 20000;
export async function status(refresh: boolean): Promise<StatusResult> {
  const full = statusNow(refresh).then((value) => (lastShown = value));
  if (!lastShown || testMode) return full;
  // Paseo gives up on a slow plugin call. Answer with the last result; the check carries on and the
  // next poll shows it.
  const previous = lastShown;
  return Promise.race([full, new Promise<StatusResult>((resolve) => setTimeout(() => resolve(previous), STATUS_BUDGET_MS).unref?.())]);
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
        ? `Signed in as ${account.email}.`
        : `Signed in as ${account.email ?? "an account"}, which is not the Manukora Team plan. Your connectors would read the wrong account. Switch accounts, or skip only if you know this is right.`,
    status: signedIn && onTeam ? "done" : !claudeInstalled || !folderReady ? "waiting" : "needs-you",
    actionLabel: "Open sign-in",
    skippable: signedIn,
  });

  const accountAccepted = signedIn && (onTeam || state.skipped.includes("claude-signin"));
  const canStart = folderReady && accountAccepted;
  const behind = folderReady && (await agentosBehind(folder));
  add({
    id: "agentos-update",
    group: "AgentOS",
    title: "Bring AgentOS up to date",
    detail: !folderReady
      ? "Checked once your folder is ready."
      : behind
        ? "A newer AgentOS is available from AI & Systems."
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
      : "A short interview about your role, priorities and tools. Takes about 15 minutes.",
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

  const claudeList = claudeInstalled && scaffolded ? (await run("claude", ["plugin", "list"], { timeoutMs: 30000 })).out : "";
  const paseoList = paseoPlugins.length && scaffolded ? (await run(paseoCli(), ["plugin", "ls"], { timeoutMs: 30000 })).out : "";
  const wanted = claudePlugins.filter((p) => p.when !== "n8n" || wantsN8n(intake));
  const absent = [
    ...wanted.filter((p) => !claudeList.includes(p.id)).map((p) => p.title),
    ...paseoPlugins.filter((p) => pluginState(paseoList, p.id) !== "running").map((p) => p.title),
  ];
  add({
    id: "plugins",
    group: "Your interface",
    title: "Add your other plugins",
    detail: !scaffolded
      ? "Decided by your answers in onboarding."
      : absent.length
        ? `To add: ${absent.join(", ")}.`
        : wanted.length || paseoPlugins.length
          ? "All added."
          : "Nothing extra needed for your role.",
    status: !scaffolded ? "waiting" : absent.length ? "todo" : "done",
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
        ? `Connected: ${conn.connected.length} of ${conn.wanted.length}. Still to do: ${conn.missing.join(", ")}. Turn each on at claude.ai, Settings, Customize, Connectors. Then in the terminal choose Yes if asked, type /mcp, sign in to each and type /exit. Press Check again when you are done.`
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
        : "Loom screenshots need ffmpeg, which is not installed. Voice memos do not need it. Ask AI & Systems if you use Looms.",
    status: keysSkipped && !keysIn ? "skipped" : keysIn ? (ffmpegOk ? "done" : "needs-you") : "waiting",
    skippable: keysIn && !ffmpegOk,
  });

  const slackIn = hasFolder && (await keyIsSet(folder, "SLACK_MCP_XOXC_TOKEN"));
  add({
    id: "slack-drafts",
    group: "Full capability",
    title: "Slack drafts",
    detail: slackIn
      ? "Messages AgentOS writes land in your Slack Drafts. Nothing ever sends. If Slack stops working, enter fresh values here."
      : SLACK_STEPS,
    status: slackIn ? "done" : live ? "needs-you" : "waiting",
    actionLabel: "Save",
    skippable: true,
    repeatable: Boolean(slackIn && live),
    inputs: [
      { key: "xoxc", label: "xoxc- value", secret: true, value: "" },
      { key: "xoxd", label: "d cookie value", secret: true, value: "" },
    ],
  });

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
  const scheduled = live ? /"AgentOS tune-up"|AgentOS tune-up/.test((await run(paseoCli(), ["schedule", "ls", "--json"], { timeoutMs: 30000 })).out) : false;
  // A sleeping computer misses its tune-up, so show it as overdue after eight days.
  const lastTuneUp = scheduled ? await mtimeOf(path.join(folder, "data/tune-up/latest.md")) : 0;
  if (scheduled && !state.tuneUpScheduledAt) {
    // Scheduled before this was recorded: start counting from now, so it can become overdue.
    await updateState((s) => {
      s.tuneUpScheduledAt ??= Date.now();
    });
  }
  const since = Math.max(lastTuneUp, state.tuneUpScheduledAt ?? Date.now(), state.tuneUpRunAt ?? 0);
  const overdue = scheduled && Date.now() - since > 8 * 24 * 3600 * 1000;
  add({
    id: "tune-up",
    group: "Finish",
    title: "Schedule your tune-up",
    detail: overdue
      ? "Your tune-up has not run for over a week, probably because the computer was asleep. Run it now?"
      : scheduled
        ? "Your regular tune-up is scheduled. Leave your computer on at that time."
        : "Keeps AgentOS fast and tidy, and updates it, its connections and Claude Code. Your computer needs to be on at the time you choose.",
    status: overdue ? "needs-you" : scheduled ? "done" : live ? "todo" : "waiting",
    actionLabel: overdue ? "Run it now" : "Schedule it",
    skippable: true,
    repeatable: overdue,
    inputs: scheduled
      ? []
      : [
          { key: "cron", label: "When (cron; the suggestion is a Monday morning)", secret: false, value: tuneUp.split(/\s+/).slice(0, 5).join(" ") || suggestedTuneUp(folder) },
          { key: "timezone", label: "Time zone", secret: false, value: tuneUp.split(/\s+/)[5] || Intl.DateTimeFormat().resolvedOptions().timeZone },
        ],
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

  return {
    steps: steps.map((step) =>
      state.skipped.includes(step.id) && step.status !== "done" && step.skippable
        ? { ...step, status: "skipped" as const }
        : step,
    ),
    folder,
    workspaceId: state.workspaceId,
    restartNeeded: Boolean(state.restartDaemon && state.restartDaemon === process.ppid),
  };
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

async function saveSlack(folder: string, xoxc: string, xoxd: string) {
  if (!testMode) await verifySlackOrThrow(xoxc, xoxd);
  await ensureLocalKeysFile(folder);
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentos-slack-"));
  try {
    const first = path.join(dir, "a");
    const second = path.join(dir, "b");
    await writeFile(first, xoxc, { mode: 0o600 });
    await writeFile(second, xoxd, { mode: 0o600 });
    const args = ["-NoProfile", "-File", "scripts/set-slack-tokens.ps1", "-XoxcFile", first, "-XoxdFile", second, "-DeleteSourceFiles"];
    args.push("-SkipVerify");
    if (testMode) args.push("-ProfilePath", path.join(path.dirname(folder), "plugin-test-zprofile"));
    const result = await run("pwsh", args, { cwd: folder, timeoutMs: 90000 });
    if (result.code !== 0) throw new Error(`Saving Slack did not finish: ${scrubValues(lastLines(result.out), [xoxc, xoxd])}`);
      } finally {
    await rm(dir, { recursive: true, force: true });
  }
  await chmod(path.join(folder, ".env"), 0o600);
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
  };
  const startAgent = async (prompt: string, title: string) => {
    await requireAccount();
    const workspace = await openWorkspace();
    const agent = await workspace.agents.create({ config: CLAUDE_AGENT, title, prompt });
    return { workspaceId: workspace.id, agentId: agent.id };
  };
  const openTerminal = async (name: string, command: string, args: string[] = []) => {
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
      return { message: `Opened ${name}. Look for the new terminal tab at the top of the window.`, workspaceId: workspace.id };
    }
    const resolved = (await run("/usr/bin/which", [command], { timeoutMs: 10000 })).out.split("\n")[0]?.trim();
    const shell = process.env.SHELL || "/bin/zsh";
    const target = [resolved?.startsWith("/") ? resolved : command, ...args].map(quoteForShell).join(" ");
    // A login shell gives the terminal the same tools the person has in Terminal.
    await workspace.terminals.create({ name, command: shell, args: ["-lc", `exec ${target}`] });
    return { message: `Opened ${name}. Look for the new terminal tab at the top of the window.`, workspaceId: workspace.id };
  };
  const markRestart = () =>
    updateState((state) => {
      state.restartDaemon = process.ppid;
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
      const prompt =
        "Update this AgentOS folder to the latest Manukora release. Run exactly this command from the folder root " +
        `and follow what it prints:\n\npwsh -NoProfile -File ${JSON.stringify(script)} -NodePath .\n\n` +
        "Use this command even if this folder's own /update skill says the folder cannot be updated: that skill may be " +
        "from an older AgentOS. If the script reports conflicts with my own changes, explain them in plain words and ask " +
        "me before changing anything. When it succeeds, tell me to restart Paseo.";
      return { message: "Updating your AgentOS.", ...(await startAgent(prompt, "Update AgentOS")) };
    }
    case "claude-signin":
      return openTerminal("Claude sign-in", "claude", ["auth", "login"]);
    case "theme":
      await confirm("theme");
      return { message: "Thanks." };
    case "audit": {
      const launched = await startAgent("/audit", "First audit");
      await confirm("audit");
      return { message: "Audit started.", ...launched };
    }
    case "plugins": {
      const folder = await currentFolder();
      startJob("plugins", async () => {
        const intake = await readIfThere(path.join(folder, "aios-intake.md"));
        for (const plugin of claudePlugins) {
          if (plugin.when === "n8n" && !wantsN8n(intake)) continue;
          await run("claude", ["plugin", "marketplace", "add", plugin.marketplace], { timeoutMs: 120000 });
          assertRan(await run("claude", ["plugin", "install", plugin.install], { timeoutMs: 180000 }), `Adding ${plugin.title}`);
        }
        // Installed from the person's own AgentOS folder, which the update step keeps current.
        const installed = (await run(paseoCli(), ["plugin", "ls"], { timeoutMs: 30000 })).out;
        for (const plugin of paseoPlugins) {
          const state = pluginState(installed, plugin.id);
          if (state === "running") continue;
          // A broken copy with the same id (left by the desktop pilot) is replaced.
          if (state === "failed") await run(paseoCli(), ["plugin", "remove", plugin.id], { timeoutMs: 60000 });
          const source = path.join(folder, plugin.source);
          if (!(await exists(path.join(source, "paseo-plugin.json")))) throw new Error(`${plugin.title} is not in your AgentOS folder yet. Run "Bring AgentOS up to date" first.`);
          assertRan(await run(paseoCli(), ["plugin", "install", source], { timeoutMs: 180000 }), `Adding ${plugin.title}`);
        }
      });
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
      const xoxc = values.xoxc?.trim() ?? "";
      const xoxd = values.xoxd?.trim() ?? "";
      if (!slackValuesLookRight(xoxc, xoxd)) throw new Error("Those values do not look right. Copy both again.");
      await saveSlack(folder, xoxc, xoxd);
      await markRestart();
      return { message: "Saved. Fully quit and reopen Paseo to turn it on." };
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
      const cron = (values.cron ?? "").trim();
      const timezone = (values.timezone ?? "").trim();
      if (!/^(\S+\s+){4}\S+$/.test(cron)) throw new Error("That schedule does not look right. Use five parts, like 0 9 * * 1.");
      const [, , dayOfMonth, , dayOfWeek] = cron.split(/\s+/);
      if (dayOfMonth !== "*" && dayOfWeek !== "*") {
        throw new Error("Choose either days of the month or days of the week, not both: cron runs on either, which means many more tune-ups.");
      }
      if (!/^[A-Za-z_]+(\/[A-Za-z_+-]+)*$/.test(timezone)) throw new Error("Enter a time zone like Pacific/Auckland or America/Los_Angeles.");
      const folder = await currentFolder();
      assertRan(
        await run(paseoCli(), ["schedule", "create", "--name", "AgentOS tune-up", "--cron", cron, "--timezone", timezone,
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
