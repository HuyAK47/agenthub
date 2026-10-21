# Contributing to AgentHub

Thank you for your interest in contributing to AgentHub! We welcome community contributions, bug reports, feature requests, and documentation improvements.

---

## 1. Development & Contribution Workflow

### Branching Model
- All feature and fix branches must be branched from and targeted at the `integration` branch (not `main`).
- Work on a dedicated task branch named descriptively (e.g., `feat/my-feature` or `fix/issue-description`).
- Before finalizing your pull request, merge the latest `integration` branch to ensure clean integration:
  ```bash
  git checkout integration
  git pull origin integration
  git checkout feat/my-feature
  git merge integration
  ```

### Commit Guidelines
- Commit changes in small, logical units.
- Follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:
  - `feat(...)`: A new user-facing or internal feature.
  - `fix(...)`: A bug fix.
  - `docs(...)`: Documentation changes or updates.
  - `test(...)`: Adding or improving tests.
  - `refactor(...)`: Code changes that neither fix bugs nor add features.
  - `chore(...)`: Routine tooling or dependency maintenance.

### Local Verification
Before opening a pull request or submitting code, ensure that all quality gates pass locally:
```bash
# Activate Node.js 22 (via NVM recommended)
source ~/.nvm/nvm.sh && nvm use 22

# Code style and type checking
npm run lint
npm run typecheck

# Automated tests
npm test
npm run test:web

# Production build verification
npm run build
npm run build:web
```

### Privacy & System Safety Rules
- **No Secrets**: Never commit real API keys, auth tokens, session files, passwords, or personal credentials.
- **Isolated Testing**: Tests must never access real user directories (`~/.agenthub`, `~/.agy-homes`, `~/.claude`). All tests must execute in isolated temporary directories (`fs.mkdtempSync` or mock fixtures).
- **Network Isolation**: Do not perform live network calls (e.g., to Anthropic, OpenAI, or Telegram API) inside automated tests. Mock external network requests and processes.

---

## 2. Contributor License Agreement (CLA)

### Why a CLA is Required
AgentHub is licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0-only)](LICENSE). Under this license, anyone may use, modify, and distribute the software for free, provided that all modifications and network deployments remain open-source under the AGPLv3.

To support organizations and commercial partners who require a proprietary license without copyleft obligations (dual licensing model), the project maintainers retain the ability to offer commercial licenses. To make this possible, all contributors must grant the project maintainers the necessary rights to include their contributions under alternative commercial licensing terms.

> [!IMPORTANT]
> **Legal Disclaimer**: The CLA text below is a simplified administrative draft intended for open-source development. **It must be formally reviewed and finalized by qualified legal counsel prior to formal/official enforcement.**

### Simplified Contributor License Agreement (Draft)

By submitting a pull request, patch, or contribution to AgentHub, you ("Contributor") agree to the following terms:

1. **Definitions**:
   - "Contribution" means any source code, documentation, design, or other intellectual property submitted by Contributor for inclusion in AgentHub.
   - "Project Maintainer" refers to the primary copyright holder(s) and designated maintainer(s) of the AgentHub project.

2. **Grant of Copyright License**:
   Contributor hereby grants to Project Maintainer a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable license to reproduce, prepare derivative works of, publicly display, publicly perform, sublicense, and distribute the Contribution and derivative works thereof, under both open-source licenses (including AGPLv3) and commercial or proprietary license agreements.

3. **Grant of Patent License**:
   Contributor hereby grants to Project Maintainer and recipients of the software a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable patent license to make, have made, use, offer to sell, sell, import, and otherwise transfer the Contribution.

4. **Right to Contribute**:
   Contributor represents that they are legally entitled to grant the above licenses. If Contributor’s employer has rights to intellectual property created by Contributor, Contributor represents that they have received permission to submit the Contribution on behalf of that employer.

5. **No Warranty**:
   Unless required by applicable law or agreed to in writing, Contributor provides their Contribution on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

---

## 3. Reporting Issues and Security Vulnerabilities

- For bugs and feature suggestions, please open an issue on GitHub.
- For sensitive security vulnerabilities, please avoid public issue trackers and contact the project maintainers directly or use private GitHub security advisories.
