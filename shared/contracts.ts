import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const StepInput = z.object({
  key: z.string(),
  label: z.string(),
  secret: z.boolean().default(false),
  value: z.string().default(""),
});

export const Step = z.object({
  id: z.string(),
  group: z.string(),
  title: z.string(),
  detail: z.string(),
  status: z.enum(["done", "todo", "needs-you", "working", "skipped", "failed", "waiting"]),
  actionLabel: z.string().optional(),
  link: z.string().optional(),
  skippable: z.boolean().default(false),
  repeatable: z.boolean().default(false),
  inputs: z.array(StepInput).default([]),
});
export type Step = z.infer<typeof Step>;

export const StatusResult = z.object({
  steps: z.array(Step),
  folder: z.string(),
  workspaceId: z.string().optional(),
  restartNeeded: z.boolean(),
  // What is waiting on the restart, by name; whether to restart now (later steps need it) or once the
  // other steps are done; and what the last restart picked up (shown for a few minutes afterwards).
  restartFor: z.array(z.string()).optional(),
  restartNow: z.boolean().optional(),
  restartPickedUp: z.array(z.string()).optional(),
  // Finished steps whose change takes effect only after the restart (shown as "Waiting for restart").
  restartSteps: z.array(z.string()).optional(),
  // True while a step is running in a chat or terminal, so the page checks more often.
  watching: z.boolean().optional(),
});
export type StatusResult = z.infer<typeof StatusResult>;

export const getStatus = defineRpc({
  name: "setup.status",
  input: z.object({ refresh: z.boolean().default(false) }),
  output: StatusResult,
});

export const runStep = defineRpc({
  name: "setup.run",
  input: z.object({ stepId: z.string(), values: z.record(z.string(), z.string()).default({}) }),
  output: z.object({
    message: z.string(),
    workspaceId: z.string().optional(),
    agentId: z.string().optional(),
  }),
});

export const skipStep = defineRpc({
  name: "setup.skip",
  input: z.object({ stepId: z.string(), skipped: z.boolean() }),
  output: z.object({ ok: z.boolean() }),
});

export const sendReport = defineRpc({
  name: "setup.report",
  input: z.object({ text: z.string().min(1).max(4000) }),
  output: z.object({
    message: z.string(),
    agentId: z.string().optional(),
    workspaceId: z.string().optional(),
  }),
});

export const checkUpdates = defineRpc({
  name: "setup.updates.check",
  input: z.object({}),
  output: z.object({ text: z.string() }),
});

export const applyUpdates = defineRpc({
  name: "setup.updates.apply",
  input: z.object({}),
  output: z.object({ text: z.string() }),
});

// A light read for the sidebar: is a restart waiting, and for what. No checks run.
export const getRestart = defineRpc({
  name: "setup.restart",
  input: z.object({}).default({}),
  output: z.object({ needed: z.boolean(), names: z.array(z.string()), now: z.boolean() }),
});
