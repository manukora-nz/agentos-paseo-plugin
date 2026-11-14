import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { identityToken, signedInEmail } from "./google";
import { loadService } from "./source";
import { exists, loadState, run, serviceFile, sourceDir, stateDir } from "./util";

// Keeps <PASEO_HOME>/manukora-agentos/skill-inbox.json current for the Skills library's "Shared with
// you" section. Never installs anything.
//
// The helper that does the work runs from the Manukora release this plugin downloaded itself
// (sourceDir), never from the person's AgentOS folder: that folder can be edited by anyone or
// anything working in it, and the helper runs with the person's sign-in. The AgentOS folder is only
// passed as data to read for the readiness check.
let running = false;

const inboxFile = () => path.join(stateDir(), "skill-inbox.json");

async function fileAccount(): Promise<string> {
  try {
    return String(JSON.parse(await readFile(inboxFile(), "utf8")).account || "");
  } catch {
    return "";
  }
}

export async function refreshInbox() {
  if (running) return;
  running = true;
  try {
    const email = await signedInEmail();
    // Nobody signed in, or someone else now: the old list must not be shown.
    if (!email || (await fileAccount()) !== email) await rm(inboxFile(), { force: true });
    if (!email) return;
    const state = await loadState();
    const folder = state.folder;
    if (!folder) return;
    const script = path.join(sourceDir(), "scripts", "skill-share-service.cjs");
    if (!(await exists(script)) || !(await exists(serviceFile()))) return;
    const clientId = (await loadService())?.identity?.clientId;
    const token = clientId ? await identityToken(clientId) : "";
    if (!token) return;
    await run("node", [script, "inbox", "--root", folder, "--write", inboxFile()], {
      cwd: sourceDir(),
      timeoutMs: 120000,
      extraEnvironment: {
        AGENTOS_SERVICE_FILE: serviceFile(),
        AGENTOS_IDENTITY_TOKEN: token,
        AGENTOS_CONNECTOR_STATUS: path.join(stateDir(), "connector-status.json"),
      },
    });
  } catch {
    // The list stays as it was (the reader shows it as stale after a day); the next refresh tries again.
  } finally {
    running = false;
  }
}

export function keepInboxFresh(): () => void {
  const first = setTimeout(() => void refreshInbox(), 60 * 1000);
  const every = setInterval(() => void refreshInbox(), 15 * 60 * 1000);
  first.unref?.();
  every.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
