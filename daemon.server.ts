import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

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
  return window?.resetsAt ?? null;
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

export function clearUsageCache(): void {
  usageCache = null;
}
