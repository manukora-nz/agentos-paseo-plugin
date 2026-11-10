import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { SetupScreen } from "./client/setup-screen";

function SetupItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Sparkles"
      active={currentScreen?.screenId === "setup"}
      onPress={() => openScreen({ screenId: "setup" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "setup", title: "AgentOS setup", Component: SetupScreen });
  client.addSidebarHeaderItem({ id: "setup", title: "AgentOS setup", Component: SetupItem });
  client.addCommandCenterItem({
    id: "open-setup",
    title: "Open AgentOS setup",
    icon: "Sparkles",
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "setup" });
    },
  });
  client.addTheme({
    id: "manukora-light",
    name: "Manukora",
    appearance: "light",
    colors: {
      background: "#F4F2EC",
      foreground: "#231F20",
      raised: "#FBF7EC",
      control: "#FFEBA2",
      border: "#D9D4C7",
      accent: "#F6BE00",
      mutedForeground: "#5B3427",
      ring: "#F6BE00",
    },
  });
  client.addTheme({
    id: "manukora-dark",
    name: "Manukora Dark",
    appearance: "dark",
    colors: {
      background: "#231F20",
      foreground: "#F4F2EC",
      raised: "#403B39",
      control: "#403B39",
      border: "#5B3427",
      accent: "#F6BE00",
      mutedForeground: "#FFE1BD",
      ring: "#F6BE00",
    },
  });
  return () => {};
}
