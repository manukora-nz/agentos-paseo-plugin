import { openExternalUrl, type PluginScreenProps, useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  applyUpdates,
  checkUpdates,
  getStatus,
  runStep,
  sendReport,
  skipStep,
  type StatusResult,
  type Step,
} from "../shared/contracts";

const marks: Record<Step["status"], string> = {
  done: "Done",
  todo: "Next",
  "needs-you": "Needs you",
  working: "Working",
  skipped: "Skipped",
  failed: "Problem",
  waiting: "Waiting",
};

const actionable: Step["status"][] = ["todo", "needs-you", "failed"];

export function SetupScreen({ theme, layout, navigation }: PluginScreenProps) {
  const fetchStatus = useRpc(getStatus);
  const run = useRpc(runStep);
  const skip = useRpc(skipStep);
  const report = useRpc(sendReport);
  const check = useRpc(checkUpdates);
  const apply = useRpc(applyUpdates);
  const [data, setData] = useState<StatusResult | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [reportText, setReportText] = useState("");
  const [reportNotice, setReportNotice] = useState("");
  const [updateText, setUpdateText] = useState("");
  const alive = useRef(true);
  const fetching = useRef(false);
  const latestRequest = useRef(0);

  const refresh = useCallback(
    async (force = false) => {
      if (fetching.current && !force) return;
      fetching.current = true;
      latestRequest.current += 1;
      const request = latestRequest.current;
      try {
        const next = await fetchStatus({ refresh: force });
        if (alive.current && request === latestRequest.current) {
          setData(next);
          setError("");
        }
      } catch (err) {
        if (alive.current) setError(String(err));
      } finally {
        fetching.current = false;
      }
    },
    [fetchStatus],
  );

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 30000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  // The first check can outlast Paseo's call limit; the server then answers "still checking".
  const stillChecking = data?.steps.some((s) => s.id === "still-checking") ?? false;
  useEffect(() => {
    if (!stillChecking) return;
    const soon = setTimeout(() => void refresh(), 5000);
    return () => clearTimeout(soon);
  }, [stillChecking, data, refresh]);

  const colors = theme.colors;
  const styles = useMemo(
    () => ({
      root: { flex: 1, backgroundColor: colors.surface0 },
      body: { padding: layout.compact ? 16 : 28, gap: 12 },
      h1: { color: colors.foreground, fontSize: 26, fontWeight: "600" as const },
      h2: { color: colors.foreground, fontSize: 17, fontWeight: "600" as const, marginTop: 14 },
      muted: { color: colors.foregroundMuted, fontSize: 14, lineHeight: 20 },
      text: { color: colors.foreground, fontSize: 15, fontWeight: "500" as const, flexShrink: 1 },
      card: {
        padding: 14,
        gap: 8,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
      },
      row: {
        flexDirection: "row" as const,
        justifyContent: "space-between" as const,
        gap: 10,
        alignItems: "center" as const,
      },
      actions: { flexDirection: "row" as const, gap: 8, flexWrap: "wrap" as const },
      primary: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: colors.accent },
      primaryText: { color: colors.accentForeground, fontSize: 14, fontWeight: "600" as const },
      quiet: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: colors.border },
      quietText: { color: colors.foreground, fontSize: 14 },
      input: { color: colors.foreground, borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 9, fontSize: 14 },
      banner: { padding: 14, borderRadius: 10, backgroundColor: colors.accent },
      bannerText: { color: colors.accentForeground, fontSize: 14, fontWeight: "600" as const },
    }),
    [colors, layout.compact],
  );

  async function act(step: Step) {
    setBusy(step.id);
    setNotice("");
    try {
      const entered: Record<string, string> = {};
      for (const input of step.inputs) entered[input.key] = values[step.id]?.[input.key] ?? input.value;
      const result = await run({ stepId: step.id, values: entered });
      setNotice(result.message);
      setValues((prev) => ({ ...prev, [step.id]: {} }));
      if (result.agentId) navigation?.openAgent?.({ agentId: result.agentId });
      else if (result.workspaceId) navigation?.openWorkspace?.({ workspaceId: result.workspaceId });
      if (step.link) void openExternalUrl(step.link);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
    setBusy("");
    void refresh();
  }

  async function submitReport() {
    const text = reportText.trim();
    if (!text) return;
    try {
      setReportNotice("Sending...");
      const result = await report({ text });
      setReportNotice(result.message);
      setReportText("");
      if (result.agentId) navigation?.openAgent?.({ agentId: result.agentId });
    } catch (err) {
      setReportNotice(err instanceof Error ? err.message : String(err));
    }
  }

  const groups = useMemo(() => {
    const map = new Map<string, Step[]>();
    for (const step of data?.steps ?? []) map.set(step.group, [...(map.get(step.group) ?? []), step]);
    return [...map.entries()];
  }, [data]);
  const remaining = data?.steps.filter((s) => s.status !== "done" && s.status !== "skipped").length ?? 0;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.body}>
      <Text style={styles.h1}>Set up AgentOS</Text>
      <Text style={styles.muted}>
        {!data
          ? "Checking your computer..."
          : remaining
            ? `${remaining} ${remaining === 1 ? "step" : "steps"} left. Work down the list. You can come back any time.`
            : "All done. AgentOS is ready."}
      </Text>
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" style={styles.quiet} onPress={() => void refresh(true)}>
          <Text style={styles.quietText}>Check again</Text>
        </Pressable>
      </View>
      {data?.restartNeeded ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>
            {(typeof navigator !== "undefined" && /Win/i.test(navigator.platform || navigator.userAgent || "")) ? "Fully quit Paseo (right-click its icon in the taskbar tray and choose Quit) and open it again so these changes take effect. Your progress is saved." : "Fully quit Paseo with Command-Q and open it again so these changes take effect. Your progress is saved."}
          </Text>
        </View>
      ) : null}
      {notice ? <Text style={styles.text}>{notice}</Text> : null}
      {error ? <Text style={styles.muted}>{error}</Text> : null}
      {groups.map(([group, steps]) => (
        <View key={group} style={{ gap: 8 }}>
          <Text style={styles.h2}>{group}</Text>
          {steps.map((step) => (
            <View key={step.id} style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.text}>{step.title}</Text>
                <Text style={styles.muted}>{marks[step.status]}</Text>
              </View>
              <Text selectable style={styles.muted}>
                {step.detail}
              </Text>
              {actionable.includes(step.status) || step.repeatable
                ? step.inputs.map((input) => (
                    <TextInput
                      key={input.key}
                      accessibilityLabel={input.label}
                      placeholder={input.label}
                      placeholderTextColor={colors.foregroundMuted}
                      secureTextEntry={input.secret}
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={styles.input}
                      value={values[step.id]?.[input.key] ?? input.value}
                      onChangeText={(text) =>
                        setValues((prev) => ({ ...prev, [step.id]: { ...prev[step.id], [input.key]: text } }))
                      }
                    />
                  ))
                : null}
              <View style={styles.actions}>
                {step.actionLabel && (actionable.includes(step.status) || step.repeatable) ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={step.actionLabel}
                    disabled={busy === step.id}
                    style={styles.primary}
                    onPress={() => void act(step)}
                  >
                    <Text style={styles.primaryText}>{busy === step.id ? "One moment..." : step.actionLabel}</Text>
                  </Pressable>
                ) : null}
                {(step.skippable && step.status !== "done") || (step.status === "skipped" && step.id !== "voice") ? (
                  <Pressable
                    accessibilityRole="button"
                    style={styles.quiet}
                    onPress={() =>
                      void skip({ stepId: step.id, skipped: step.status !== "skipped" }).then(() => refresh(true))
                    }
                  >
                    <Text style={styles.quietText}>{step.status === "skipped" ? "Bring back" : "Skip for now"}</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          ))}
        </View>
      ))}
      <Text style={styles.h2}>Something wrong, or an idea?</Text>
      <View style={styles.card}>
        <TextInput
          accessibilityLabel="Your report"
          placeholder="Tell AI & Systems what happened"
          placeholderTextColor={colors.foregroundMuted}
          multiline
          style={[styles.input, { minHeight: 70 }]}
          value={reportText}
          onChangeText={setReportText}
        />
        <View style={styles.actions}>
          <Pressable accessibilityRole="button" style={styles.primary} onPress={() => void submitReport()}>
            <Text style={styles.primaryText}>Send report</Text>
          </Pressable>
        </View>
        {reportNotice ? <Text selectable style={styles.muted}>{reportNotice}</Text> : null}
      </View>
      <Text style={styles.h2}>Updates</Text>
      <View style={styles.card}>
        <Text selectable style={styles.muted}>
          {updateText || "Check for fixes and improvements from AI & Systems."}
        </Text>
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            style={styles.quiet}
            onPress={() =>
              void check({})
                .then((r) => setUpdateText(r.text))
                .catch((e: unknown) => setUpdateText(String(e)))
            }
          >
            <Text style={styles.quietText}>Check</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            style={styles.quiet}
            onPress={() =>
              void apply({})
                .then((r) => setUpdateText(r.text))
                .catch((e: unknown) => setUpdateText(String(e)))
            }
          >
            <Text style={styles.quietText}>Install update</Text>
          </Pressable>
        </View>
      </View>
    </ScrollView>
  );
}
