import type { PluginClientContext, PluginSidebarItemProps, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSelect, SettingsSwitch, SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { DEFAULT_SETTINGS, listDeferred, updateSettings, type PillMode } from "../shared/defer";
import { displayPreferences, displayRpc } from "../shared/display";
import { pillLabel } from "../shared/format";
import { errorText, useNow } from "./kit";
import { useLiveQueue, type LiveQueue } from "./live";
import { notifyDeferChanged } from "./refresh";
import { sidebarVisibility } from "./sidebar-visibility";
import { tabular } from "./theme";

type Display = import("zod").infer<typeof displayPreferences.schema>;
const listeners = new Set<(values: Display) => void>();
export function subscribeDisplay(listener: (values: Display) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

/** The screen the sidebar row and ⌘K open. */
export const OVERVIEW_SCREEN = "overview";

type PillChoice = PillMode | "off";
const PILL_CHOICES: { value: PillChoice; label: string; hint: string }[] = [
  { value: "always", label: "Every session", hint: "Every session's composer has a Defer button, which shows the next send once that session has a queue." },
  { value: "waiting", label: "Only while messages wait", hint: "The Defer button appears only on sessions with something queued." },
  { value: "off", label: "Off", hint: "No pill. ⌘K Defer a message and /defer still work." },
];

/**
 * Where Defer shows up. The composer pill choice spans two stores: hiding the
 * pill is a host display preference (shared by every button-bearing plugin in
 * the family), while "every session or only while waiting" is Defer's own
 * setting. One control writes whichever it needs.
 */
function DisplaySettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(displayPreferences);
  const list = useRpc(listDeferred);
  const savePill = useRpc(updateSettings);
  const queryClient = useQueryClient();
  const prefs = useQuery({ queryKey: ["defer", "prefs"], queryFn: () => list({}) });
  const [pillProblem, setPillProblem] = useState<string | null>(null);
  const [pendingMode, setPendingMode] = useState<PillMode | null>(null);
  const values = settings.status === "ready" ? settings.values : undefined;
  useEffect(() => {
    if (values !== undefined) for (const listener of listeners) listener(values);
  }, [values]);

  if (settings.status === "loading") return <ActivityIndicator accessibilityLabel="Loading Defer settings" color={theme.colors.foregroundMuted} />;
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

  const mode = pendingMode ?? (prefs.data?.settings ?? DEFAULT_SETTINGS).pillMode;
  const pill: PillChoice = settings.values.enable_composer_button ? mode : "off";
  const choice = PILL_CHOICES.find((option) => option.value === pill) ?? PILL_CHOICES[0];

  async function choosePill(next: PillChoice) {
    if (next === pill || settings.status !== "ready") return;
    setPillProblem(null);
    const enable = next !== "off";
    if (enable !== settings.values.enable_composer_button) {
      await settings.save({ ...settings.values, enable_composer_button: enable }, settings.revision);
    }
    if (next !== "off" && next !== mode) {
      setPendingMode(next);
      try {
        await savePill({ pillMode: next });
        await queryClient.invalidateQueries({ queryKey: ["defer", "prefs"] });
        notifyDeferChanged();
      } catch (error) {
        setPillProblem(errorText(error));
      } finally {
        setPendingMode(null);
      }
    }
  }

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 16 }}>
      <SettingsSection title="Where Defer appears" info="⌘K Defer a message and /defer work whatever you hide here.">
        <SettingsCard>
          <SettingsSelect
            label="Composer button"
            hint={choice.hint}
            value={pill}
            options={PILL_CHOICES.map(({ value, label }) => ({ value, label }))}
            disabled={settings.saving || pendingMode !== null}
            onValueChange={(next) => void choosePill(next)}
          />
          <SettingsSwitch
            label="Sidebar row"
            hint="Deferred, with the next send time. Opens every queued message across sessions."
            value={settings.values.showSidebar}
            disabled={settings.saving}
            onValueChange={(showSidebar) => void settings.save({ ...settings.values, showSidebar }, settings.revision)}
          />
        </SettingsCard>
        {settings.saveError && <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{settings.saveError}</Text>}
        {pillProblem && <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{pillProblem}</Text>}
      </SettingsSection>
    </ScrollView>
  );
}

/** Settings notifications reach mounted screens; poll for changes made on other clients. */
export function contributeDisplay(client: PluginClientContext, live: LiveQueue) {
  function DeferredSidebarItem({ currentScreen, openScreen, theme }: PluginSidebarItemProps) {
    useLiveQueue(live);
    const now = useNow(30_000);
    const label = pillLabel(live.waiting(), now);
    return (
      <SidebarRow
        icon="Clock"
        active={currentScreen?.screenId === OVERVIEW_SCREEN}
        onPress={() => openScreen({ screenId: OVERVIEW_SCREEN })}
        trailing={label === "" ? undefined : (
          <Text accessibilityLabel={`Next: ${label}`} numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 16, ...tabular }}>{label}</Text>
        )}
      />
    );
  }

  const sidebar = sidebarVisibility(() => client.addSidebarHeaderItem({ id: "defer-overview", title: "Deferred", Component: DeferredSidebarItem }));
  // Paseo 0.10.1 memoizes sidebar route resolution when an installation mounts.
  // Register synchronously, then reconcile the saved preference, so that an
  // already-open sidebar route can resolve its screen during that first render.
  sidebar.set(true);
  const removeSettings = client.addSettingsScreen({ id: "display", title: "Display", icon: "PanelLeft", Component: DisplaySettings });
  const removeCommand = client.addCommandCenterItem({
    id: "display-settings",
    title: "Defer: settings",
    icon: "Settings",
    keywords: ["Deferred", "sidebar", "pill", "composer", "show", "hide", "display", "settings"],
    context: "global",
    onSelect({ openSettings }) { openSettings("display"); },
  });
  let disposed = false;
  let pending = false;
  let generation = 0;
  const update = (values: Display) => { generation += 1; sidebar.set(values.showSidebar); };
  listeners.add(update);
  const refresh = async () => {
    if (disposed || pending) return;
    pending = true;
    const currentGeneration = generation;
    try {
      const result = await client.rpc(displayRpc.read, {});
      if (!disposed && generation === currentGeneration && result.status === "ready") {
        const parsed = displayPreferences.schema.safeParse(result.values);
        if (parsed.success) { sidebar.set(parsed.data.showSidebar); for (const listener of listeners) listener(parsed.data); }
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
