# paseo-defer

A trusted local [Paseo](https://paseo.sh) plugin for queuing a message to an agent and delivering it later.

Messages can be deferred until:

- a relative delay has elapsed;
- a specific local time; or
- the Claude rolling usage window resets.

When a message becomes due, paseo-defer waits for the target agent to become idle so it arrives as a new message instead of steering an active turn. The queue persists across plugin reloads and Paseo restarts.

## Install

Paseo's plugin API is experimental. This plugin uses an internal Paseo client API to read provider usage windows, so a future Paseo release may require an update.

```bash
git clone https://github.com/tomgrin10/paseo-defer.git
cd paseo-defer
npm install
npm run verify
paseo plugin install "$PWD"
paseo plugin ls
```

If plugins are disabled, enable them in **Settings → Plugins** before installing. Open an agent, press **⌘K** on macOS or **Ctrl+K** on Windows/Linux, and choose **Defer a message**.

After editing the source:

```bash
npm run verify
paseo plugin reload paseo-defer
```

## Security and data

Paseo plugins are trusted, unsandboxed code. This plugin runs on the daemon machine, connects to the local Paseo daemon, and stores queued message text in:

```text
$PASEO_HOME/plugin-data/defer/queue.json
```

If `PASEO_HOME` is unset, it defaults to `~/.paseo`. Install only after reviewing the source.
