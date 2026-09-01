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
- `refresh.client.ts` is the in-app notifier between the Defer views and the pill. Paseo has no server-to-client push for plugin state, so a mutation must call `notifyDeferChanged()` or the pill stays stale for a poll interval.
- Add nothing to `dependencies`. The server bundle must compile with no installed packages or `paseo plugin add` breaks; `daemon.server.ts` borrows Paseo's daemon client from the host through a runtime `require` for exactly that reason. `check-gitinstall.mjs` enforces it.
- Preserve the versioned `queue.json` and `settings.json` schemas and the `$PASEO_HOME/plugin-data/defer` data path; add migrations for incompatible changes. Paseo has no plugin-settings API, so preferences are the plugin's own file, carried to clients on `defer.list` because the pill already polls it.
- Keep daemon connections short-lived and ensure every timer/resource is released by plugin cleanup. Do not log secrets or message bodies.
- Do not restart the daemon to load changes, and do not enable plugins or edit Paseo daemon config without explicit permission. The web-UI check in `Verify changes` needs one temporary config entry; ask first and restore it afterwards.

## Verify changes

Never restart the Paseo daemon; it can kill the agent doing the work. Reloading the plugin is safe.

### 1. Local checks

```sh
npm ci
npm run verify
```

`verify` is typecheck plus four checks, each guarding something typecheck cannot see. Keep them passing and keep `check-lib.mjs` aligned with the Paseo version in the README badge, since every check models Paseo's compiler from it.

| Check | Guards |
| --- | --- |
| `check-bundles.mjs` | The dual-bundle boundary, and the app's own registration validation. A server identifier in `contribute()`'s shared body silently drops every contribution. |
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

Confirm the managed checkout under `~/.paseo/plugins/defer-gittest/*/checkout` has **no** `node_modules`, then run the §3 probe against `defer-gittest` as well. Clean up with `paseo plugin remove defer-gittest` and delete both temp directories.

### 5. Web UI

Paseo's hosted app cannot reach a local daemon from a browser: Chrome blocks an insecure loopback WebSocket from an HTTPS page and the daemon sends no Private-Network-Access header. The daemon's own bundled web UI is off by default and enabling it needs a restart. So serve Paseo's own bundle over loopback instead, which needs one temporary CORS entry.

Ask the owner before editing `~/.paseo/config.json`, and restore it the moment you are done.

```sh
cp ~/.paseo/config.json ~/.paseo/config.json.bak-webui
# add "http://127.0.0.1:8787" to daemon.cors.allowedOrigins, then:
paseo reload --json          # applies daemon.cors.allowedOrigins with no restart
python3 -m http.server 8787 --bind 127.0.0.1 \
  --directory "/Applications/Paseo.app/Contents/Resources/app-dist" &
# open http://127.0.0.1:8787/ — it auto-connects to localhost:6767
```

`http.server` has no single-page-app fallback, so deep links 404. Always load `/` and click through. The app's own settings, including the theme, live in that origin's `localStorage`, so switching theme there does not touch the desktop app.

Afterwards: stop the server, `cp ~/.paseo/config.json.bak-webui ~/.paseo/config.json`, `paseo reload --json`, and confirm `allowedOrigins` is back to its original value.

What to assert, in order:

1. **Deferred** appears in the sidebar; opening it shows `Session resets HH:MM (in …)`, which is the live provider-usage read.
2. Pick a session, type a message, choose a trigger hours away, press **Defer**. The row appears under `Waiting (1)`.
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
