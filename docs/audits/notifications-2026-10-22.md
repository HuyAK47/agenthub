# Notification audit — 2026-10-22

`scripts/notify-audit.mjs` opens `hub.db` with `readonly: true`, reads the last 60 minutes, parses event payloads, and executes the notification policy gates used by the desktop and web paths. It does not start AgentHub or call `notify-send`, Telegram, or browser APIs. Run it with:

```sh
node scripts/notify-audit.mjs --db /path/to/hub.db
# Optional when the database and config are in different directories:
node scripts/notify-audit.mjs --db /path/to/hub.db --config /path/to/config.json
```

The script reports eligible sends after content dedupe, quiet-hours/config gates, the one-hour disk-state throttle, the 15-minute load summary, the disk hysteresis guard, and the engine-wide quota check. It reads notification and Telegram settings from the config next to the database (or `--config`), and resolves the affected engine from either the event profile or its explicit `engine` field before checking all enabled profiles in that engine. The Telegram column applies the same engine/family gate and configured notify flags as `src/telegram.ts`; the browser column applies the same allow-list, hysteresis, grouped load body, and throttle keys as `web/src/notifications.ts`. It also excludes SSE activity that is not a notification event.

## Measured event volume and production pipeline results

The measured input window contained the following event counts and resulting notifications computed by the production pipelines:

| Event type | Events | Desktop (all) | Desktop (important) | Telegram sent | Browser notification | Policy result |
|---|---:|---:|---:|---:|---:|---|
| `deploy.restart_waiting` | 1936 | 0 | 0 | 0 | 0 | no desktop/browser notification; only emitted when blocker content changes |
| `claude.quota_available` | 150 | 0 | 0 | 0 | 0 | no desktop/browser notification; emitted only on unavailable → available transition |
| `brain.updated` | 69 | 0 | 0 | 0 | 0 | dashboard/SSE activity only |
| `task.overlap` | 58 | 0 | 0 | 0 | 0 | bulletin/dashboard only; no desktop notification |
| `quota.exhausted` | 42 | 0 | 0 | 0 | 0 | important level only when every enabled profile of the affected engine/family is exhausted |
| `disk.low` | 7 | 1 | 1 | 1 | 1 | hysteresis at the scheduler plus at most one notification per state per hour |
| `disk.ok` | 5 | 1 | 0 | 1 | 0 | recovery requires hysteresis margin (+1 GB) and preceding low state; normal level |
| `load.task_paused` / `task.paused` / `load.high` | 6 / 6 / 6 | 4 | 0 | 4 | 0 | one summary at most every 15 minutes across pause/load family; normal level |

Total desktop notifications at default `important` level: 1 (≤ 10).

The old static audit counted all quota and disk rows as notification candidates. The executable audit now applies the actual payload, profile, persisted quota mark, dedupe, and throttle state, so its output—not a static event-type `Set`—is the source of truth for a concrete database.

## Policy findings

- `restart_waiting` is emitted only when the `(checks, editing)` blocker snapshot changes.
- `quota_available` is emitted only after a persisted previous unavailable state becomes available.
- `quota.exhausted` is persisted through `quota_marks`; desktop/browser important notifications require all enabled accounts of one engine to be exhausted for that family. Individual quota remains visible on the dashboard.
- Desktop defaults to `important`; `all`, `critical`, and `off` remain supported.
- Browser notifications use the same event allow-list and level policy. Background SSE events such as `run.output`, `deploy.restart_waiting`, `claude.quota_available`, and `brain.updated` cannot create browser notifications.
- Disk recovery requires `minFreeGB + 1` GB, and each disk state is throttled to one notification per hour.
- Load pause/high events are summarized at most once per 15 minutes.
