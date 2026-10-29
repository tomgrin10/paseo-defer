# Send now verification

Send now reschedules the existing pending message with `defer.update` and an absolute current-time trigger. Delivery remains owned by the scheduler: it checks every 15 seconds and waits for the session to be idle. The action preserves the message ID, text, and target session.

## Automated coverage

- `npm run verify`: typecheck, bundle and host-registration checks, scheduler/delivery races, row/composer checks, client handler checks, and session-bound agent/MCP tools.
- `check-send-now.mjs`: panel, popover, and overview invoke the actual shared scheduling hook. Covers immediate repeated clicks, pending state, at-now payload, correct query invalidation and cross-view notification, refusal of nonpending rows, server refusals, connection failures, retries, and refresh failures after a successful update.
- `check-timeline.mjs`: timeline sends the same payload, disables conflicting actions during scheduling, shows accurate feedback, and recovers from server/network errors.
- `check-composer.mjs`: shared rows offer Send now only while pending and disable it while editing or scheduling. Conflicting row actions are disabled during scheduling.

The duplicate guard, timeline disabled state, and row edit/pending guards were each deliberately broken. Their respective checks failed, then passed after restoration.

## Browser fixture

The actual panel, popover, overview, timeline, and shared row components were rendered with React Native Web and a synthetic SDK/RPC fixture in headless Chromium. Each surface was checked at 1440×1000 in dark mode and 390×844 in light mode.

All eight combinations passed: no horizontal overflow or browser exceptions; Send now has a target at least 44px tall; double-click produces one update; Scheduling… appears during the request; successful scheduling explains idle-only delivery; server refusals and connection failures show an error and allow retry; editing disables or hides Send now.

The screenshots below show fixture content. This does not verify native iOS/Android rendering or the live Paseo app's popover positioning.

| Surface | Desktop / dark | Compact / light |
| --- | --- | --- |
| Session panel | [Screenshot](screenshots/send-now-panel-desktop-dark.png) | [Screenshot](screenshots/send-now-panel-compact-light.png) |
| Popover | [Screenshot](screenshots/send-now-popover-desktop-dark.png) | [Screenshot](screenshots/send-now-popover-compact-light.png) |
| Overview | [Screenshot](screenshots/send-now-overview-desktop-dark.png) | [Screenshot](screenshots/send-now-overview-compact-light.png) |
| Timeline | [Screenshot](screenshots/send-now-timeline-desktop-dark.png) | [Screenshot](screenshots/send-now-timeline-compact-light.png) |

The scoped Impeccable detector reported no findings.

## Packaged runtime

The npm-packed artifact was extracted without development dependencies, installed into a separate temporary Paseo 0.14 daemon, and reached `running`. Both `defer.list` and `defer.sessions` RPCs succeeded, followed by a clean plugin reload. The daemon and temporary data were removed afterwards. No real queue or session was used for these checks.
