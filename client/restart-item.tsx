import { useEffect, useState } from "react";
import { type PluginSidebarItemProps, useRpc } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { getRestart } from "../shared/contracts";
import { listNames } from "./restart-copy";

const CHECK_MS = 15000;
// A result older than this (polls hanging or failing) is not shown.
const STALE_MS = 45000;

// "Restart Paseo to finish setup" in the sidebar footer, so it is seen from any chat, not only on the
// setup page. Shows nothing when no restart is waiting; pressing it opens the setup page, which says
// whether to restart now or once the other steps are done.
export function RestartItem({ openScreen }: PluginSidebarItemProps) {
  const read = useRpc(getRestart);
  const [view, setView] = useState<{ needed: boolean; names: string[]; now: boolean; at: number } | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    let inFlight = false;
    // One request at a time; on a failed read show nothing rather than an old instruction.
    const check = () => {
      if (inFlight) return;
      inFlight = true;
      read({})
        .then((next) => live && setView({ ...next, at: Date.now() }))
        .catch(() => live && setView(null))
        .finally(() => {
          inFlight = false;
        });
    };
    check();
    // Re-render on each tick too, so a result that has gone stale is hidden even while a poll hangs.
    const timer = setInterval(() => {
      setTick((n) => n + 1);
      check();
    }, CHECK_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [read]);
  if (!view?.needed || Date.now() - view.at > STALE_MS) return null;
  const label = view.names.length
    ? `Restart Paseo to finish: ${listNames(view.names)}`
    : "Restart Paseo to finish setup";
  return <SidebarRow icon="RotateCw" label={label} onPress={() => openScreen({ screenId: "setup" })} />;
}
