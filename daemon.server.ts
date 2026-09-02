import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Short-lived daemon connections.
 *
 * The engine has no `paseo` handle (only RPC handlers get one) and needs
 * `provider.usage.list`, which the plugin SDK does not expose, so it talks to
 * the daemon directly. Each call opens and closes its own connection: a
 * long-lived reconnecting socket in this subprocess kept the event loop alive
 * and hung Paseo's "Stopping plugin" step, which wedged reload.
 */
const CONNECT_TIMEOUT_MS = 10_000;

type DaemonClientModule = typeof import("@getpaseo/client/internal/daemon-client");
export type DaemonClient = InstanceType<DaemonClientModule["DaemonClient"]>;

let daemonClientModule: DaemonClientModule | null = null;

/**
 * Borrows Paseo's own daemon client from the host at runtime.
 *
 * The specifier is assembled rather than written as a literal so the plugin
 * compiler cannot resolve it at build time. That matters for distribution:
 * `paseo plugin add` installs from Git and deliberately runs no package
 * manager, so a statically imported dependency makes the plugin fail to
 * compile with "Could not resolve". The plugin subprocess's `require` resolves
 * from the daemon's own module graph, which always carries the matching
 * @getpaseo/client, so borrowing it also removes any chance of a version skew
 * between the plugin's copy and the daemon's protocol.
 */
function loadDaemonClientModule(): DaemonClientModule {
  if (daemonClientModule !== null) return daemonClientModule;
  const specifier = ["@getpaseo", "client", "internal", "daemon-client"].join("/");
  try {
    daemonClientModule = require(specifier) as DaemonClientModule;
  } catch (error) {
    throw new Error(
      `This Paseo host does not expose its daemon client (${specifier}), which Defer needs to read provider usage and deliver messages: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return daemonClientModule;
}

let cachedUrl: string | null = null;

async function resolveUrl(): Promise<string> {
  if (cachedUrl !== null) return cachedUrl;
  const fromEnv = process.env.PASEO_DAEMON_URL;
  if (fromEnv !== undefined && fromEnv !== "") {
    cachedUrl = fromEnv;
    return cachedUrl;
  }
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  let listen: string | undefined;
  try {
    const raw = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as {
      daemon?: { listen?: string };
    };
    listen = raw.daemon?.listen;
  } catch {
    // Fall through to the documented default.
  }
  cachedUrl = `ws://${listen ?? "127.0.0.1:6767"}/ws`;
  return cachedUrl;
}

/** Runs `work` against a connection that is always closed before returning. */
export async function withDaemon<T>(work: (client: DaemonClient) => Promise<T>): Promise<T> {
  const { DaemonClient } = loadDaemonClientModule();
  const client = new DaemonClient({
    url: await resolveUrl(),
    clientId: "paseo-defer",
    clientType: "cli",
    reconnect: { enabled: false },
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    suppressSendErrors: true,
  });
  try {
    await client.connect();
    return await work(client);
  } finally {
    try {
      await client.close();
    } catch {
      // Teardown must not mask the original result or error.
    }
  }
}

export type AgentState = "initializing" | "idle" | "running" | "error" | "closed";

/** Current status per agent id. Absent means the daemon no longer knows the agent. */
export async function readAgentStates(client: DaemonClient): Promise<Map<string, AgentState>> {
  const payload = await client.fetchAgents();
  const states = new Map<string, AgentState>();
  for (const entry of payload.entries ?? []) {
    const agent = entry.agent;
    if (agent?.id) states.set(agent.id, agent.status as AgentState);
  }
  return states;
}

export interface SessionRow {
  id: string;
  title: string | null;
  provider: string;
  /** Daemon status string; kept loose because the daemon may add states. */
  status: string;
  /** "project / workspace", so a picker can tell two same-titled sessions apart. */
  workspaceLabel: string | null;
  lastActivityAt: string | null;
}

function instant(value: string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Live sessions a message could be deferred to, most recently active first. */
export async function readSessions(client: DaemonClient): Promise<SessionRow[]> {
  const payload = await client.fetchAgents();
  const rows: SessionRow[] = [];
  for (const entry of payload.entries ?? []) {
    const agent = entry.agent;
    if (!agent?.id || agent.status === "closed") continue;
    const place = entry.project;
    const label = [place?.projectName, place?.workspaceName]
      .filter((part): part is string => typeof part === "string" && part !== "")
      .join(" / ");
    rows.push({
      id: agent.id,
      title: agent.title ?? null,
      provider: agent.provider,
      status: agent.status,
      workspaceLabel: label === "" ? null : label,
      lastActivityAt: agent.lastUserMessageAt ?? agent.updatedAt ?? null,
    });
  }
  rows.sort((a, b) => instant(b.lastActivityAt) - instant(a.lastActivityAt));
  return rows;
}

const SESSIONS_TTL_MS = 5_000;
let sessionsCache: { at: number; rows: SessionRow[] } | null = null;

/**
 * Same list, cached briefly: the picker and the overview both poll, and each
 * miss costs a fresh daemon connection.
 */
export async function fetchSessions(): Promise<SessionRow[]> {
  const now = Date.now();
  if (sessionsCache !== null && now - sessionsCache.at < SESSIONS_TTL_MS) return sessionsCache.rows;
  const rows = await withDaemon(readSessions);
  sessionsCache = { at: Date.now(), rows };
  return rows;
}

const USAGE_TTL_MS = 60_000;
let usageCache: { at: number; resetsAt: string | null } | null = null;

function selectWindowReset(
  payload: Awaited<ReturnType<DaemonClient["listProviderUsage"]>>,
  provider: string,
): string | null {
  const entry = payload.providers?.find((candidate) => candidate.providerId === provider);
  // `five_hour` is Claude's rolling window; other providers name theirs `session`.
  const window =
    entry?.windows?.find((candidate) => candidate.id === "five_hour") ??
    entry?.windows?.find((candidate) => candidate.id === "session");
  return normalizeInstant(window?.resetsAt);
}

/**
 * One canonical shape for a provider timestamp, which arrives with microseconds
 * and a numeric offset ("2026-09-02T15:50:00.309167+00:00"). Normalizing here,
 * at the only place such a value enters the plugin, keeps a stored anchor
 * comparable with a later read and keeps an unparseable value out of the queue,
 * where it would otherwise sit forever as a due date that never arrives.
 */
function normalizeInstant(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    console.error("[defer] provider reported an unreadable window reset; ignoring it");
    return null;
  }
  return new Date(ms).toISOString();
}

/**
 * End of the provider's rolling usage window ("Session" in Paseo's usage UI).
 * Cached, because the daemon fetches it from the provider upstream.
 */
export async function fetchSessionResetsAt(provider = "claude"): Promise<string | null> {
  const now = Date.now();
  if (usageCache !== null && now - usageCache.at < USAGE_TTL_MS) return usageCache.resetsAt;
  const resetsAt = await withDaemon(async (client) =>
    selectWindowReset(await client.listProviderUsage(), provider),
  );
  usageCache = { at: Date.now(), resetsAt };
  return resetsAt;
}

/** Same value, reusing a connection the caller already opened. */
export async function readSessionResetsAt(
  client: DaemonClient,
  provider = "claude",
): Promise<string | null> {
  const resetsAt = selectWindowReset(await client.listProviderUsage(), provider);
  usageCache = { at: Date.now(), resetsAt };
  return resetsAt;
}

export function clearCaches(): void {
  usageCache = null;
  sessionsCache = null;
}
