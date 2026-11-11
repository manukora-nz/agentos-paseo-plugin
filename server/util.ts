import { execFile } from "node:child_process";
import { constants as fsc, existsSync } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isBatchFile, isWindows, quoteForCmd, resolveWindowsCommand, windowsToolDirs } from "./windows";

export const home = os.homedir();
export const paseoHome = process.env.PASEO_HOME || path.join(home, ".paseo");
// Test settings only apply inside a throwaway test location, never on an employee's Mac.
const throwaway = /agentos-e2e\.|agentos-plugin-(test|fresh)-/.test(paseoHome);
export const testMode = throwaway && process.env.AGENTOS_TEST_MODE === "1";
const barePath = throwaway && process.env.AGENTOS_TEST_BARE_PATH === "1";
export const stateDir = () => path.join(paseoHome, "manukora-agentos");
export const sourceDir = () => path.join(stateDir(), "source");
export const bundleFile = () => path.join(stateDir(), "agentos.bundle");
export const serviceFile = () => path.join(stateDir(), "service.json");
const stateFile = path.join(paseoHome, "manukora-agentos", "state.json");

export interface State {
  folder?: string;
  workspaceId?: string;
  onboardAgentId?: string;
  skipped: string[];
  confirmed: string[];
  keysOutstanding?: string;
  // The Paseo process that was running when a change needed a restart.
  restartDaemon?: number;
  // When the weekly tune-up was scheduled, so a missed first run shows as overdue.
  tuneUpScheduledAt?: number;
  // When the person last pressed "Run it now", so a running tune-up is not shown as overdue.
  tuneUpRunAt?: number;
}

export async function exists(target: string) {
  try {
    await access(target, fsc.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function loadState(): Promise<State> {
  try {
    const parsed = JSON.parse(await readFile(stateFile, "utf8"));
    return { skipped: [], confirmed: [], ...parsed };
  } catch {
    return { skipped: [], confirmed: [] };
  }
}

let writes: Promise<unknown> = Promise.resolve();
let writeCount = 0;

// All changes go through here, one at a time, each starting from the latest saved state.
export function updateState(change: (state: State) => void): Promise<State> {
  const next = writes.then(async () => {
    const state = await loadState();
    change(state);
    await mkdir(path.dirname(stateFile), { recursive: true });
    writeCount += 1;
    const tmp = `${stateFile}.${process.pid}.${writeCount}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, stateFile);
    return state;
  });
  writes = next.catch(() => undefined);
  return next;
}

export function defaultFolderIsForced() {
  return Boolean(process.env.AGENTOS_DEFAULT_FOLDER);
}

export function defaultFolder() {
  return process.env.AGENTOS_DEFAULT_FOLDER || path.join(home, "AgentOS");
}

export function expandHome(value: string) {
  if (value === "~") return home;
  return value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
}

export async function pluginDirectory() {
  const config = JSON.parse(await readFile(path.join(paseoHome, "config.json"), "utf8"));
  const dir = config?.plugins?.["manukora-agentos"]?.path;
  if (typeof dir !== "string") throw new Error("The AgentOS plugin is not listed in Paseo's config");
  return dir;
}

// Inside the AgentOS repository (AI & Systems) the plugin uses the copy around it. Installed on its
// own (staff), it uses the copy downloaded from the Manukora service.
export async function bundledRepo() {
  const root = path.dirname(await pluginDirectory());
  return (await exists(path.join(root, "scripts/setup/preflight.sh"))) ? root : null;
}

export async function repoRoot() {
  const bundled = await bundledRepo();
  if (bundled) return bundled;
  if (await exists(path.join(sourceDir(), "scripts/setup/preflight.sh"))) return sourceDir();
  throw new Error("Connect to Manukora first, at the top of this list.");
}

export function toolEnvironment(extra: Record<string, string> = {}) {
  if (isWindows) {
    const dirs = [...(barePath ? [] : windowsToolDirs()), process.env.PATH ?? process.env.Path ?? ""];
    const rest = { ...process.env };
    // Windows names the variable "Path"; keep exactly one so the child sees ours.
    delete rest.Path;
    return { ...rest, PATH: dirs.join(";"), GIT_TERMINAL_PROMPT: "0", ...extra };
  }
  const dirs = [
    path.join(home, ".local/bin"),
    ...(barePath ? [] : ["/opt/homebrew/bin", "/usr/local/bin"]),
    process.env.PATH ?? "",
  ];
  return { ...process.env, PATH: dirs.join(":"), GIT_TERMINAL_PROMPT: "0", ...extra };
}

export interface RunResult {
  code: number;
  out: string;
}

export function run(
  cmd: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; extraEnvironment?: Record<string, string> } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const env = toolEnvironment(options.extraEnvironment);
    let file = cmd;
    let argv = args;
    let verbatim = false;
    if (isWindows) {
      // Windows only starts .exe files directly. Tools installed by npm (claude, codex, paseo) are
      // .cmd files, which have to go through cmd.exe with each argument quoted.
      const resolved = resolveWindowsCommand(cmd, env.PATH ?? "");
      if (!resolved) return resolve({ code: 127, out: `${cmd} was not found on this PC.` });
      if (isBatchFile(resolved)) {
        file = process.env.ComSpec || "cmd.exe";
        argv = ["/d", "/s", "/c", `"${[resolved, ...args].map(quoteForCmd).join(" ")}"`];
        verbatim = true;
      } else file = resolved;
    }
    execFile(
      file,
      argv,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 120000,
        env,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
      },
      (error, stdout, stderr) => {
        const failed = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
        const code = !failed ? 0 : typeof failed.code === "number" ? failed.code : 127;
        resolve({ code, out: scrub(`${stdout}\n${stderr}`).trim() });
      },
    );
  });
}

export function scrub(text: string) {
  return text
    .replace(/xox[a-z]-[A-Za-z0-9%+/=._-]+/g, "[hidden]")
    .replace(/ops_[A-Za-z0-9_+/=-]+/g, "[hidden]")
    .replace(/(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, "[hidden]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[hidden]");
}

// The /report redaction policy (report.cjs RULES, also on the company service), applied on the Mac
// before a report leaves it. Keep the three copies in step.
const REPORT_RULES: [RegExp, string][] = [
  [/\bxox[a-z]-[A-Za-z0-9%+/=._-]{8,}/g, "[redacted-slack-token]"],
  [/\bops_[A-Za-z0-9_+/=-]{8,}/g, "[redacted-1password-token]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[redacted-github-token]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted-github-token]"],
  [/\bsk-[A-Za-z0-9_-]{12,}/g, "[redacted-api-key]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-aws-key]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted-jwt]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [redacted]"],
  [/\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s'"`<>]+/gi, "$1://[redacted]"],
  [/([?&](?:key|token|access_token|api_key|sig|signature)=)(?!\[redacted)[^\s&'"`<>]+/gi, "$1[redacted]"],
  [/\b([A-Za-z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|COOKIE)[A-Za-z_]*)([\"']?\s*[:=]\s*)([\"'])(?!\[redacted\]\3)(?:\\.|(?!\3)[^\\])*\3/gi, "$1$2$3[redacted]$3"],
  [/\b([A-Za-z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|COOKIE)[A-Za-z_]*)([\"']?\s*[:=]\s*)(?![\"'\[])[^\s\"']{8,}/gi, "$1$2[redacted]"],
  [/(\/(?:Users|home)\/)[^/\s'"`]+/g, "$1<user>"],
  [/\b([A-Za-z]:[\\/]Users[\\/])[^\\/\s'"`]+/g, "$1<user>"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
];

export function redactReport(text: string, values: string[] = []) {
  let out = scrubValues(text, values);
  for (const [re, label] of REPORT_RULES) out = out.replace(re, label);
  return out;
}

export function scrubValues(text: string, values: string[]) {
  return values.reduce((out, value) => (value ? out.split(value).join("[hidden]") : out), text);
}

export function lastLines(text: string, count = 3) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-count)
    .join(" ");
}

export function paseoCli() {
  const entry = (process.argv[1] ?? "").replace(/\\/g, "/");
  const at = entry.toLowerCase().indexOf("/resources/");
  if (at <= 0) return "paseo";
  const bin = path.join(entry.slice(0, at + "/resources/".length), "bin");
  if (!isWindows) return path.join(bin, "paseo");
  for (const name of ["paseo.cmd", "paseo.exe", "paseo.bat"]) if (existsSync(path.join(bin, name))) return path.join(bin, name);
  return "paseo";
}
