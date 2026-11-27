// What AI & Systems standardises on. Editing this list and shipping a plugin update reaches everyone.
export const claudePlugins = [
  {
    id: "n8n-mcp-skills",
    title: "n8n skill pack",
    marketplace: "czlonkowski/n8n-skills",
    install: "n8n-mcp-skills@n8n-mcp-skills",
    when: "n8n",
  },
] as const;

// Paseo plugins that ship inside the AgentOS download. `source` is a folder in that download, so
// they need no GitHub access and update with AgentOS.
export const paseoPlugins: readonly { id: string; title: string; source: string }[] = [
  { id: "usage-meter", title: "Usage remaining", source: "paseo-plugins/usage-meter" },
  { id: "awaiting-you", title: "Awaiting you", source: "paseo-plugins/awaiting-you" },
  { id: "skills-library", title: "Skills library", source: "paseo-plugins/skills-library" },
  { id: "keep-awake", title: "Keep awake while agents work", source: "paseo-plugins/keep-awake" },
];

// Cin7 is not offered (25 Nov 2026): its connector can write, and the Cin7 data people need is in
// DataHub (org) and DataHub Finance. Its sign-ins are limited to a few named people who make changes.
export const roleConnectors = ["Shopify", "Klaviyo", "Gorgias"] as const;

export const coreConnectors = [
  "Notion",
  "Slack",
  "Gmail",
  "Google Calendar",
  "Google Drive",
  "Grain",
  // Open to everyone since Scott connected DataHub's WorkOS sign-in to the whole organisation (12 Nov 2026).
  "DataHub (org)",
] as const;
