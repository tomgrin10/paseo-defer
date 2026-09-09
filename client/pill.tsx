import { type PluginCleanup, type PluginTheme } from "@getpaseo/plugin";
import { type PluginClientContext, type PluginHostProps } from "@getpaseo/plugin/client";
import React, { type ComponentType, useCallback, useMemo, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { DEFAULT_SETTINGS, listDeferred, type Deferred, type PillMode } from "../shared/defer";
import { pillLabel, stateLabel } from "../shared/format";
import { onDeferChanged } from "./refresh";

/**
 * The composer pill: a "Defer" button above every live session's composer,
 * which turns into a status ("2 deferred", "in 12m") once that session has
 * something waiting.
 *
 * It is the plugin's only in-session UI slot. Paseo offers agent-context panels
 * nowhere in its chrome — the new-tab launcher lists workspace-context panels
 * only — so without a pill on every composer, deferring from inside a session
 * means ⌘K every time. Anyone who would rather keep the composer clear can set
 * `pillMode` to `waiting`, and then only a session with a queue carries a pill.
 *
 * Paseo owns the pressable, the pending spinner, error toasts and placement; a
 * plugin owns whether the pill exists at all. There is no push channel for
 * plugin state yet, so this polls, and a mutation in a Defer view refreshes it
 * immediately through `refresh.ts`.
 *
 * Paseo 0.8 owns the pill trigger and exposes a popover behavior for the
 * waiting-message preview. An empty session uses an action behavior that opens
 * the panel directly; a queued session uses the popover, whose body can open
 * the same panel without leaving the transcript.
 */
const POLL_MS = 30_000;

/** Long enough to coalesce a burst of agent updates, short enough to feel live. */
const DEBOUNCE_MS = 250;

/** Messages spelled out in the preview before the rest are just counted. */
const PREVIEW_LIMIT = 3;

/** What the pill reads as while the session has nothing waiting. */
const IDLE_LABEL = "Defer";

interface DeferPopoverProps extends PluginHostProps {
  agentId: string;
  workspaceId: string;
  close(): void;
}

type CurrentButtonBehavior =
  | { kind: "action"; onPress(): void | Promise<void> }
  | { kind: "popover"; Content: ComponentType<DeferPopoverProps> };

interface CurrentButton {
  title: string;
  icon: string;
  label?: string;
  visible?: boolean;
  disabled?: boolean;
  behavior: CurrentButtonBehavior;
}

interface CurrentButtonRegistration {
  update(patch: Partial<CurrentButton>): void;
  remove(): void;
}

interface CurrentPluginClientContext extends Omit<PluginClientContext, "addComposerPill"> {
  addComposerPill(contribution: {
    id: string;
    workspaceId: string;
    agentId: string;
    button: CurrentButton;
  }): CurrentButtonRegistration;
}

const NO_ITEMS: readonly Deferred[] = [];

function isWaiting(item: Deferred): boolean {
  return item.state === "pending" || item.state === "sending";
}

/**
 * Waiting items per agent, for one plugin installation.
 *
 * Scoped to the installation rather than the module so two connected hosts
 * cannot collide on an agent id, and so the pill component can re-render
 * without the registration being torn down and recreated.
 */
interface PillStore {
  items(agentId: string): readonly Deferred[];
  subscribe(listener: () => void): () => void;
  replaceItems(next: Map<string, Deferred[]>): void;
}

function createPillStore(): PillStore {
  let byAgent = new Map<string, Deferred[]>();
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of [...listeners]) listener();
  };
  return {
    items: (agentId) => byAgent.get(agentId) ?? NO_ITEMS,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    replaceItems(next) {
      byAgent = next;
      emit();
    },
  };
}

function previewStyles(theme: PluginTheme, compact: boolean) {
  return {
    card: {
      minWidth: compact ? undefined : 220,
      maxWidth: 360,
      gap: 8,
      paddingVertical: compact ? 4 : 10,
      paddingHorizontal: compact ? 0 : 12,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    message: { color: theme.colors.foreground, fontSize: 13 },
    meta: { color: theme.colors.foregroundMuted, fontSize: 11 },
    hint: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
      paddingTop: 6,
    },
    link: {
      color: theme.colors.accent,
      fontSize: 13,
      fontWeight: "600" as const,
    },
  };
}

function createDeferPopover(
  store: PillStore,
  openPanelFor: (agentId: string, workspaceId: string) => void,
) {
  return function DeferPopover({ theme, layout, agentId, workspaceId, close }: DeferPopoverProps) {
    const subscribe = useCallback((listener: () => void) => store.subscribe(listener), []);
    const readItems = useCallback(() => store.items(agentId), [agentId]);
    const items = useSyncExternalStore(subscribe, readItems, readItems);
    const styles = useMemo(() => previewStyles(theme, layout.compact), [theme, layout.compact]);
    const shown = items.slice(0, PREVIEW_LIMIT);
    const rest = items.length - shown.length;
    const onCardPress = useCallback(() => {
      close();
      openPanelFor(agentId, workspaceId);
    }, [agentId, close, openPanelFor, workspaceId]);

    return (
      <View style={styles.card}>
        {items.length === 0 ? (
          <Text style={styles.meta}>Nothing is waiting for this session.</Text>
        ) : (
          shown.map((item) => (
            <View key={item.id}>
              <Text numberOfLines={3} style={styles.message}>
                {item.text}
              </Text>
              <Text style={styles.meta}>{stateLabel(item)}</Text>
            </View>
          ))
        )}
        {rest > 0 ? <Text style={styles.meta}>{`+${rest} more`}</Text> : null}
        <Text style={styles.hint}>Open Defer to edit or cancel a message.</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open the Defer panel"
          onPress={onCardPress}
        >
          <Text style={styles.link}>Open Defer</Text>
        </Pressable>
      </View>
    );
  };
}

/**
 * Headless client contribution. It is called from `index.client.tsx` once per
 * plugin installation in each connected app.
 */
export function contributeClient(client: PluginClientContext): PluginCleanup {
  const store = createPillStore();
  const currentClient = client as unknown as CurrentPluginClientContext;
  const DeferPopover = createDeferPopover(store, openPanelFor);
  /** Live sessions, agentId -> workspaceId. One pill each. */
  const sessions = new Map<string, string>();
  /** agentId -> the workspace and current Paseo button registration. */
  const registered = new Map<
    string,
    { workspaceId: string; registration: CurrentButtonRegistration }
  >();

  let pillMode: PillMode = DEFAULT_SETTINGS.pillMode;
  let stopped = false;
  let running = false;
  let queued = false;
  let listedSessions = false;
  let debounce: ReturnType<typeof setTimeout> | null = null;

  /** The popover's action: open the panel and close the popover. */
  function openPanelFor(agentId: string, workspaceId: string): void {
    if (stopped) return;
    client.openPanel("defer", { workspaceId, agentId });
  }

  /** Whether this snapshot is a session that can hold a pill, and where. */
  function placement(agent: {
    id?: string;
    workspaceId?: string | null;
    status?: string;
  }): { agentId: string; workspaceId: string } | null {
    const agentId = agent.id;
    const workspaceId = agent.workspaceId;
    if (typeof agentId !== "string" || agentId === "") return null;
    // A closed session has no composer to put a pill on.
    if (agent.status === "closed") return null;
    if (typeof workspaceId !== "string" || workspaceId === "") return null;
    return { agentId, workspaceId };
  }

  function drop(agentId: string): boolean {
    return sessions.delete(agentId);
  }

  /** Whether this session should be carrying a pill right now. */
  function wanted(agentId: string): boolean {
    if (!sessions.has(agentId)) return false;
    return pillMode === "always" || store.items(agentId).length > 0;
  }

  function buttonFor(agentId: string, workspaceId: string): CurrentButton {
    const items = store.items(agentId);
    return {
      title: "Defer a message to this session",
      icon: "Clock",
      label: items.length === 0 ? IDLE_LABEL : pillLabel(items),
      behavior:
        items.length === 0
          ? {
              kind: "action",
              onPress: () => openPanelFor(agentId, workspaceId),
            }
          : {
              kind: "popover",
              Content: DeferPopover,
            },
    };
  }

  /** One pill per live session, mounted where that session's composer is. */
  function reconcilePills(): void {
    if (stopped) return;
    for (const [agentId, entry] of [...registered]) {
      if (wanted(agentId) && sessions.get(agentId) === entry.workspaceId) {
        entry.registration.update(buttonFor(agentId, entry.workspaceId));
        continue;
      }
      // Gone, or moved to another workspace: the workspace is baked into the
      // registration, so a move has to be re-registered rather than patched.
      entry.registration.remove();
      registered.delete(agentId);
    }

    for (const [agentId, workspaceId] of sessions) {
      if (registered.has(agentId) || !wanted(agentId)) continue;
      registered.set(agentId, {
        workspaceId,
        registration: currentClient.addComposerPill({
          id: "defer",
          workspaceId,
          agentId,
          button: buttonFor(agentId, workspaceId),
        }),
      });
    }
  }

  async function loadSessions(): Promise<void> {
    const listed = await client.paseo.agents.list();
    if (stopped) return;
    sessions.clear();
    for (const entry of listed.entries) {
      const place = placement(entry.agent ?? {});
      if (place === null) continue;
      sessions.set(place.agentId, place.workspaceId);
    }
    listedSessions = true;
  }

  async function sync(): Promise<void> {
    if (stopped) return;
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      // The subscription keeps the session set current afterwards.
      if (!listedSessions) await loadSessions();
      const { items, settings } = await client.rpc(listDeferred, {});
      if (stopped) return;
      pillMode = settings.pillMode;
      const byAgent = new Map<string, Deferred[]>();
      for (const item of items) {
        if (!isWaiting(item)) continue;
        const existing = byAgent.get(item.agentId);
        if (existing === undefined) byAgent.set(item.agentId, [item]);
        else existing.push(item);
      }
      store.replaceItems(byAgent);
      reconcilePills();
    } catch (error) {
      // A failed read must not kill the entrypoint: the interval retries, and
      // the panel surfaces the same failure where the user can see it.
      console.warn("[defer] pill sync failed", String(error));
    } finally {
      running = false;
      if (queued && !stopped) {
        queued = false;
        void sync();
      }
    }
  }

  function scheduleSync(): void {
    if (stopped || debounce !== null) return;
    debounce = setTimeout(() => {
      debounce = null;
      void sync();
    }, DEBOUNCE_MS);
  }

  const unsubscribeAgents = client.paseo.agents.subscribe((update) => {
    if (stopped) return;
    if (update.kind === "remove") {
      if (drop(update.agentId)) reconcilePills();
      return;
    }
    const place = placement(update.agent);
    if (place === null) {
      // Reaches here for a session that just closed, which must lose its pill.
      const agentId = update.agent?.id;
      if (typeof agentId === "string" && drop(agentId)) reconcilePills();
      return;
    }
    // Agents upsert on every status change; only a placement change matters.
    if (sessions.get(place.agentId) === place.workspaceId) return;
    sessions.set(place.agentId, place.workspaceId);
    reconcilePills();
  });

  const unsubscribeChanges = onDeferChanged(scheduleSync);
  const timer = setInterval(() => void sync(), POLL_MS);
  void sync();

  return () => {
    stopped = true;
    clearInterval(timer);
    if (debounce !== null) clearTimeout(debounce);
    unsubscribeChanges();
    unsubscribeAgents();
    for (const entry of registered.values()) entry.registration.remove();
    registered.clear();
    sessions.clear();
    store.replaceItems(new Map());
  };
}
