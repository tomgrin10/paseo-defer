import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DEFAULT_SETTINGS, SettingsSchema, type Settings } from "./defer.shared";
import { dataDir } from "./store.server";

const FileSchema = z.object({ version: z.literal(1), settings: SettingsSchema });

const filePath = () => join(dataDir(), "settings.json");

/**
 * Cached after the first read: `defer.list` carries the settings, every view
 * polls it, and a preference changes only when someone presses a chip.
 */
let cached: Settings | null = null;

async function read(): Promise<Settings> {
  if (cached !== null) return cached;
  try {
    const raw = await readFile(filePath(), "utf8");
    const parsed = FileSchema.safeParse(JSON.parse(raw));
    if (parsed.success) {
      cached = parsed.data.settings;
      return cached;
    }
    console.error("[defer] settings failed validation; using defaults", parsed.error.message);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.error("[defer] could not read settings; using defaults", String(error));
    }
  }
  cached = DEFAULT_SETTINGS;
  return cached;
}

export const settings = {
  read,

  /** Merges a patch over the stored settings. Last write wins; it is one chip. */
  async write(patch: Partial<Settings>): Promise<Settings> {
    const next = SettingsSchema.parse({ ...(await read()), ...patch });
    await mkdir(dataDir(), { recursive: true });
    const target = filePath();
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ version: 1, settings: next }, null, 2), "utf8");
    await rename(temp, target);
    cached = next;
    return next;
  },
};
