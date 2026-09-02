# Repository instructions

## Project

- This is the trusted, unsandboxed Paseo plugin `paseo-defer`; minimum supported Paseo is 0.7.0.
- Check the current plugin docs at `https://paseo.sh/docs/plugins.md` and `https://paseo.sh/docs/plugins/reference.md` before changing runtime code.
- Never commit credentials, queued messages, daemon configuration, logs, or local paths.

## Code boundaries

- Keep `index.ts` focused on contribution wiring.
- `*.client.tsx`: React Native UI and client hooks. Use `theme.colors` for text/backgrounds and `layout.compact` for responsive spacing.
- `*.server.ts`: Node APIs, filesystem access, daemon connections, and backend behavior.
- `*.shared.ts`: Zod RPC contracts and plain values safe in both runtimes.
- `pill.client.tsx` owns the composer pill and its `addClientSide` entrypoint. Under the default `pillMode: "always"` it keeps one registration per *live session* — not per queue — because the pill is the plugin's only in-session UI: Paseo's new-tab launcher lists workspace-context panels only, so an agent-context panel is otherwise reachable from the command centre alone. Under `pillMode: "waiting"` only a session with a queue carries one. The entrypoint therefore tracks the agent stream itself and must drop a registration when a session closes, is removed, or moves workspace (the workspace is baked into the registration and cannot be patched).
- A `sessionReset` item is anchored to the provider's reported window end, which is re-derived on every upstream read and so differs by milliseconds between reads of the *same* window. Compare those instants with `SAME_WINDOW_MS` of slack, never as strings or for exact equality; a real rollover moves the end by hours. Normalize any provider timestamp through `daemon.server.ts`'s single entry point so one shape reaches the queue.
- Timing lives in `format.shared.ts`, parsers included, so both runtimes and every check read the same rules. Anything user-facing must go through `formatClock`, which follows the device's own 12- or 24-hour convention; never hard-code a 24-hour string, and keep `formatDuration` output parseable by `parseDuration`, since an edit round-trips a typed wait through its own label to avoid re-anchoring it.
- `refresh.client.ts` is the in-app notifier between the Defer views and the pill. Paseo has no server-to-client push for plugin state, so a mutation must call `notifyDeferChanged()` or the pill stays stale for a poll interval.
- Add nothing to `dependencies`. The server bundle must compile with no installed packages or `paseo plugin add` breaks; `daemon.server.ts` borrows Paseo's daemon client from the host through a runtime `require` for exactly that reason. `check-gitinstall.mjs` enforces it.
- Preserve the versioned `queue.json` and `settings.json` schemas and the `$PASEO_HOME/plugin-data/defer` data path; add migrations for incompatible changes. Paseo has no plugin-settings API, so preferences are the plugin's own file, carried to clients on `defer.list` because the pill already polls it.
- Keep daemon connections short-lived and ensure every timer/resource is released by plugin cleanup. Do not log secrets or message bodies.
- Do not restart the daemon to load changes, and do not enable plugins or edit Paseo daemon config without explicit permission. The web-UI check in `Verify changes` needs no config change: its loopback origin is a permanent allowlist entry.

## Verify changes

Never restart the Paseo daemon; it can kill the agent doing the work. Reloading the plugin is safe.

### 1. Local checks

```sh
npm ci
npm run verify
```

`verify` is typecheck plus seven checks, each guarding something typecheck cannot see. Keep them passing and keep `check-lib.mjs` aligned with the Paseo version in the README badge, since every check models Paseo's compiler from it.

| Check | Guards |
| --- | --- |
| `check-bundles.mjs` | The dual-bundle boundary, and the app's own registration validation. A server identifier in `contribute()`'s shared body silently drops every contribution. |
| `check-format.mjs` | The timing parsers, against a fixed `from` and an explicit clock convention: a bare wait is minutes, a bare 1–12 on an AM/PM device takes the sooner half of the day, and a shown wait or time can be typed straight back in. |
| `check-engine.mjs` | The scheduler's due-selection, against a stubbed store and daemon. A `sessionReset` item must fire on the rollover and not on a re-read of the same window: the provider re-derives the reset instant on every upstream read, so comparing it exactly sent messages hours early. It also covers first-window adoption and a daemon that cannot answer. |
| `check-composer.mjs` | The composer's timing controls, mounted against a small hook runtime and pressed: which trigger each option builds, that the AM/PM controls appear only on an AM/PM device, and that editing the text of a typed wait does not re-anchor it. Runs itself once per clock convention under `LC_ALL`. |
| `check-pill.mjs` | The composer-pill entrypoint and its component: a pill per live session in each `pillMode`, the preview card's open/close/open-the-panel behaviour, sessions that close, are removed or move workspace, and every timer and subscription released on cleanup. It calls the component as a plain function against a fake React, so the card's own wiring is covered without a renderer. |
| `check-gitinstall.mjs` | That `paseo plugin add` compiles the plugin with no `node_modules`. It also warns about source files that are not committed yet, which a Git install would miss. |
| `check-teardown.mjs` | That the subprocess can exit after cleanup. A leaked timer leaves the plugin stuck `Stopping` and wedges reload for the life of the daemon. |

When changing a check, confirm it still fails for the right reason: break the thing on purpose, watch it fail, then restore. A check that cannot fail is worse than no check.

### 2. Load it

```sh
paseo plugin reload paseo-defer
paseo plugin ls
paseo plugin logs paseo-defer
```

Require `running`, no `ERROR` column, and a `Plugin ready` log with no stack traces.

### 3. Backend, over the protocol

Reaches the RPCs without any UI, which is the fastest way to prove the borrowed daemon client resolved and the provider-usage read works. Run it from the plugin directory so `@getpaseo/client` resolves from the dev dependencies.

```js
// probe.tmp.mjs — delete when done
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
const c = new DaemonClient({ url: "ws://127.0.0.1:6767/ws", clientId: "defer-probe",
  clientType: "cli", reconnect: { enabled: false }, connectTimeoutMs: 10000, suppressSendErrors: true });
await c.connect();
try {
  const call = (m, i) => c.invokePluginRpc("paseo-defer", m, i);
  console.log(await call("defer.list", {}));      // sessionResetsAt set, usageError null
  console.log((await call("defer.sessions", {})).sessions.length);
} finally { await c.close(); }
```

`usageError: null` with a real `sessionResetsAt` is the signal that matters: it only works through the host-provided daemon client.

When testing `defer.create`, target a session that is **not** the one you are working in, use a trigger hours away so nothing is ever delivered, and cancel it afterwards. A delivered test message lands in someone's real conversation.

### 4. Git install

Proves the published install path without pushing anything. `paseo plugin add` accepts `file://` URLs.

```sh
rm -rf /tmp/defer-work /tmp/defer-remote.git
mkdir -p /tmp/defer-work && cp *.ts *.tsx *.mjs *.json *.md LICENSE /tmp/defer-work/
rm -f /tmp/defer-work/package-lock.json
cd /tmp/defer-work && git init -q && git add -A \
  && git -c user.email=t@l -c user.name=t commit -qm snapshot
cd /tmp && git clone --bare -q /tmp/defer-work /tmp/defer-remote.git
paseo plugin add file:///tmp/defer-remote.git --id defer-gittest
paseo plugin ls        # defer-gittest must be running
paseo plugin status defer-gittest
```

The data path is fixed at `$PASEO_HOME/plugin-data/defer`, so a second install shares the real queue and runs a **second scheduler over it**. Keep this check short, and do not run it while anything is waiting that you would mind being delivered twice or early.

Confirm the managed checkout under `~/.paseo/plugins/defer-gittest/*/checkout` has **no** `node_modules`, then run the §3 probe against `defer-gittest` as well. Clean up with `paseo plugin remove defer-gittest` and delete both temp directories.

### 5. Web UI

Paseo's hosted app cannot reach a local daemon from a browser: Chrome blocks an insecure loopback WebSocket from an HTTPS page and the daemon sends no Private-Network-Access header. The daemon's own bundled web UI is off by default and enabling it needs a restart. So serve Paseo's own bundle over loopback instead.

`http://127.0.0.1:8787` is a standing entry in this daemon's `daemon.cors.allowedOrigins`, so there is normally nothing to change and nothing to restore. Serve the bundle on that exact port — the origin is what is allowlisted, not the directory.

```sh
python3 -m http.server 8787 --bind 127.0.0.1 \
  --directory "/Applications/Paseo.app/Contents/Resources/app-dist" &
# open http://127.0.0.1:8787/ — it auto-connects to localhost:6767
```

`http.server` has no single-page-app fallback, so deep links 404. Always load `/` and click through. The app's own settings, including the theme, live in that origin's `localStorage`, so switching theme there does not touch the desktop app. Stop the server when you are done.

If the app loads but never connects — or you are on a machine that has never run this check — confirm the origin is allowlisted before touching anything else. An allowed origin completes the upgrade; a rejected one is refused outright:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' -m 5 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Origin: http://127.0.0.1:8787' \
  http://127.0.0.1:6767/ws       # 101 (then curl holds the socket open and times out); 403 means not allowlisted
```

Adding the entry, or restoring a removed one, is a config edit: ask the owner first, apply it with `paseo reload --json` rather than a restart, and say whether it is meant to stay.

What to assert, in order:

1. **Deferred** appears in the sidebar; opening it shows `Session resets HH:MM (in …)`, which is the live provider-usage read.
2. Pick a session, type a message, choose a trigger hours away, press **Defer**. The row appears under `Waiting (1)`. Then check the typed routes: **In…** with `3` must read `Sends today at … · in 3m`, and **At…** must be prompted in the device's own convention — `21:30` on a 24-hour device, `9:30 PM` with **AM**/**PM** controls on an AM/PM one — resolving to a named day and time as you type. Leave both unqueued unless the wait is long enough to cancel afterwards.
3. Press **Open session** on that row. It navigates to the session — this and step 6 are the only tests of the `navigation` capability, which is undefined on older hosts.
4. A pill sits in the track bar directly above that session's composer, showing a clock and `in 2h 59m`. Open a session with nothing deferred: the same pill reads `Defer` there, and pressing it opens the panel with no card in between. Under **Composer pill**, choose **Only when waiting** — every `Defer`-only pill must disappear within a poll while the queued session keeps its pill — then switch back to **Every session** and watch them return.
5. Press the pill: a card rises above it with the message text and its timing, and it must not be clipped by the track bar or hidden behind the transcript. Press the pill again — the card closes and nothing opens. Press the card itself — the **Defer** panel opens in a tab and the card goes away, and it must *not* bounce back open from the same click reaching the pill underneath. Hovering the pill also raises the card, and it drops when the pointer leaves. A card raised by a press clears itself after ten seconds.
6. Defer a second message from that panel. Pressing **Defer** must land back on the session's transcript with a toast naming the delivery time, leaving the Defer tab open but unfocused, and the pill must already read `2 deferred`. Then repeat with **Edit** on a waiting row: saving a change must *not* navigate.
7. Press **Cancel** on both. The history rows read `cancelled` in the warning colour, and the pill goes back to reading `Defer` rather than going blank or vanishing.
8. **⌘K** with `defer` typed: the `paseo-defer` section sorts above **Agents** and **Files**.

Check both a light and a dark theme, and a narrow window for the compact layout. Screenshot anything visual.

## Create a release

- Release user-facing features, bug fixes, compatibility changes, data migrations, or installer changes. Documentation-only edits normally do not need a release.
- Use SemVer: patch for compatible fixes, minor for backward-compatible features, and major for breaking behavior, storage, or compatibility changes.
- Update the version in `package.json` and its lockfile, and the `--ref` tag in the README install section. Keep badge styles consistent; update the Paseo minimum only when compatibility changes. `paseo plugin add` is the only supported install path, so there is no installer script to pin.
- Release notes must include a short summary, user-visible changes, the `paseo plugin add` install command, minimum Paseo version, and any breaking, migration, security, or upgrade considerations. Omit empty sections.
- Before publishing, require a clean current `main`, verified GitHub ownership, passing checks, a successful plugin reload, clean logs, and a secret audit of the exact release snapshot.
- Tag the exact release commit as `vX.Y.Z`; title the release `paseo-defer vX.Y.Z`. After publishing, test the public tag-pinned installer and badge URLs.

Never move or rewrite a published tag. Ship corrections as a new patch release.
