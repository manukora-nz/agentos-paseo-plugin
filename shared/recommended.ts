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
];

export const roleConnectors = ["Shopify", "Cin7", "Klaviyo", "Gorgias", "DataHub"] as const;

export const coreConnectors = [
  "Notion",
  "Slack",
  "Gmail",
  "Google Calendar",
  "Google Drive",
  "Grain",
] as const;
