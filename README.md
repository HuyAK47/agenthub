# AgentHub

**Public landing page:** [agenthub landing page](https://ducanh19020217.github.io/agenthub/)

**English** | [Tiếng Việt](README.vi.md)

> A local operating system for AI coding workers that coordinates Antigravity (Gemini) and OpenAI Codex CLI across isolated git worktrees, orchestrated by Claude Code via MCP, Web Chat, and Telegram.

---

AgentHub transforms standalone AI coding assistants into an autonomous, quota-aware local engineering team. It automates task dispatch across dedicated git worktrees, tracks provider rate limits to rotate models seamlessly, runs automated verification suites (lint, typecheck, test, build), and supports continuous code review and merging—all supervised by **Claude Code** acting as the central reasoning Brain.

**New to AgentHub?** Start with the [Getting Started Guide (docs/en/GETTING-STARTED.md)](docs/en/GETTING-STARTED.md) ([Bản tiếng Việt](docs/GETTING-STARTED.md)).

> **Multi-Channel Control:** Direct your local AI team through your preferred interface: **Interactive Web Dashboard Chat**, **Telegram Remote Control** on your phone, or **Claude Code in VS Code** via Model Context Protocol (MCP).

- Deep dive into features: [Feature Catalog (docs/FEATURES.md)](docs/FEATURES.md)
- Operational guides & workflows: [Usage Guide (docs/USAGE.md)](docs/USAGE.md)
- Architecture decisions & internals: [System Plan (docs/PLAN.md)](docs/PLAN.md)
- Contributing guidelines & CLA: [Contributing Guide (CONTRIBUTING.md)](CONTRIBUTING.md)

---

## The Problem AgentHub Solves

Developers increasingly rely on multiple AI coding tools (Google Antigravity CLI, OpenAI Codex CLI, Claude Code), each offering distinct strengths, pricing tiers, and rate limits. However, running multiple AI agents directly on a local workstation introduces significant bottlenecks:

1. **Workspace and Resource Collisions**: Running parallel coding agents in a shared folder causes file overwrites, git index conflicts, and database/port clashes.
2. **Quota Exhaustion & Rate Limits**: 5-hour and weekly usage caps abruptly freeze development. Developers must manually track resets, switch logins, or halt work.
3. **Unverified Agent Output**: Agents frequently declare tasks complete without running test suites, leaving regressions, lint errors, or broken builds for developers to discover.
4. **Host Machine Exhaustion**: Multiple unconstrained compilation and test runs can pin CPU cores, deplete RAM, fill disk partitions, and freeze your desktop.
5. **Context Window Waste**: Using expensive reasoning models for mechanical tasks (like running tests or syntax fixes) burns through costly token allowances.

**AgentHub eliminates these bottlenecks** by providing a local scheduling daemon: managing worker accounts, quota schedules, parallel git worktrees, automated verification, failover chains, and machine safety guards.

---

## Architecture

```mermaid
flowchart TD
  subgraph Brain ["Brain & Orchestration Interfaces"]
    CC["Claude Code (VS Code / Terminal via MCP)"]
    WebChat["Web Dashboard Chat (Safe / Full Mode)"]
    TG["Telegram Bot (Mobile Remote Control)"]
  end

  subgraph AgentHubDaemon ["AgentHub Daemon (Localhost:7700)"]
    API["Fastify HTTP / SSE / PTY Engine"]
    Scheduler["Quota-Aware Scheduler & DAG Batching"]
    Safety["Host Protection (Load Guard, Disk Guard, Watchdogs)"]
    CheckEngine["Automated Check Engine (Lint, Test, Build)"]
    Failover["Claude Fallback Chain & Failover"]
  end

  subgraph Workers ["Isolated Execution Workers"]
    W1["Worker 1 (Gemini / Antigravity) -> git worktree A"]
    W2["Worker 2 (OpenAI Codex) -> git worktree B"]
    W3["Worker 3 (Codex Reviewer) -> git worktree C"]
  end

  CC <-->|MCP stdio / HTTP| API
  WebChat <-->|HTTP / WebSocket / SSE| API
  TG <-->|Telegram API (Paired Chat)| API

  API --> Scheduler
  Scheduler --> Safety
  Scheduler --> Workers
  Workers --> CheckEngine
  CheckEngine --> Failover
```

---

## Key Features

### 1. Quota-Aware Scheduling & Account Rotation
- Tracks 5-hour and weekly rate limits across worker profiles (`agy`, `codex`).
- Automatically shifts tasks to standby accounts or alternative models (Gemini Flash, Codex Luna) when quotas expire, resuming paused tasks when reset windows clear.

### 2. Dedicated Git Worktree Isolation
- Spawns each task in a fresh, isolated git worktree branch.
- Generates dynamic `.env` templates per worktree (`PORT=4{slot}50`, `DB_NAME=app_t_{slug_underscored}`) to prevent port and database collisions across concurrent runs.

### 3. Automated Check Engine (Autochecks)
- Automatically triggers quality verification once a worker marks code complete: `lint`, `typecheck`, `test`, `build`, and migration integrity checks (`check:migrate`).
- Records structured check summaries before human or AI review.

### 4. Cross-Review & Automated Merge
- Supports multi-tier review workflows: automated review by Claude Code, fallback review via Codex CLI, or manual human approval.
- Automatically merges verified task branches into configured integration branches, running post-merge checks with automatic rollback on conflict or failure.

### 5. Proactive Host Machine Protection
- **Load Guard**: Monitors system CPU and free memory. When host load spikes, it dynamically throttles concurrency to 1 task per project and resumes when safe.
- **Disk Guard**: Halts new task dispatch if disk space falls below safe headroom (supports custom directories like `/var/lib/docker`).
- **Orphan Reaper & Watchdogs**: Automatically detects and terminates orphaned worker subprocesses, loops without commits, or frozen sessions.
- **Low-Priority Execution**: Tasks run under reduced scheduling priority (`nice` / `ionice` on Linux, `nice` on macOS) to ensure your primary IDE and browser stay responsive.

### 6. Multi-Channel Control
- **Web Dashboard**: Modern responsive UI with dark/light mode, live streaming terminal output, task DAG visualizer, and account management.
- **Interactive Chat & Permission Broker**: Converse directly with Claude in Safe or Full mode, monitor token capacity with ContextMeter, compress sessions (`/compact`), fork summaries (`/fork-summary`), and approve sensitive commands via interactive dialogs.
- **Telegram Remote Control**: Monitor queue status, review test outputs, approve/reject tasks with inline buttons, and chat with Claude from your mobile device via secure 6-digit pairing.

### 7. Multi-Profile Claude Management & Fallback Chain
- Manages isolated Claude configurations at `~/.agenthub/claude-homes/<profile>/` (restricted to `0700` permissions).
- **Fallback Chain**: Seamlessly cascades to secondary profiles, lighter models (`haiku`), budget-capped Anthropic API keys (`dailyCapUSD`), or Codex reviewer when Claude encounters rate limits.

### 8. Delegation Savings Analytics
- Quantifies token savings gained by delegating boilerplate coding tasks to cost-effective worker models instead of expensive primary reasoning models.

---

## Quick Start (5 Commands)

### Quick One-Line Install from Release (inspect before running):

```bash
curl -fsSL https://raw.githubusercontent.com/ducanh19020217/agenthub/main/scripts/install.sh -o /tmp/agenthub-install.sh
less /tmp/agenthub-install.sh
sh /tmp/agenthub-install.sh --from-release
```

Supports safe updates and uninstallation; use `--dry-run` to preview commands. Data in `~/.agenthub/` is only wiped when explicitly requested via `--uninstall --purge` with confirmation.

Gỡ cài đặt:

```bash
sh /tmp/agenthub-install.sh --uninstall
sh /tmp/agenthub-install.sh --uninstall --purge
```

Thử bộ cài trên máy sạch:

```bash
scripts/smoke-install.sh release/agenthub-*.tar.gz
```

### Manual Setup (5 Commands):

```bash
# 1. Clone repository and switch to Node 22
git clone https://github.com/ducanh19020217/agenthub.git ~/agenthub && cd ~/agenthub
source ~/.nvm/nvm.sh && nvm install 22 && nvm use 22

# 2. Install dependencies and build backend & web UI
npm ci && npm --prefix web ci && npm run build && npm run build:web

# 3. Create global CLI link and verify environment health
node dist/cli.js link && agenthub doctor

# 4. Install background daemon service
agenthub install-service

# 5. Open Web Dashboard and connect worker profiles
agenthub open
```

---

## Comparison with IDE-Based Coding Tools

| Feature / Aspect | IDE-Based AI Extensions | AgentHub Local Orchestrator |
|---|---|---|
| **Execution Environment** | Runs inside your primary editor; operates directly on your open working tree. | Runs as a local daemon; provisions isolated, ephemeral git worktrees per task. |
| **Concurrency & Parallelism** | Typically limited to a single active prompt or thread in the current workspace. | Concurrently coordinates multiple parallel tasks across independent worker processes. |
| **Quota Management** | Bound to a single logged-in account; halts completely upon hitting rate limits. | Pools multiple worker accounts; schedules around quota resets and model chains. |
| **Verification & Quality Gates** | Requires manual user prompting or manual execution of test commands. | Automatically runs automated test suites (`lint`, `typecheck`, `test`, `build`) before review. |
| **Machine Safety & Throttling** | Rare host resource awareness; can exhaust memory during unmonitored compilation. | Built-in Load Guard, Disk Guard, Orphan Process Reaper, and `nice`/`ionice` CPU scheduling. |
| **Supervisory Model** | User acts as the sole prompt engineer and manual tester. | Claude Code acts as tech lead / Brain, delegating tasks and reviewing code diffs. |

### Cài trên máy khác từ GitHub Release

Máy mới chỉ cần Node.js 22, npm, `curl` và `tar`; archive release đã kèm `node_modules` production đã build theo OS/arch. Nếu archive thiếu dependencies, installer sẽ hướng dẫn cài compiler native.

```bash
curl -fsSL https://raw.githubusercontent.com/ducanh19020217/agenthub/main/scripts/install.sh -o /tmp/agenthub-install.sh
sh /tmp/agenthub-install.sh --from-release
agenthub setup
```

Dùng `--from-release 0.1.0` để ghim một phiên bản. Bộ cài kiểm tra `SHA256SUMS`, giải nén vào `~/.agenthub-app/<version>`, bỏ qua `npm ci` khi archive đã có dependencies production, rồi chỉ cập nhật symlink sau khi cài thành công. Hai bản cũ được giữ lại để rollback thủ công.

```bash
agenthub rollback          # chọn bản cũ gần nhất
agenthub rollback 0.1.0    # chọn rõ phiên bản
```

---

## Visual Tour & Screenshots

Documentation screenshots and UI walkthroughs are cataloged in [`docs/assets/`](docs/assets/README.md):
- **Dashboard Overview**: Monitor active tasks, worker quota rings, and hardware metrics.
- **Interactive Chat**: Conversational interface with ContextMeter and permission broker dialogs.
- **Telegram Remote Control**: Task notifications, inline action buttons, and mobile chat.
- **Plan & Batch DAG Visualizer**: Staging and dispatching multi-task dependency graphs.
- **Savings Analytics**: Token efficiency and cost savings breakdown.

*(See [docs/assets/README.md](docs/assets/README.md) for contribution guidelines and image asset placeholders).*

---

## Security Architecture

- **Localhost Binding**: The daemon strictly binds to `127.0.0.1:7700`. It does not expose listening ports to external networks.
- **Token Authentication**: All HTTP API routes require a bearer token generated randomly at startup and saved to `~/.agenthub/token` (file permission `0600`).
- **DNS Rebinding Protection**: Enforces strict `Host` and `Origin` header validation against `127.0.0.1:7700` and `localhost:7700`.
- **Credential Hygiene**: Worker credentials, OAuth refresh tokens, and system keyring entries are never printed in logs or transmitted across API responses.
- **Interactive Permission Broker**: Sensitive commands executed during chat require explicit user authorization via Web UI or Telegram confirmation buttons.
- **Secure Telegram Remote Access**: The Telegram bot accepts commands exclusively from paired chats verified by temporary 6-digit codes; bot tokens are stored in `0600` files and redacted from APIs.

---

## Honest Limitations

- **Single-User Architecture**: AgentHub is designed for local developer workstations. It does not provide multi-tenant isolation or role-based user management.
- **Host User Privileges**: Worker tasks execute with the privileges of your local operating system user account. Only register trusted repositories, and avoid storing unencrypted production credentials in `.env` templates.
- **Codex Reviewer Merge Policy**: When Claude quota is exhausted and the system falls back to the Codex reviewer, approved tasks **are not automatically merged**; human confirmation is required.
- **Operating System Support**: Linux (Ubuntu, Debian) and macOS are fully supported. Windows is supported exclusively through WSL2.
- **Provider Terms**: By default, AgentHub limits each provider to one personal profile to prevent unauthorized quota evasion. Team or API key configurations should be used for high-volume shared usage.

---

## Frequently Asked Questions (FAQ)

### Does AgentHub call Claude APIs directly or require an Anthropic API key?
No. In its default configuration, AgentHub does not require an Anthropic API key. It connects to your existing Claude Code session in VS Code or via the local Claude CLI. An optional Anthropic API key can be configured solely as an emergency fallback step with strict daily spending limits (`dailyCapUSD`).

### What happens when an AI worker runs out of quota?
The scheduler marks the profile and model family as exhausted, calculates the reset timestamp from provider headers or error messages, and either switches the task to an available alternative model/profile or places it in a `waiting_quota` state until the reset window passes.

### Can I use AgentHub without Claude Code?
Yes. You can create, manage, and inspect tasks manually using the Web Dashboard or CLI (`agenthub task add`). However, having Claude Code active allows automated decomposition, prompt generation, code review, and merging.

### How does git worktree isolation prevent database and port collisions?
AgentHub assigns a unique slot number to each concurrent worktree and interpolates variables into a project `.envTemplate`. For example, `PORT=4{slot}50` maps slot 1 to port 4150 and slot 2 to port 4250.

### Can I monitor tasks remotely?
Yes. You can pair the integrated Telegram bot to receive real-time notifications, approve/reject tasks, and converse with Claude from anywhere. Alternatively, you can open an SSH tunnel (`ssh -L 7700:127.0.0.1:7700 user@machine`) to access the Web Dashboard securely.

---

## License & Commercial Licensing

AgentHub is free and open-source software licensed under the **[GNU Affero General Public License v3.0 (AGPL-3.0-only)](LICENSE)**.

- **Open Source Freedom**: You are free to run, study, modify, and redistribute AgentHub, including for commercial purposes.
- **Network Copyleft Obligation**: If you modify AgentHub and run it as a network service or distribute modified versions, you must make the complete corresponding source code available under the AGPLv3.
- **Commercial Licensing (Dual Licensing)**: If your organization wishes to embed or distribute AgentHub without being bound by the copyleft provisions of the AGPLv3, commercial licenses are available. Please contact the project author for commercial licensing inquiries.

Copyright (C) 2026 ducanh19020217 / AgentHub contributors.
