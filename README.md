# paseo-defer

[![npm version](https://img.shields.io/npm/v/paseo-defer?style=for-the-badge&color=cb3837)](https://www.npmjs.com/package/paseo-defer)
[![npm downloads](https://img.shields.io/npm/dm/paseo-defer?style=for-the-badge&color=cb3837)](https://www.npmjs.com/package/paseo-defer)
[![Paseo](https://img.shields.io/badge/Paseo-%E2%89%A5%200.8.0-8A63D2?style=for-the-badge)](https://paseo.sh)
[![License](https://img.shields.io/github/license/tomgrin10/paseo-defer?style=for-the-badge&color=2563eb)](LICENSE)

A trusted local [Paseo](https://paseo.sh) plugin for queuing a message to an agent and delivering it later.

![The Defer popover open above the composer pill, showing a draft carried over from the composer, the 15m/1h/3h/In…/At…/session-reset timing options, and the Defer button — with the same draft still sitting in the composer below it](docs/defer-popover.png)

Messages can be deferred until:

- a delay has elapsed — a `15m`/`1h`/`3h` preset, or **In…** for any wait you type: `3`, `45m`, `2h`, `1h 30m`, up to 30 days (a bare number is minutes);
- a local time you type into **At…**, in 24-hour form (`21:30`) or with a half of the day (`9:30 pm`); or
- the target agent's provider usage window resets.

Both typed fields say out loud what they resolved to — *Sends today at 9:30 PM · in 4h 12m* — before anything is queued. Times are shown and read in whichever clock your device uses, so on an AM/PM device a bare `9:30` in the afternoon means tonight rather than tomorrow morning, and **AM**/**PM** controls are there to pin it.

When a message becomes due, paseo-defer waits for the target agent to become idle so it arrives as a new message instead of steering an active turn. The queue lives on the daemon, so it persists across plugin reloads, Paseo restarts, and every client you connect — nothing is lost when you close the app.

### Where it shows up

- **A composer pill**, on every session, beside Paseo's own task and subagent pills. It reads `Defer` while the session has nothing waiting; pressing it opens a popover anchored right above it, with the message box, every timing option, and anything already waiting for this session — no tab, no leaving the transcript. Once something is queued the pill becomes the status (`in 12m`, or `2 deferred`), hovering it shows the deferred message, and pressing it again reopens the same popover to add, edit, or cancel. The label turns amber once a message is overdue because the session is mid-turn.
  Under **Composer pill** in either Defer view you can switch it to **Only when waiting**, which keeps the composer clear until something is actually queued.
- **Whatever you had already typed**, carried across. Press **Defer** — the pill, or ⌘K — with a half-written prompt in the box and the popover's message box opens already holding it, so a prompt that turns out to be for later is never typed twice: pick a timing and it queues right there, with no tab and no navigation. It is copied rather than moved, because Paseo gives a plugin no way to clear its own composer — clear the prompt box yourself unless you also meant to send it now. (The desktop and web apps keep drafts where a plugin can read them; on iOS the box opens empty.)
- **`/defer 2h ship the release notes`**, typed straight into the composer. The timing comes first and the message follows: `45m`, `1h 30m`, `in 20m`, `21:30`, `9:30 pm`, `at 9:30 pm`, or `reset` for the usage window. Only a leading word that can *only* be a time is read as one, so `/defer 3 more tests` waits three minutes and `/defer ship it in the morning` is left alone — a line that names no time opens the panel holding what you wrote rather than picking a delivery time for you. Paseo clears the composer itself, so this is the one route where the message really does move.
- **The Defer panel**, as a workspace tab or in Explorer. It names the session it is queueing for — title, workspace, provider, status, and session id — and a waiting message can still be edited (text, timing, or both) until delivery starts. Pressing **Defer** returns you to the session and confirms the delivery time in a toast, so queueing something never costs you your place.
- **The Deferred sidebar surface**, which does the same across every session, with a picker for choosing the target and an **Open session** action that jumps to the session a message will land in.
- **⌘K / Ctrl+K**, as **Defer a message**.

## Install

Install from npm on Paseo 0.9.0 or newer:

```bash
paseo plugin install npm:paseo-defer@2.1.8
```

Paseo 0.8 can install the same plugin from Git:

```bash
paseo plugin add tomgrin10/paseo-defer --ref v2.1.8
```

Then open a session and press the **Defer** pill above the composer, or press **⌘K** (**Ctrl+K** on Windows/Linux) and choose **Defer a message**.

```bash
paseo plugin ls                  # confirm it is running
paseo plugin update paseo-defer  # later, pull the newest version
paseo plugin remove paseo-defer
```

<details>
<summary>From a local checkout, for developing against it</summary>

```bash
git clone https://github.com/tomgrin10/paseo-defer.git
cd paseo-defer
npm ci
npm run verify
paseo plugin install "$PWD"
```

After editing the source, `npm run verify && paseo plugin reload paseo-defer`.

</details>

Paseo only offers agent-context commands while the focused tab is a live session, so a new tab that has not started its agent yet shows **Defer a message to a session** instead — it opens the **Deferred** surface, where the target session is picked explicitly.

## Security and data

Paseo plugins are trusted, unsandboxed code. This plugin runs on the daemon machine, connects to the local Paseo daemon, and stores queued message text in:

```text
$PASEO_HOME/plugin-data/defer/queue.json
$PASEO_HOME/plugin-data/defer/settings.json
```

If `PASEO_HOME` is unset, it defaults to `~/.paseo`. Install only after reviewing the source.

For a password-protected daemon, set the standard `PASEO_PASSWORD` environment variable before the daemon starts. The plugin also accepts `PASEO_PASSWORD_FILE` pointing to a file that contains only the plaintext password, and automatically recognizes the paseo-vm secret at `~/paseo-hub/secrets/daemon-password`. `PASEO_PASSWORD` takes precedence, followed by the explicit file and then the VM convention. The password is passed directly to each short-lived daemon connection and is never logged or stored in the plugin data files.

Carrying the prompt box across — into the panel, or onto the card's chips — reads the app's own composer-draft storage in the client, for the one session whose **Defer** you pressed and only at that moment. Nothing about it is written, stored, or sent anywhere: the text goes into the message box in front of you, and reaches the daemon only if you queue it.

Delivery and the provider usage-window read both go through Paseo's own daemon client, which the plugin borrows from the host at runtime rather than bundling. That keeps the plugin's protocol version identical to the daemon's. Paseo's public plugin SDK does not expose `provider.usage.list`, so this is the only route to the rolling usage window.

## More Paseo plugins

Also available from [Tom Gringauz](https://github.com/tomgrin10):

- [Graphite](https://www.npmjs.com/package/paseo-graphite) — Monitor Graphite stacks and PR action state.
- [Smart Session](https://www.npmjs.com/package/paseo-smart-session) — Context-aware compaction and usage insights for long-running agents.
- [Vitals](https://www.npmjs.com/package/paseo-vitals) — Host, Paseo, agent, and Docker health in one dashboard.

## License

[MIT](LICENSE) © 2026 Tom Gringauz.
