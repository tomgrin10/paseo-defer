import type { PluginClientContext, PluginSidebarContribution, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useEffect } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { displayPreferences, displayRpc } from "../shared/display";
import { sidebarVisibility } from "./sidebar-visibility";

const listeners = new Set<(visible: boolean) => void>();

function DisplaySettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(displayPreferences);
  const visible = settings.status === "ready" ? settings.values.showSidebar : undefined;
  useEffect(() => {
    if (visible !== undefined) for (const listener of listeners) listener(visible);
  }, [visible]);

  if (settings.status === "loading") return <ActivityIndicator accessibilityLabel="Loading display settings" color={theme.colors.foregroundMuted} />;
  if (settings.status !== "ready") return (
    <View style={{ gap: 12 }}>
      <Text style={{ color: theme.colors.statusDanger }}>{settings.error}</Text>
      <SettingsCard>
        <SettingsAction label="Try loading the saved settings again" actionLabel="Retry" onPress={() => void settings.reload()} />
        {settings.status === "invalid" && <SettingsAction label="Replace invalid display settings with defaults" actionLabel="Reset" disabled={settings.saving} onPress={() => void settings.reset()} />}
      </SettingsCard>
      {settings.saveError && <Text style={{ color: theme.colors.statusDanger }}>{settings.saveError}</Text>}
    </View>
  );

  return (
    <SettingsSection title="Navigation">
      <SettingsCard>
        <SettingsSwitch
          label="Show in sidebar"
          hint="Open this plugin from Command-K (Ctrl-K on Windows and Linux) while viewing a workspace or plugin on this host."
          value={settings.values.showSidebar}
          disabled={settings.saving}
          onValueChange={(showSidebar) => void settings.save({ ...settings.values, showSidebar }, settings.revision)}
        />
      </SettingsCard>
      {settings.saveError && <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{settings.saveError}</Text>}
    </SettingsSection>
  );
}

/** Settings notifications reach mounted screens; poll for changes made on other clients. */
export function contributeDisplay(client: PluginClientContext, item: PluginSidebarContribution) {
  const sidebar = sidebarVisibility(() => client.addSidebarItem(item));
  // Paseo 0.10.1 memoizes sidebar route resolution when an installation mounts.
  // Register synchronously, then reconcile the saved preference, so that an
  // already-open sidebar route can resolve its surface during that first render.
  sidebar.set(true);
  const removeSettings = client.addSettingsScreen({ id: "display", title: "Display", icon: "PanelLeft", Component: DisplaySettings });
  const removeCommand = client.addCommandCenterItem({
    id: "display-settings",
    title: `${item.title}: sidebar settings`,
    icon: "PanelLeft",
    keywords: [item.title, "sidebar", "show", "hide", "display", "settings"],
    context: "global",
    onSelect({ openSettings }) { openSettings("display"); },
  });
  let disposed = false;
  let pending = false;
  let generation = 0;
  const update = (visible: boolean) => { generation += 1; sidebar.set(visible); };
  listeners.add(update);
  const refresh = async () => {
    if (disposed || pending) return;
    pending = true;
    const currentGeneration = generation;
    try {
      const result = await client.rpc(displayRpc.read, {});
      if (!disposed && generation === currentGeneration && result.status === "ready") {
        const parsed = displayPreferences.schema.safeParse(result.values);
        if (parsed.success) sidebar.set(parsed.data.showSidebar);
      }
    } catch {
      // Retain the last valid preference through temporary disconnects.
    } finally { pending = false; }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), 5000);
  return () => {
    disposed = true;
    clearInterval(timer);
    listeners.delete(update);
    sidebar.dispose();
    removeSettings();
    removeCommand();
  };
}
