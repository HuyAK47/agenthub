# Two ways to use AgentHub

AgentHub supports two coordination models. Choose one per project; you do not need both for the same project.

## Quick comparison

| | A. Standalone hub | B. Through MCP |
|---|---|---|
| Planner/reviewer | The hub brain | External Claude Code |
| Where you assign work | Web Chat, Tasks, or Telegram | Claude Code in VS Code/terminal |
| Brain setting | `auto` or `suggest` | Set the project to `external` (or global `off`) |
| `claude` CLI | Not required for the hub brain | Required, signed in, with quota |
| Monitoring | Dashboard and Telegram | `hub_*` tools, Dashboard, and Telegram |

## A. Standalone hub

### When to choose it

Choose A when you want to give a goal from the web or phone, do not want to open an IDE, and want AgentHub to plan, create tasks, monitor workers, and prepare reviews.

### Requirements

- The AgentHub daemon is running and at least one project is registered.
- At least one worker account is signed in: Antigravity CLI (`agy`) and/or Codex CLI.
- Worker quota is available. Claude Code is not required for the standalone hub brain.
- Telegram is optional; remote control requires a bot token and a paired chat.

### Setup

1. Open the Dashboard, complete Setup, sign in to a worker, and register a project such as `my-app`.
2. In Settings, set the global brain to `auto` (plan/dispatch automatically) or `suggest` (only suggest). Use `off` when you do not want the brain.
3. In Project settings, use `inherit` for the global setting, or override it with `auto`/`suggest`.
4. For Telegram, create a bot, save its token in Settings, generate a pairing code, and send it to the bot. Only paired chats can control the hub.

### One complete workflow

1. Assign: use Web Chat/Tasks or send `/newtask` in Telegram, for example: “Add a status filter to `my-app`, run checks, and prepare a review.”
2. Track: use Dashboard, Tasks, and task logs; Telegram provides `/status`, `/tasks`, `/task <id>`, and status notifications.
3. Review: inspect check results, diff, and logs in the Dashboard; use Approve/Reject or the corresponding Telegram action.
4. Merge/deploy: use the project’s integration/deploy settings after approval. Do not assume production deploy is enabled; confirm the result on Projects.

### Relevant settings

- `brain.mode`: `auto`, `suggest`, or `off`; a project can `inherit` or override it.
- `brain.permissions`: `standard`, `trusted`, or `full`; projects can also `inherit`. `full` skips permission prompts and should only be used for trusted projects.
- `notifications.telegramContent`: `full` or `minimal` per project.
- Telegram is a control/notification channel; the hub manages the token and requires pairing.

### Common problems

- The brain does nothing: check the project’s effective mode, daemon, worker account, and quota.
- Telegram does not respond: check the token, bot, and paired chat in Settings.
- A task waits: check quota, parallel slots, disk/load guards, and the task log.
- Review is missing: wait for worker/check completion and open task details; a stopped worker is not proof of completion.

## B. Use through MCP

### When to choose it

Choose B when Claude Code in VS Code or a terminal should write the plan, call tools, and review. AgentHub provides scheduling, worktrees, workers, checks, and state; external Claude is the coordinator.

### Requirements

- The AgentHub daemon is running and a project is registered.
- The `claude` CLI is installed, signed in, and has quota.
- Worker CLI(s) and worker quota are available for execution.
- Claude Code can read the MCP registration created by `agenthub mcp-install`.

### Setup

1. Install/sign in to `claude` and ensure the `agenthub` command is on PATH.
2. Run:

   ```bash
   agenthub mcp-install
   ```

   This registers the AgentHub MCP server for Claude Code at user scope.
3. Restart the Claude Code session if needed and check tools such as `hub_status`, `hub_projects`, `hub_create_task`, `hub_task`, `hub_review`, and `hub_wait`.
4. In the `my-app` Project settings, select **External Claude (VS Code)** (`brain.mode = external`). In external mode, the hub brain ignores that project’s events and only notifies.

### One complete workflow

1. Assign: ask Claude Code to analyze the goal, then call `hub_create_task` (or `hub_create_batch` for multiple tasks).
2. Track: Claude calls `hub_status`, `hub_tasks`, `hub_task`/`hub_task_log`, or `hub_wait`; the Dashboard still shows state and logs.
3. Review: after checks finish, Claude reads the task/diff and calls `hub_review` with `approved` or `changes_requested` and feedback.
4. Merge/deploy: if integration/auto-merge and the review chain are enabled, the hub follows those settings; otherwise continue through Projects/Dashboard. Confirm the final result in the hub.

### Relevant settings

- Per-project `brain.mode = external` is the recommended way to combine B with A on other projects.
- `brain.permissions` still controls brain/chat session permissions; external mode does not turn Claude Code into a worker or grant `full` automatically.
- MCP exposes tools for status, projects/profiles, task and batch creation/editing, retry/cancel, review, wait, git, usage, and pause/resume. MCP sessions with a project scope are restricted to that project.
- Telegram can still provide notifications or emergency actions, but it does not replace the Claude Code coordinator.

### Common problems

- Claude cannot see tools: rerun `agenthub mcp-install`, check the daemon, and start a new Claude Code session.
- Tool reports that the daemon is down: run `agenthub daemon` or install the service, then check the Dashboard.
- The hub brain handles the project: its effective mode is not `external`; save settings for the correct project.
- Review is rejected: read feedback/check results, retry or ask Claude to fix, then review again.
- Claude quota is exhausted: the MCP coordinator cannot continue; wait for reset or use A for a project configured for the hub brain.

## Combining both modes

Use A for some projects and B for others. Set a global `brain.mode` as the default, then select `external` in Project settings for projects coordinated by Claude Code. Other projects can `inherit` the global `auto`/`suggest` mode. Avoid having both the hub brain and Claude Code plan the same project; use `external` to make ownership explicit.

See also: [Getting Started](GETTING-STARTED.md), [System Plan](../PLAN.md).
