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

export const paseoPlugins: readonly { id: string; title: string; source: string }[] = [];

export const roleConnectors = ["Shopify", "Cin7", "Klaviyo", "Gorgias", "DataHub"] as const;

export const coreConnectors = [
  "Notion",
  "Slack",
  "Gmail",
  "Google Calendar",
  "Google Drive",
  "Grain",
] as const;
