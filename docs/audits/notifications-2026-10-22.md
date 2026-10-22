# Notification audit — 2026-10-22

The audit is implemented by `scripts/notify-audit.mjs`. It opens the supplied SQLite database with `readonly: true`, reads only the last 60 minutes, and reports event candidates for desktop, Telegram, and the web SSE stream. It does not print database paths or payloads.

## Measured event volume

The input window supplied with this task contained the following event counts:

| Event type | Events | Desktop before policy | Desktop at `important` | Telegram candidate | Web SSE/toast candidate |
|---|---:|---:|---:|---:|---:|
| `deploy.restart_waiting` | 1936 | 0 | 0 | 0 | 0 |
| `claude.quota_available` | 150 | 0 | 0 | 0 | 0 |
| `brain.updated` | 69 | 0 | 0 | 0 | 69 |
| `task.overlap` | 58 | 0 | 0 | 0 | 0 |
| `quota.exhausted` | 42 | 42 | 42* | 42 | 42 |
| `disk.low` / `disk.ok` | 7 / 5 | 12 | 7 | 12 | 0 |
| `load.task_paused` / `task.paused` / `load.high` | 6 / 6 / 6 | 18 | 0 | 0 | 0 |

`*` Important mode emits quota only when the payload/system state says every account in that engine is exhausted. Individual-account quota remains visible on the dashboard.

The existing desktop content dedupe could suppress repeated identical messages, but it could not suppress different task/profile/file messages. The noisy sources therefore remained visible even though they were not all direct desktop notification cases.

## Findings and resulting policy

- `restart_waiting` is now emitted only when the `(checks, editing)` blocker snapshot changes.
- `quota_available` is emitted only on a persisted transition from unavailable to available.
- `task.overlap` is retained for bulletin/dashboard use and is no longer a desktop notification.
- Desktop defaults to `important`; `all`, `critical`, and `off` are supported. Important events are failures, blocks, review/escalation, engine-wide quota exhaustion, disk incidents, CI failures, and brain notices.
- Load pause/high events are summarized at most once per 15 minutes.
- Disk recovery requires at least `minFreeGB + 1` GB and therefore does not flap around the low-water mark.
- The web SSE client currently invalidates caches and renders activity; it has no global browser `Notification` API handler for these event types. This audit therefore distinguishes SSE activity from actual browser toasts rather than counting every SSE event as a toast.
