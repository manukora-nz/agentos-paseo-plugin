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
