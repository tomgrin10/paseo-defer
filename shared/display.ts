import { defineSettings, settingsRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const displayPreferences = defineSettings({
  id: "display",
  scope: "host",
  version: 1,
  schema: z.object({ showSidebar: z.boolean().default(true) }),
});

export const displayRpc = settingsRpc(displayPreferences.id);
