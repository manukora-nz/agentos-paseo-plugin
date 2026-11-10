import type { PluginServerContext } from "@getpaseo/plugin/server";
import { identityToken } from "./server/google";
import { loadService, refreshSource } from "./server/source";
import { bundleFile, exists, serviceFile } from "./server/util";
import {
  applyUpdates,
  checkUpdates,
  getStatus,
  runStep,
  sendReport,
  skipStep,
} from "./shared/contracts";
import {
  report,
  runAction,
  setSkip,
  status,
  updatesApply,
  updatesCheck,
  type Paseo,
} from "./server/engine";

export default function contribute(server: PluginServerContext) {
  server.handle(getStatus, ({ refresh }) => status(refresh));
  server.handle(runStep, ({ stepId, values }, { paseo }) =>
    runAction(paseo as unknown as Paseo, stepId, values),
  );
  server.handle(skipStep, ({ stepId, skipped }) => setSkip(stepId, skipped));
  server.handle(sendReport, ({ text }, { paseo }) => report(paseo as unknown as Paseo, text));
  server.handle(checkUpdates, () => updatesCheck());
  server.handle(applyUpdates, () => updatesApply());
  // Every agent finds the latest downloaded AgentOS release here, so updates and the scheduled
  // tune-up need no GitHub access.
  server.before("agent.session_open", async ({ request }) => {
    // Check the service first (at most hourly, never throws), so a scheduled tune-up gets the
    // latest release even if nobody has opened the setup screen. Wait at most 20 seconds: a slow
    // service must not hold up ordinary agents, which then use the release already downloaded.
    await Promise.race([refreshSource(), new Promise((resolve) => setTimeout(resolve, 20000).unref?.())]);
    const env: Record<string, string> = { ...request.env };
    if (await exists(bundleFile())) env.AGENTOS_UPDATE_SOURCE = bundleFile();
    if (await exists(serviceFile())) {
      env.AGENTOS_SERVICE_FILE = serviceFile();
      // A signed-in person's ID token (at least 10 minutes left), so /report in chat files under them.
      const clientId = (await loadService())?.identity?.clientId;
      const token = clientId ? await identityToken(clientId) : "";
      if (token) env.AGENTOS_IDENTITY_TOKEN = token;
    }
    return { ...request, env };
  });
  return () => {};
}
