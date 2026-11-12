// Windows support (beta). The Mac path uses the shell scripts under scripts/setup; a Windows PC has
// no `sh`, so the same checks and installs are done here with winget and PowerShell.
import { existsSync, lstatSync } from "node:fs";

// winget, and PowerShell or Python installed from the Microsoft Store, are "app execution aliases":
// special links under WindowsApps that an ordinary existence check reports as missing. lstat sees them.
export function commandFileExists(file: string) {
  if (existsSync(file)) return true;
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}
import path from "node:path";

export const isWindows = process.platform === "win32";

const env = process.env;
const home = env.USERPROFILE || "";

// Where winget, the Node/Git/PowerShell/Python installers and Claude Code put their commands. Added
// to PATH so a tool installed a moment ago is found without signing out of Windows.
export function windowsToolDirs(): string[] {
  const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const roaming = env.APPDATA || path.join(home, "AppData", "Roaming");
  const programs = env.ProgramFiles || "C:\\Program Files";
  const python = ["313", "312", "311", "310"].flatMap((v) => [
    path.join(local, "Programs", "Python", `Python${v}`),
    path.join(local, "Programs", "Python", `Python${v}`, "Scripts"),
  ]);
  return [
    path.join(home, ".local", "bin"),
    path.join(local, "Microsoft", "WinGet", "Links"),
    path.join(local, "Microsoft", "WindowsApps"),
    path.join(programs, "Git", "cmd"),
    path.join(programs, "nodejs"),
    path.join(programs, "PowerShell", "7"),
    ...python,
    path.join(roaming, "npm"),
  ];
}

// Find a command the way Windows does: each PATH folder, each extension. Returns the full path.
export function resolveWindowsCommand(command: string, searchPath: string, pathExt = env.PATHEXT || ".COM;.EXE;.BAT;.CMD"): string | null {
  const hasDir = /[\\/]/.test(command);
  const exts = path.extname(command) ? [""] : ["", ...pathExt.split(";").filter(Boolean)];
  const dirs = hasDir ? [""] : searchPath.split(";").filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = dir ? path.join(dir, command + ext) : command + ext;
      // A bare name with no extension is not runnable on Windows (npm ships such files for Unix).
      if (!ext && !path.extname(candidate)) continue;
      if (commandFileExists(candidate)) return candidate;
    }
  }
  return null;
}

export function isBatchFile(file: string) {
  return /\.(cmd|bat)$/i.test(file);
}

// One argument for cmd.exe: quoted when it holds a space or a character cmd would act on.
export function quoteForCmd(value: string) {
  if (value !== "" && !/[\s"&|<>^()%!,;=]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

// One argument for PowerShell, as a literal string.
export function quoteForPowerShell(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

export function versionParts(text: string): [number, number] {
  const match = /(\d+)\.(\d+)/.exec(text);
  return match ? [Number(match[1]), Number(match[2])] : [0, 0];
}

export type Runner = (cmd: string, args: string[], options?: { timeoutMs?: number; cwd?: string }) => Promise<{ code: number; out: string }>;

const firstLine = (text: string) => text.split("\n")[0]?.trim() ?? "";

// The same facts scripts/setup/preflight.sh prints on a Mac, read on Windows.
export async function windowsPreflight(run: Runner, folders: string[]): Promise<Record<string, string>> {
  const facts: Record<string, string> = { platform: `Windows ${env.PROCESSOR_ARCHITECTURE ?? ""}`.trim(), "developer-tools": "ok" };
  const version = async (cmd: string, args: string[]) => {
    const result = await run(cmd, args, { timeoutMs: 20000 });
    return result.code === 0 ? firstLine(result.out) : "";
  };

  // Each check starts a process, which is slow on Windows; run them together.
  const [git, node, pwsh, pythonDirect, op, claude] = await Promise.all([
    version("git", ["--version"]),
    version("node", ["--version"]),
    version("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"]),
    version("python", ["--version"]),
    version("op", ["--version"]),
    version("claude", ["--version"]),
  ]);
  facts.git = git ? `ok ${git.replace(/^git version\s*/, "")}` : "missing";

  if (!node) facts.node = "missing";
  else facts.node = [22, 24].includes(versionParts(node)[0]) ? `ok ${node}` : `needs-attention ${node} (Node 22 or 24 is required)`;

  if (!pwsh) facts.powershell = "missing";
  else facts.powershell = versionParts(pwsh)[0] >= 7 ? `ok ${pwsh}` : `needs-attention ${pwsh}`;

  // The Microsoft Store placeholder answers "python" without being Python, so ask for a version.
  const python = /Python \d/.test(pythonDirect) ? pythonDirect : await version("py", ["-3", "--version"]);
  if (!/Python \d/.test(python)) facts.python = "missing";
  else {
    const [major, minor] = versionParts(python);
    const shown = python.replace(/^Python\s*/, "");
    facts.python = major === 3 && minor >= 10 ? `ok ${shown}` : `needs-attention ${shown} (Python 3.10 or later is required)`;
  }

  facts["1password-cli"] = op ? `ok ${op}` : "missing";

  if (claude) {
    facts["claude-code"] = `ok ${claude.split(" ")[0]}`;
    const status = await run("claude", ["auth", "status"], { timeoutMs: 30000 });
    try {
      const parsed = JSON.parse(status.out) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
      facts["claude-signed-in"] = String(parsed.loggedIn ?? "");
      facts["claude-auth-method"] = parsed.authMethod ?? "";
      facts["claude-plan"] = parsed.subscriptionType ?? "";
    } catch {
      facts["claude-signed-in"] = "";
    }
  } else facts["claude-code"] = "missing";

  facts["paseo-app"] = "ok";

  const candidates = [
    "AgentOS", "manukora-agentos", path.join("Code", "manukora-agentos"), path.join("Code", "AgentOS"),
    path.join("Documents", "AgentOS"), path.join("Documents", "manukora-agentos"),
    path.join("Desktop", "AgentOS"), path.join("Desktop", "manukora-agentos"),
  ].map((rel) => path.join(home, rel));
  const found = [...candidates, ...folders].find(
    (dir) => existsSync(path.join(dir, "AGENTS.md")) && existsSync(path.join(dir, "aios-intake.md")),
  );
  facts["existing-agentos"] = found ?? "none";
  return facts;
}

// What winget calls each tool. Pinned to the major versions AgentOS supports.
export const WINGET_IDS: Record<string, string> = {
  git: "Git.Git",
  node: "OpenJS.NodeJS.22",
  powershell: "Microsoft.PowerShell",
  python: "Python.Python.3.12",
};

export function wingetArgs(tool: string) {
  const id = WINGET_IDS[tool];
  if (!id) throw new Error(`No Windows installer is known for ${tool}.`);
  return ["install", "--id", id, "--exact", "--silent", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"];
}

// winget reports "already installed" and "no newer version" with non-zero codes; both mean ready.
export function wingetSucceeded(result: { code: number; out: string }) {
  return result.code === 0 || /already installed|No available upgrade|No newer package/i.test(result.out);
}

export async function installWindowsTools(run: Runner, tools: string[]) {
  if ((await run("winget", ["--version"], { timeoutMs: 20000 })).code !== 0) {
    throw new Error(
      "Windows' own installer (winget) is not available on this PC. Open the Microsoft Store, update App Installer, then press Install them again. If that does not help, ask AI & Systems.",
    );
  }
  const failed: string[] = [];
  for (const tool of tools) {
    const result = await run("winget", wingetArgs(tool), { timeoutMs: 900000 });
    if (!wingetSucceeded(result)) failed.push(`${tool} (${firstLine(result.out.split("\n").filter(Boolean).slice(-1)[0] ?? "") || `code ${result.code}`})`);
  }
  if (failed.length) throw new Error(`Could not install: ${failed.join(", ")}. Windows may have asked for permission in another window. Try again, or ask AI & Systems.`);
}

// Anthropic's installer for Windows.
export const CLAUDE_INSTALL_ARGS = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://claude.ai/install.ps1 | iex"];
