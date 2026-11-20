// The words for "quit and reopen Paseo", shared by the setup page banner and the sidebar notice.
export const onWindows = () =>
  typeof navigator !== "undefined" && /Win/i.test(navigator.platform || navigator.userAgent || "");

export const quitHow = () =>
  onWindows()
    ? "Fully quit Paseo (right-click its icon in the taskbar tray and choose Quit) and open it again."
    : "Fully quit Paseo with Command-Q and open it again.";

// "the AgentOS plugins, Slack drafts and your Claude sign-in"
export function listNames(names: string[]) {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function restartBanner(names: string[] = [], now = false) {
  const when = now
    ? "Restart Paseo now: the next steps need it."
    : "Restart Paseo once, when you have finished the other steps.";
  const what = names.length ? ` Waiting on it: ${listNames(names)}.` : "";
  return `${when}${what} ${quitHow()} Your progress is saved.`;
}

export function pickedUpNotice(names: string[] = []) {
  return names.length ? `Paseo restarted for ${listNames(names)}. If a step still looks unfinished, press Check again.` : "";
}
