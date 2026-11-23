import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isWindows } from "./windows";
import { testMode } from "./util";

// Where Connect Slack keeps the Slack web session (Connect Slack, AIS-479). One item in the macOS
// Keychain or Windows Credential Manager, read only by the drafts helper (scripts/slack_session.py)
// when it starts. Never an environment variable, a shell profile or .env. The value always reaches
// the store over stdin, never on a command line, and is never printed.

export const STORE_SERVICE = "agentos.slack-session";
export const STORE_ACCOUNT = "slack-drafts";

export interface SlackSession {
  xoxc: string;
  xoxd: string;
  teamId: string;
  userId: string;
  user: string;
  domain: string;
  savedAt: string;
}

type Exec = (cmd: string, args: string[], input?: string) => Promise<{ code: number; out: string }>;

const exec: Exec = (cmd, args, input) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", () => undefined);
    const timer = setTimeout(() => child.kill(), 30000);
    child.stdin.on("error", () => undefined);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, out: "" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out });
    });
    child.stdin.end(input ?? "");
  });

// Windows: Credential Manager through the Win32 API. The script holds no secret; the value comes on
// stdin and goes back on stdout only for "read".
// No [Console]::InputEncoding / OutputEncoding: a hidden powershell.exe started without a console
// throws on those setters. stdin and stdout are read and written as UTF-8 streams instead.
export const WINDOWS_CRED_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false)
$op = $args[0]; $target = $args[1]
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class AgentOSCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL { public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public UInt32 CredentialBlobSize; public IntPtr CredentialBlob;
    public UInt32 Persist; public UInt32 AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredWrite(ref CREDENTIAL c, UInt32 flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr c);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
  // The last-error code is read here, right after the call, before PowerShell can overwrite it.
  public static bool Delete(string target) { if (CredDelete(target, 1, 0)) return true; return Marshal.GetLastWin32Error() == 1168; }
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr p);
  public static void Write(string target, string secret) {
    byte[] b = Encoding.UTF8.GetBytes(secret); var c = new CREDENTIAL(); c.Type = 1; c.TargetName = target; c.UserName = "AgentOS"; c.Persist = 2;
    c.CredentialBlobSize = (UInt32)b.Length; c.CredentialBlob = Marshal.AllocHGlobal(b.Length);
    try { Marshal.Copy(b, 0, c.CredentialBlob, b.Length); if (!CredWrite(ref c, 0)) throw new System.ComponentModel.Win32Exception(); }
    finally { Marshal.FreeHGlobal(c.CredentialBlob); } }
  // Null only for "not found" (1168); any other failure is an error, never "nothing saved".
  public static string Read(string target) { IntPtr p; if (!CredRead(target, 1, 0, out p)) {
      int err = Marshal.GetLastWin32Error(); if (err == 1168) return null; throw new System.ComponentModel.Win32Exception(err); }
    try { var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); byte[] b = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, b, 0, b.Length); return Encoding.UTF8.GetString(b); } finally { CredFree(p); } }
}
"@
switch ($op) {
  'write'  { $v = [IO.StreamReader]::new([Console]::OpenStandardInput(), $utf8).ReadToEnd(); if ([Text.Encoding]::UTF8.GetByteCount($v) -gt 2560) { exit 4 }; [AgentOSCred]::Write($target, $v) }
  'read'   { $v = [AgentOSCred]::Read($target); if ($null -eq $v) { exit 3 }; $w = [IO.StreamWriter]::new([Console]::OpenStandardOutput(), $utf8); $w.Write($v); $w.Flush() }
  'exists' { if ($null -eq [AgentOSCred]::Read($target)) { exit 3 } }
  'delete' { if (-not [AgentOSCred]::Delete($target)) { exit 5 } }
}
`;

async function windowsCred(op: string, input?: string, run: Exec = exec) {
  // A private folder per call, so a status read can never remove a script a save is about to run.
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentos-cred-"));
  const script = path.join(dir, "cred.ps1");
  await writeFile(script, WINDOWS_CRED_SCRIPT, "utf8");
  try {
    return await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, op, STORE_SERVICE], input);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Test mode only: a 0600 file inside the throwaway test home, so tests never touch a real Keychain.
const testFile = () => (testMode && process.env.AGENTOS_SLACK_STORE_FILE ? process.env.AGENTOS_SLACK_STORE_FILE : "");

// Printable ASCII only: `security -w` prints the stored bytes as hex when any is non-ASCII (a Slack name
// with an accent), which would not read back. JSON \u escapes round-trip in every reader.
export function encodeSession(session: SlackSession) {
  return JSON.stringify(session).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

// Disconnect leaves this marker instead of an empty store, so nothing falls back to an older plain
// copy (the drafts helper checks it on every request).
export const DISCONNECTED = JSON.stringify({ disconnected: true });

export function isDisconnectedMarker(text: string) {
  try {
    return (JSON.parse(text) as { disconnected?: unknown }).disconnected === true;
  } catch {
    return false;
  }
}

export function decodeSession(text: string): SlackSession | null {
  try {
    const s = JSON.parse(text) as Partial<SlackSession>;
    if (typeof s.xoxc === "string" && typeof s.xoxd === "string" && s.xoxc && s.xoxd) {
      return { xoxc: s.xoxc, xoxd: s.xoxd, teamId: s.teamId ?? "", userId: s.userId ?? "", user: s.user ?? "", domain: s.domain ?? "", savedAt: s.savedAt ?? "" };
    }
  } catch {}
  return null;
}

// Credential Manager blobs are limited to 2560 bytes; a session is far smaller, but say so plainly.
const MAX_BLOB = 2560;

export async function saveSession(session: SlackSession, run: Exec = exec) {
  const value = encodeSession(session);
  if (Buffer.byteLength(value, "utf8") > MAX_BLOB) throw new Error("That Slack session is larger than this computer's credential store allows. Nothing was changed.");
  // Never include the store tool's output: on failure it can echo the command it was given.
  if (!(await writeRaw(value, run))) throw new Error(`Could not save to your ${storeName()}. Nothing was changed.`);
  const back = await readStoredSession(run);
  if (back.state !== "ok" || encodeSession(back.session) !== value) {
    throw new Error(`Saved to your ${storeName()}, but reading it back did not match.`);
  }
}

export const storeName = () => (isWindows ? "Windows Credential Manager" : "Keychain");

export type StoredRead = { state: "ok"; session: SlackSession } | { state: "missing" } | { state: "disconnected" } | { state: "error" };

// "Nothing saved" and "could not read it" are different answers: a locked or broken store must never
// look like an empty one, or an identity check could be skipped.
export async function readStoredSession(run: Exec = exec): Promise<StoredRead> {
  const file = testFile();
  if (file) {
    const text = await readFile(file, "utf8").catch(() => null);
    if (text === null) return { state: "missing" };
    if (isDisconnectedMarker(text)) return { state: "disconnected" };
    const session = decodeSession(text);
    return session ? { state: "ok", session } : { state: "error" };
  }
  const result = isWindows
    ? await windowsCred("read", undefined, run)
    : await run("security", ["find-generic-password", "-s", STORE_SERVICE, "-a", STORE_ACCOUNT, "-w"]);
  // security: 44 = item not found. The Windows script: 3 = not found.
  if (result.code === (isWindows ? 3 : 44)) return { state: "missing" };
  if (result.code !== 0) return { state: "error" };
  if (isDisconnectedMarker(result.out.trim())) return { state: "disconnected" };
  const session = decodeSession(result.out.trim());
  return session ? { state: "ok", session } : { state: "error" };
}

export async function loadSession(run: Exec = exec): Promise<SlackSession | null> {
  const read = await readStoredSession(run);
  return read.state === "ok" ? read.session : null;
}

async function writeRaw(value: string, run: Exec) {
  const file = testFile();
  if (file) {
    await writeFile(file, value, { mode: 0o600 });
    await chmod(file, 0o600);
    return true;
  }
  const result = isWindows
    ? await windowsCred("write", value, run)
    : await run("security", ["-i"], `add-generic-password -U -s ${STORE_SERVICE} -a ${STORE_ACCOUNT} -l "AgentOS Slack drafts" -X ${Buffer.from(value, "utf8").toString("hex")}\n`);
  return result.code === 0;
}

// Replaces the session with the "disconnected" marker and proves it: a Disconnect that did not happen
// is never reported as done, and nothing can fall back to an older plain copy afterwards.
export async function markDisconnected(run: Exec = exec) {
  const ok = await writeRaw(DISCONNECTED, run);
  const after = await readStoredSession(run);
  if (!ok || after.state !== "disconnected") throw new Error(`Could not remove the Slack sign-in from your ${storeName()}. Try Disconnect again.`);
}

// Removes the item entirely (used to undo a first-time save that did not read back intact).
export async function deleteSession(run: Exec = exec) {
  const file = testFile();
  if (file) await rm(file, { force: true });
  else if (isWindows) await windowsCred("delete", undefined, run);
  else await run("security", ["delete-generic-password", "-s", STORE_SERVICE, "-a", STORE_ACCOUNT]);
  const after = await readStoredSession(run);
  if (after.state !== "missing") throw new Error(`Could not remove the Slack sign-in from your ${storeName()}.`);
}
