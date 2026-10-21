# AgentHub – Kế hoạch

> Giao cho AI agent (Antigravity / Codex) thực hiện, Claude Code review.
> Làm đúng theo kế hoạch. Nếu buộc phải làm khác, ghi lý do vào `docs/DECISIONS.md`.

## 1. Bối cảnh và mục tiêu
Người dùng có nhiều tài khoản AI coding agent: Antigravity CLI (`agy`, mỗi tài khoản Google một quota), Codex CLI (tài khoản ChatGPT), và Claude Code.

**Mục tiêu:** một app chạy local, dùng chung cho **mọi project**, trong đó:
- **Claude Code là bộ não trung tâm.** Nó lập kế hoạch, viết đề bài, giao việc, review và merge, thông qua các tool MCP do AgentHub cung cấp.
- **AgentHub là "hệ điều hành" cho các worker.** Nó quản lý tài khoản và quota, hàng đợi task có phụ thuộc, chạy song song trên git worktree riêng, tự đổi tài khoản/model khi hết quota, lưu log và trạng thái.
- **Web dashboard** để người dùng xem và quản lý: tài khoản, quota, task, log trực tiếp, thêm tài khoản mới.

**Không làm:** AgentHub không tự gọi API Claude, không cần API key. Bộ não là phiên Claude Code mà người dùng đang mở.

## 2. Kiến thức hệ thống đã kiểm chứng (bắt buộc tuân theo)
Các điều dưới đây đã được thử thực tế trên máy này. **Không tự đoán khác.**

### 2.1 Antigravity CLI (`agy`)
- Đường dẫn: `~/.gemini/bin/agy`.
- Chạy không giao diện bằng lệnh:
  ```
  agy -p "<prompt>" --model <id> --dangerously-skip-permissions --print-timeout 0
  ```
  Thư mục làm việc là cwd.
- **Exit code không tin được**: trả về 1 kể cả khi thành công. Kết quả xác định bằng file marker (xem 3.4).
- Model: `claude-opus-4-6-thinking`, `claude-sonnet-4-6`, `gemini-3.8-flash-high|medium|low`, `gpt-oss-120b-medium`. Lệnh `agy models` liệt kê danh sách.
- **Quota tính theo họ model trên mỗi tài khoản**: Opus và Sonnet dùng chung quota "claude"; các model Gemini thuộc họ "gemini". Họ model = phần tên trước dấu `-` đầu tiên.
- Lỗi hết quota xuất hiện ở các dòng cuối output:
  ```
  AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached. ... Resets in 4h54m26s.", ...}
  ```
  Cũng có thể gặp thông báo: `You have exhausted your quota on this model.`
- **Lỗi tạm thời** (không phải hết quota) cũng xuất hiện ở cuối output. Đã gặp thật:
  ```
  error: failed to send message: ... Eligibility check failed: failed to get load code assist response: UNAVAILABLE (code 503): The service is currently unavailable.
  ```
  Cách xử lý: thử lại cùng hồ sơ và model, tối đa 3 lần, chờ lần lượt 60s, 120s, 180s; không đánh dấu quota. Sau 3 lần vẫn lỗi thì run kết thúc với outcome `crashed`.
  Regex: `UNAVAILABLE \(code 503\)|code 50[0-4]|DEADLINE_EXCEEDED|ECONNRESET|ETIMEDOUT|service is currently unavailable|Eligibility check failed`.
- **Đăng nhập và chạy nhiều tài khoản song song:**
  - Tài khoản mặc định (`default`) lưu phiên trong keyring hệ thống (`service=gemini, username=antigravity`). **Không đọc, không ghi keyring này.**
  - Mỗi hồ sơ khác có thư mục HOME riêng `~/.agy-homes/<tên>/`. Chạy agy với:
    - `HOME=~/.agy-homes/<tên>`
    - `DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent/agy-no-keyring`

    Khi đó agy không vào được keyring và phải lưu phiên ra file `<HOME>/.gemini/antigravity-cli/antigravity-oauth-token`.
  - **Không** đổi `XDG_RUNTIME_DIR`: làm vậy sẽ sinh ra FUSE mount `doc/` rất khó xóa.
  - HOME riêng chứa symlink tới HOME thật cho các mục: `.nvm .gitconfig .docker .npmrc .npm .cache .local .config .bashrc .profile .bash_profile`, và `.gemini/config → ~/.gemini/config`. Nhờ vậy công cụ dev vẫn chạy bình thường.
  - **Email của hồ sơ** lấy từ log `<HOME>/.gemini/antigravity-cli/log/*.log`, dòng `authenticated successfully as <email>`. **Tuyệt đối không giải mã hay đọc nội dung file token.**
  - Đăng nhập: chạy `agy` ở chế độ tương tác (cần TTY) trong môi trường của hồ sơ. agy mở trình duyệt; người dùng đăng nhập xong thì thoát (`/exit` hoặc Ctrl+C).
  - Trình duyệt hay **tự chọn tài khoản Google đang đăng nhập sẵn**, nên hai hồ sơ có thể trùng email. Phải phát hiện và cảnh báo. Các hồ sơ trùng email dùng chung quota: đánh dấu hết quota một hồ sơ thì phải đánh dấu cả các hồ sơ cùng email.
- **Hồ sơ đang có** (do script cũ tạo, phải tương thích):
  - `chinh` là tài khoản mặc định, dùng keyring.
  - `g1`, `g2`, `g3` nằm trong `~/.agy-homes/`.
  - Trạng thái quota cũ ở `~/.agy-homes/.state/<tên>@<họ>.exhausted`, nội dung là epoch. Khi chạy lần đầu, import các file này vào DB.

### 2.2 Codex CLI
- Không có trong PATH. Tìm bằng:
  ```
  ls -d ~/.vscode/extensions/openai.chatgpt-*/bin/linux-x86_64/codex | sort -V | tail -1
  ```
- Chạy không giao diện:
  ```
  codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -m gpt-5.6-luna -c model_reasoning_effort=medium -C <dir> "<prompt>"
  ```
  Exit code tin được. Stdin phải là `/dev/null`.
- Hiện chỉ có 1 tài khoản; họ quota là "codex". Chưa từng gặp lỗi quota thật, nên bắt theo regex `usage limit|rate limit|insufficient_quota|\b429\b`. Thời điểm reset đọc theo dạng `try again in 2h 3m`.

### 2.3 Môi trường máy
- Node 22 qua nvm: chạy `source ~/.nvm/nvm.sh && nvm use 22`. Node mặc định của máy là 18, không dùng.
- git 2.25: **không có `git init -b`**. Dùng `git init && git checkout -b main`. `git worktree` dùng bình thường.
- Python 3.8, Docker 24.
- Các cổng 4000, 5432, 6379, 9000, 9001 đã bị dịch vụ khác chiếm.

### 2.4 Lỗi do crash máy (bài học thực tế)
- Khi máy bị crash hoặc mất nguồn đột ngột, file đang được ghi dở có thể bị rỗng (0 bytes) và loose object trong git có thể bị rỗng / hỏng.
- Cách kiểm tra và rà soát:
  - `git fsck`: kiểm tra toàn vẹn repository, phát hiện các corrupt hoặc empty git object.
  - `find -size 0`: tìm các file bị ghi rỗng trong cây thư mục (`find . -size 0`).

## 3. Kiến trúc

```
                 ┌────────────── Claude Code (bộ não, mọi project) ──────────────┐
                 │  MCP tools: hub_*  (stdio, process `agenthub mcp`)            │
                 └───────────────────────────────┬───────────────────────────────┘
                                                 │ HTTP (127.0.0.1:7700, token)
Trình duyệt ── Web dashboard (SPA) ──────────────┤
                                                 ▼
                         agenthubd (daemon, systemd --user)
                 ┌──────────────┬───────────────┬───────────────┬──────────────┐
                 │ Scheduler    │ Engines       │ Profiles/Quota│ Worktrees    │
                 │ (hàng đợi,   │ agy, codex    │ (hồ sơ, khóa, │ (git worktree│
                 │  phụ thuộc)  │ (adapter)     │  hết quota)   │  mỗi task)   │
                 └──────────────┴───────────────┴───────────────┴──────────────┘
                         SQLite ~/.agenthub/hub.db · logs ~/.agenthub/logs/
```

- **Một package TypeScript duy nhất** (không dùng monorepo), gồm 3 lệnh:
  - `agenthub daemon`: chạy HTTP API, phục vụ web, chạy scheduler.
  - `agenthub mcp`: MCP server stdio, chỉ là client mỏng gọi HTTP API.
  - `agenthub <lệnh CLI>`: dùng cho người hoặc script.
- **Stack:**
  - Node 22, TypeScript (ESM), Fastify 5, better-sqlite3, zod, `@modelcontextprotocol/sdk`, node-pty (cho đăng nhập qua web).
  - Web: React 18 + Vite + Tailwind 4 + TanStack Query + xterm.js. Bản build được daemon phục vụ dạng file tĩnh.
  - Test: Vitest.
- **Dữ liệu** nằm ở `~/.agenthub/` (quyền 700): `hub.db`, `token` (quyền 600), `logs/<taskId>/<runId>.log`, `config.json`.

### 3.1 Bảo mật (bắt buộc)
Daemon có thể ra lệnh cho agent chạy mọi lệnh trên máy, nên API phải được bảo vệ chặt:
- Chỉ bind `127.0.0.1`.
- Mọi request `/api/*` phải có header `Authorization: Bearer <token>`. Token sinh ngẫu nhiên 32 byte, lưu ở `~/.agenthub/token`.
- Chống DNS rebinding: chỉ chấp nhận header `Host` là `127.0.0.1:7700` hoặc `localhost:7700`. Header `Origin` nếu có cũng phải thuộc hai giá trị đó.
- Web dashboard lấy token như sau: lệnh `agenthub open` in ra URL `http://127.0.0.1:7700/#token=…`; SPA đọc token từ hash, lưu vào `sessionStorage`, rồi xóa hash khỏi URL.
- SSE/WebSocket cũng phải xác thực bằng token (truyền qua query `?token=` vì EventSource không gửi được header).
- Không bao giờ ghi nội dung file token của agy/codex ra log hay API.

### 3.2 Mô hình dữ liệu (SQLite)
- `projects`
  - `id` (slug), `name`, `path` (repo gốc), `defaultBranch`
  - `envTemplate` (JSON), `maxParallel` (mặc định 3), `createdAt`
- `profiles`
  - `name`, `engine` (agy|codex), `kind` (keyring|isolated|codex), `home`, `email`
  - `enabled`, `createdAt`
- `quota_marks`
  - `profileName`, `family`, `until` (epoch), `reason`
  - Khóa chính: (`profileName`, `family`)
- `tasks`
  - Định danh và nội dung: `id` (`<projectId>/<slug>`), `projectId`, `slug`, `title`, `body` (markdown đề bài), `level` (easy|hard)
  - Chọn model: `modelChain` (JSON, có thể null; null thì dùng chuỗi mặc định theo level)
  - Git: `baseRef`, `branch`, `worktreePath`
  - Trạng thái: `status` (draft|queued|running|review|done|blocked|failed|cancelled|waiting_quota)
  - `dependsOn` (JSON mảng task id)
  - `attempt`, `createdAt`, `updatedAt`
- `task_deps`: phẳng hóa `dependsOn` để truy vấn (tùy chọn).
- `runs`
  - `id`, `taskId`, `engine`, `model`, `profileName`, `pid`
  - `startedAt`, `endedAt`
  - `outcome` (done|blocked|quota|crashed|cancelled|timeout), `logPath`, `resetAt`
- `reviews`
  - `id`, `taskId`, `verdict` (approved|changes_requested), `feedback` (markdown), `createdAt`
- `events`: `id`, `ts`, `type`, `taskId?`, `payload` (JSON). Dùng cho dòng hoạt động trên dashboard và SSE.

### 3.3 Engine adapter
```ts
interface Engine {
  id: 'agy' | 'codex';
  family(model: string): string;            // agy: phần trước '-' đầu tiên; codex: 'codex'
  spawn(opts: { profile: Profile; model: string; cwd: string; prompt: string; logPath: string;
                effort?: string }): ChildProcess;
  detectQuota(logTail: string): { exhausted: boolean; resetSeconds?: number };
}
```
- `agy`: môi trường chạy theo mục 2.1 (hồ sơ `keyring` thì giữ nguyên env; hồ sơ `isolated` thì đổi HOME và DBUS).
- `codex`: theo mục 2.2.
- `detectQuota` chỉ xét **8 dòng cuối** của log, để không bắt nhầm chữ "429" xuất hiện trong code do agent viết.
- Đọc thời gian reset từ các dạng `Resets in 4h54m26s`, `try again in 2h 3m`, cộng thêm 60 giây. Không đọc được thì mặc định 5 giờ.

### 3.4 Giao thức với worker
AgentHub tự tạo prompt cho worker, nên **project không cần có sẵn AGENTS.md**:
- Ghi đề bài vào `<worktree>/.agenthub/task.md`, kèm phần giao thức chung (`src/protocol.md`). Thêm `.agenthub/` vào `.git/info/exclude` của worktree để không bị commit.
- Prompt gửi worker:
  > Đọc `.agenthub/task.md` và thực hiện. Đọc thêm AGENTS.md / CLAUDE.md / GEMINI.md của project nếu có. Làm trên nhánh hiện tại, commit nhỏ theo Conventional Commits. Khi xong tạo `.agenthub/DONE` (tóm tắt, kết quả lint/test, việc còn thiếu); nếu bị chặn tạo `.agenthub/BLOCKED` (lý do). Chỉ tạo marker ở bước cuối.
- Nếu là lượt chạy lại sau khi hết quota, thêm câu: *"Task đã làm dở – kiểm tra git log/status rồi làm tiếp, không làm lại."*
- Nếu là lượt sửa theo review, chèn thêm phần **Feedback review** vào `task.md`.

### 3.5 Scheduler
- Vòng lặp chạy mỗi 2 giây, cộng với chạy ngay khi có sự kiện mới.
- Một task được chạy khi đủ các điều kiện:
  - `status = queued`;
  - mọi task trong `dependsOn` đã `done`;
  - project còn slot (số task đang chạy nhỏ hơn `maxParallel`);
  - tìm được cặp (model, hồ sơ) phù hợp.
- **Cách chọn model và hồ sơ:** đi lần lượt theo `modelChain`. Với mỗi model, xác định họ và engine, rồi tìm hồ sơ thỏa: `enabled`, đúng engine, không có quota mark còn hiệu lực cho họ này, và **không bận** (mỗi hồ sơ chỉ chạy 1 việc tại một lúc). Chọn được cặp đầu tiên thì dừng.
- **Chuỗi model mặc định:**
  - `hard`: `gemini-3.8-flash-high` → `codex:gpt-5.6-luna`
  - `easy`: `gemini-3.8-flash-medium` → `codex:gpt-5.6-luna`
  - Opus (`claude-opus-4-6-thinking`) chỉ dùng khi được chỉ định trên task.
  - Có thể sửa trong `config.json` hoặc qua API/trang Cài đặt.
- **Quy tắc thực thi worker:**
  - Worker không được dùng subagent / agent con / chạy song song nhiều agent (để tiết kiệm quota và tránh xung đột).
  - Mỗi hồ sơ agy chạy tối đa 2 agent đồng thời.
- **Worktree:** khi task chạy lần đầu, tạo worktree:
  ```
  git -C <project.path> worktree add <~/.agenthub/worktrees/<project>/<slug>> -b <branch> <baseRef>
  ```
  - `branch` mặc định là `agenthub/<slug>`.
  - `baseRef` mặc định là `defaultBranch`. Nếu task có phụ thuộc thì base là nhánh của task phụ thuộc cuối cùng, trừ khi đã chỉ định khác.
  - Tạo xong thì sinh file env (xem 3.6).
- **Khi lượt chạy kết thúc:**
  - Có `.agenthub/DONE` → task chuyển sang `review`, kèm sự kiện `task.review_ready`.
  - Có `BLOCKED` → `blocked`.
  - Hết quota → ghi quota mark cho hồ sơ và mọi hồ sơ cùng email, rồi task quay lại `queued` (attempt+1, bật cờ resume).
  - Không có marker và không phải lỗi quota → `failed`.
  - Không còn cặp nào khả dụng → `waiting_quota`. Tự quay lại `queued` khi một mark hết hạn.
- **Timeout** mỗi lượt chạy mặc định 3 giờ. Quá hạn thì kill cả process group.
- **Hủy task**: kill process group (`detached: true`, `process.kill(-pid)`).
- **Khi daemon khởi động lại:** run nào đang `running` mà pid không còn sống thì đánh dấu `crashed`, task quay lại `queued` với cờ resume.

### 3.6 Env theo task (cho project có DB/port)
- `project.envTemplate` là JSON `{ file: ".env", copyFrom: ".env.example", vars: { KEY: "template" } }`.
- Template hỗ trợ các biến `{slot}` (số 1–9, cấp riêng cho mỗi task đang chạy), `{slug}` và `{slug_underscored}`.
  - Ví dụ với XFarm: `API_PORT: "41{slot}0"`, `DATABASE_URL: "postgresql://…:5442/xfarm_{slug_underscored}"`.
- AgentHub sinh file env trong worktree. Việc tạo database là của worker, theo hướng dẫn trong đề bài.

### 3.7 HTTP API (prefix `/api`, JSON) – hợp đồng giữa daemon, MCP và web
| Method | Path | Mô tả |
|---|---|---|
| GET | `/health` | `{ok, version}` (không cần token) |
| GET | `/api/status` | Tổng quan: số task theo trạng thái, hồ sơ, run đang chạy |
| GET/POST | `/api/projects` | Liệt kê / đăng ký `{name, path, defaultBranch?, envTemplate?, maxParallel?}` |
| PATCH/DELETE | `/api/projects/:id` | Sửa / xóa (chỉ xóa được khi không có task đang chạy) |
| GET | `/api/profiles` | Danh sách hồ sơ, kèm email, quota marks, cờ bận, cảnh báo trùng email |
| POST | `/api/profiles` | Tạo hồ sơ agy isolated `{name}` (chỉ chuẩn bị HOME, chưa đăng nhập) |
| POST | `/api/profiles/:name/login` | Mở phiên đăng nhập: trả `sessionId`, kết nối WS `/api/pty/:sessionId` (xterm) |
| POST | `/api/profiles/:name/check` | Chạy prompt "OK" bằng `gemini-3.8-flash-low`, trả kết quả |
| PATCH | `/api/profiles/:name` | `{enabled}` |
| POST/DELETE | `/api/profiles/:name/quota` | Đánh dấu / xóa quota mark `{family, seconds?}` |
| GET | `/api/tasks?project=&status=` | Danh sách task |
| POST | `/api/tasks` | Tạo task `{project, slug, title, body, level, dependsOn?, baseRef?, branch?, modelChain?, start?: boolean}` |
| GET | `/api/tasks/:id` | Chi tiết, kèm runs, reviews, nội dung DONE/BLOCKED nếu có, `git log base..branch --oneline` |
| POST | `/api/tasks/:id/start` | draft → queued |
| POST | `/api/tasks/:id/cancel` | Hủy |
| POST | `/api/tasks/:id/review` | `{verdict, feedback}`: `approved` → done; `changes_requested` → ghi feedback vào task.md, xóa marker, queued (resume) |
| POST | `/api/tasks/:id/retry` | Chạy lại task failed/blocked, có thể kèm `{note}` |
| DELETE | `/api/tasks/:id/worktree` | Xóa worktree (chỉ khi task đã done/cancelled) |
| GET | `/api/tasks/:id/log?run=&tail=` | Nội dung log |
| GET/PUT | `/api/config` | Lấy / cập nhật cấu hình: schema phẳng `{modelChainHard, modelChainEasy, defaultTimeout}` (đơn vị timeout: giây). Schema chính xác xem `src/services/index.ts` (`UpdateConfigSchema`). |
| GET | `/api/events` (SSE) | Luồng sự kiện: `task.*`, `run.*`, `profile.*`, `quota.*`; log trực tiếp qua `run.output` (có throttle) |

`task id` trong URL dùng dạng encode `project~slug`.

*Ghi chú định dạng sự kiện SSE: xem `web/CONTRACT.md 4.2` (và mục 2.1).*

### 3.8 MCP tools (cho Claude Code)
Mỗi tool là một lệnh gọi HTTP mỏng. Output là **text ngắn gọn, dễ đọc cho LLM**, không đổ JSON dài.
- `hub_status`: tổng quan.
- `hub_projects` và `hub_register_project {name, path, …}`.
- `hub_profiles`: danh sách tài khoản, quota, trùng email.
- `hub_create_task {project, slug, title, body, level, dependsOn?, baseRef?, start?}`.
- `hub_tasks {project?, status?}` và `hub_task {id}`: chi tiết task, DONE report, danh sách commit, đường dẫn worktree để Claude tự đọc diff.
- `hub_task_log {id, tail?}`.
- `hub_review {id, verdict, feedback}`, `hub_retry {id, note?}`, `hub_cancel {id}`.
- `hub_wait {ids?, timeoutSec ≤ 1800}`: chặn đến khi một task trong danh sách đổi sang review/blocked/failed/waiting_quota, hoặc hết thời gian. Dùng long-poll trên SSE.
- `hub_mark_quota {profile, family, seconds}`.

Lệnh `agenthub mcp-install` thêm server vào cấu hình Claude Code ở **cấp user**, bằng cách chạy `claude mcp add --scope user agenthub -- <đường dẫn node> <đường dẫn dist>/cli.js mcp`. Nhờ vậy mọi project đều dùng được.

### 3.9 Web dashboard
Viết bằng tiếng Việt, giao diện gọn, có dark mode. Các trang:
1. **Tổng quan**
   - Các ô số liệu: task đang chạy, chờ review, chờ quota, lỗi.
   - Danh sách worker đang chạy (task, model, hồ sơ, thời gian đã chạy).
   - Dòng sự kiện gần đây.
2. **Task**
   - Bảng Kanban theo trạng thái, lọc theo project.
   - Trang chi tiết: đề bài (markdown), runs, **log trực tiếp**, báo cáo DONE, danh sách commit.
   - Các nút: start, cancel, retry, approve, yêu cầu sửa (ô nhập feedback).
3. **Tài khoản**
   - Bảng hồ sơ: email, engine, quota từng họ model kèm đồng hồ đếm ngược, trạng thái bận, cảnh báo trùng email.
   - Nút **Thêm tài khoản**: nhập tên, mở terminal xterm ngay trong trang để đăng nhập agy, kèm hướng dẫn "chọn *Sử dụng tài khoản khác*".
   - Nút Check, Bật/Tắt, Xóa quota mark.
4. **Project**: đăng ký project (path, nhánh mặc định, maxParallel, envTemplate).
5. **Cài đặt**: chuỗi model mặc định, timeout.

### 3.10 CLI
```
agenthub daemon | mcp | open | status | install-service | mcp-install
agenthub profile list|add <tên>|check [tên]|login <tên>   # login chạy agy tương tác ngay trong terminal hiện tại
agenthub task list|show|log <id>
```
- `install-service` tạo `~/.config/systemd/user/agenthub.service` (kèm PATH của nvm Node 22) rồi chạy `systemctl --user enable --now`.
- Có wrapper `bin/agenthub` cài vào `~/.local/bin`.

## 4. Các giai đoạn
| Task | Nội dung | Level | Phụ thuộc |
|---|---|---|---|
| `a0-core` | Khung dự án, SQLite, profiles/quota (import dữ liệu cũ), engines, worktree, scheduler, CLI cơ bản, test | hard | – |
| `a1-api-mcp` | HTTP API đầy đủ (3.7) + bảo mật (3.1) + SSE + MCP server (3.8) + mcp-install + install-service | hard | a0 |
| `a2-web` | Web dashboard (3.9) + PTY đăng nhập | hard | a0 (dùng hợp đồng API 3.7, mock khi a1 chưa xong) |
| `a3-dogfood` | Đăng ký XFarm, chạy thử thật một task nhỏ end-to-end, sửa lỗi | easy | a1, a2 |

## 5. Tiêu chí chung
- Phải chạy được `npm run lint`, `npm run typecheck`, `npm test` và `npm run build`.
- Dùng **npm**, không dùng pnpm, để ít phụ thuộc.
- Test scheduler và engine dùng **engine giả** (fake engine): một script node nhận prompt, ghi log, rồi tạo DONE/BLOCKED hoặc in lỗi quota tùy theo biến env. **Không gọi agy/codex thật trong test.**
- Không có đường dẫn cứng `/home/user`: dùng `os.homedir()`.
