// One-off Windows compatibility check for the AgentOS Paseo plugin. Read-only: it runs version
// commands and lists file names. It prints no tokens or environment values.
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
process.env.PASEO_HOME = path.join(os.tmpdir(), "agentos-e2e.win3", "paseo-home");
const { windowsPreflight, windowsToolDirs, resolveWindowsCommand, isWindows, wingetArgs } = await import("./server/windows");
const { run, toolEnvironment, paseoCli, home, paseoHome, defaultFolder, expandHome } = await import("./server/util");
const out: Record<string, unknown> = { isWindows, node: process.version, os: os.release(), arch: process.arch, home, paseoHome, defaultFolder: defaultFolder(), expandHome: expandHome("~/AgentOS") };
const env = toolEnvironment();
out.pathSeparatorOk = typeof env.PATH === "string" && env.PATH.includes(";") && !("Path" in env);
out.toolDirsExisting = windowsToolDirs().map((d) => [d, fs.existsSync(d)]);
for (const name of ["git", "node", "pwsh", "powershell", "python", "py", "winget", "claude", "npm", "codex", "paseo", "rundll32"]) {
  out[`resolve:${name}`] = resolveWindowsCommand(name, env.PATH ?? "");
}
const ran: Record<string, unknown> = {};
const cases: [string, string[]][] = [
  ["git", ["--version"]], ["node", ["--version"]],
  ["pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]],
  ["powershell", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]],
  ["python", ["--version"]], ["winget", ["--version"]], ["claude", ["--version"]], ["npm", ["--version"]],
];
for (const [name, args] of cases) {
  const r = await run(name, args, { timeoutMs: 40000 });
  ran[`${name} ${args[0]}`] = { code: r.code, out: r.out.slice(0, 160) };
}
const auth = await run("claude", ["auth", "status"], { timeoutMs: 40000 });
try {
  const a = JSON.parse(auth.out);
  ran["claude auth status"] = { code: auth.code, loggedIn: a.loggedIn, plan: a.subscriptionType, manukoraEmail: /@manukora\.com$/i.test(a.email ?? "") };
} catch {
  ran["claude auth status"] = { code: auth.code, out: auth.out.slice(0, 120) };
}
out.ran = ran;
// A .cmd shim with an argument that holds a space and an ampersand must stay one argument.
const spaced = await run("npm", ["help-search", "a b&c"], { timeoutMs: 40000 });
out.cmdQuoting = { code: spaced.code, out: spaced.out.slice(0, 160) };
out.preflight = await windowsPreflight(run as never, []);
out.wingetArgs = wingetArgs("node").join(" ");
// Where the Paseo desktop app keeps its command line tool.
const local = process.env.LOCALAPPDATA ?? "";
const roots = [path.join(local, "Programs"), local, process.env.ProgramFiles ?? ""].filter(Boolean);
const installs: unknown[] = [];
for (const root of roots) {
  let names: string[] = [];
  try { names = fs.readdirSync(root); } catch { continue; }
  for (const name of names.filter((n) => /paseo/i.test(n))) {
    const dir = path.join(root, name);
    const resources = path.join(dir, "resources");
    const bin = path.join(resources, "bin");
    const list = (d: string) => { try { return fs.readdirSync(d).slice(0, 40); } catch { return null; } };
    installs.push({ dir, top: list(dir), resources: list(resources), bin: list(bin) });
    for (const cli of ["paseo.cmd", "paseo.exe", "paseo"]) {
      const file = path.join(bin, cli);
      if (!fs.existsSync(file) || !/\.(cmd|exe)$/i.test(file)) continue;
      const v = await run(file, ["--version"], { timeoutMs: 30000 });
      const ls = await run(file, ["plugin", "ls"], { timeoutMs: 30000, extraEnvironment: { PASEO_HOME: path.join(os.homedir(), ".paseo") } });
      installs.push({ cli: file, version: { code: v.code, out: v.out.slice(0, 80) }, pluginLs: { code: ls.code, firstWords: ls.out.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean).slice(0, 15) } });
      break;
    }
  }
}
out.paseoInstalls = installs;
out.paseoCliFromScript = paseoCli();
console.log(JSON.stringify(out, null, 2));
