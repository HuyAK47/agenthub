# Documentation Assets & Screenshots

This directory is reserved for visual documentation assets, screenshots, and architecture diagrams.

> **Note for Contributors / Maintainers:**
> Do not commit mock or fabricated images. All screenshots must be captured from a running AgentHub instance with sanitized mock data (no real secrets, API keys, or private project names).

---

## Planned Screenshots

### 1. Web Dashboard Overview
- **Filename**: `dashboard-overview.png`
- **Target Location in Docs**: `README.md`, `docs/en/GETTING-STARTED.md`
- **Status**: `[TODO: Screenshot needed]`
- **Description**: High-resolution screenshot of the AgentHub Web Dashboard overview showing:
  - System resource metrics (CPU, RAM, Worktree disk, Docker disk).
  - AI Worker profiles with quota progress rings (Gemini / Codex / Claude).
  - Active task queue across project worktrees with real-time status badges (`running`, `checking`, `review`).

### 2. Interactive Claude Chat & Permission Broker
- **Filename**: `claude-chat.png`
- **Target Location in Docs**: `README.md`, `docs/en/GETTING-STARTED.md`, `docs/FEATURES.md`
- **Status**: `[TODO: Screenshot needed]`
- **Description**: Screenshot of the Web Dashboard Chat panel showing:
  - Virtualized conversation thread with Claude (Sonnet / Haiku).
  - ContextMeter indicator showing current token count vs. auto-compact threshold.
  - Interactive Tool Permission dialog (`Allow`, `Always Allow`, `Deny`) triggered by a sensitive command.

### 3. Telegram Remote Control & Mobile Approval
- **Filename**: `telegram-control.png`
- **Target Location in Docs**: `README.md`, `docs/en/GETTING-STARTED.md`
- **Status**: `[TODO: Screenshot needed]`
- **Description**: Mobile or desktop capture of the Telegram bot chat showing:
  - Task completion notification with automated check results (lint, test, build).
  - Inline action buttons (`Approve & Merge`, `Changes Requested`, `View Logs`).
  - Safe mobile pairing flow with the 6-digit confirmation code.

### 4. Plans & Batch DAG Visualizer
- **Filename**: `batch-planning.png`
- **Target Location in Docs**: `README.md`, `docs/FEATURES.md`
- **Status**: `[TODO: Screenshot needed]`
- **Description**: Screenshot of the Plans & Batch page showing:
  - Interactive DAG diagram of staged draft tasks with dependency edges.
  - Task drawer for editing prompts and dependencies before dispatch.
  - Batch dispatch controls (`Dispatch All Tasks`, `Discard Draft`).

### 5. Delegated Savings Analytics
- **Filename**: `savings-analytics.png`
- **Target Location in Docs**: `README.md`, `docs/FEATURES.md`
- **Status**: `[TODO: Screenshot needed]`
- **Description**: Screenshot of the Savings analytics dashboard showing:
  - Total tokens delegated to cost-effective worker models.
  - Net Claude tokens and monetary savings calculations.
  - Daily breakdown chart by engine, model, and project.

---

## Asset Guidelines
- **Format**: PNG (optimized via pngquant / oxipng if possible).
- **Theme**: Dark mode preferred for consistency with default web dashboard UI.
- **Privacy & Sanitization**: Ensure no personal tokens, real email addresses, or proprietary source code appear in captured windows.
