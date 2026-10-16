# Bảng đối chiếu Hợp đồng Web Client và API thật (AgentHub Contract)

Tài liệu này ghi nhận kết quả rà soát, đối chiếu và đồng bộ giữa Web Frontend (`web/`) và Backend API thật (`/home/ducanh/Desktop/AgentHub-wt/a1-api-mcp/`).

---

## 1. Bảng đối chiếu Endpoints HTTP API

| Endpoint | Web client đang gửi / nhận | API thật (`a1-api-mcp`) | Đã sửa gì |
|---|---|---|---|
| `GET /health` | Nhận: `{ ok: true, version: '0.1.0' }` | Trả về: `{ ok: true, version: '0.1.0' }` (status 200, không cần token) | Khớp hoàn toàn. Đồng bộ fixture mock. |
| `GET /api/status` | Nhận: `tasksByStatus` (record), `runningWorkers` (`{ taskId, projectId, slug, title, model, profileName, startedAt }`), `recentEvents` | Trả về: `{ tasks: Record<string, number>, profiles: ProfileRowWithStatus[], running: RunningTask[] }` với `running` gồm `{ taskId, runId, profileName, model, engine, startedAt, elapsedMs }` (không có `projectId`, `slug`, `title`, không có `recentEvents`). | Sửa type `HubStatus`: `tasks: Record<string, number>`, `running: RunningTask[]`, `profiles: Profile[]`. Sửa `DashboardPage` lấy dữ liệu từ `status.tasks` và `status.running`, chuyển `recentEvents` sang lấy trực tiếp từ stream SSE. Sửa mock trả đúng `{ tasks, profiles, running }`. |
| `GET /api/projects` | Nhận: `Project[]` | Trả về: `ProjectRow[]` (`id, name, path, defaultBranch, envTemplate, maxParallel, createdAt`) | Khớp hoàn toàn. |
| `POST /api/projects` | Gửi: `{ name, path, defaultBranch?, envTemplate?, maxParallel? }`<br>Nhận: `Project` (201) | Body `CreateProjectSchema` (`id?, name, path, defaultBranch, envTemplate, maxParallel`). Trả về: `ProjectRow` (status 201). Lỗi: 400 (path không tồn tại), 409 (ID trùng). | Khớp hoàn toàn. |
| `PATCH /api/projects/:id` | Gửi: `UpdateProjectInput` (`name?, path?, defaultBranch?, envTemplate?, maxParallel?`)<br>Nhận: `Project` | Body `UpdateProjectSchema` (`name?, defaultBranch?, envTemplate?, maxParallel?`). Không cho phép sửa `path`. Trả về: `ProjectRow`. Lỗi: 404 (không tìm thấy). | Loại bỏ trường `path` khỏi `UpdateProjectInput` trên web. |
| `DELETE /api/projects/:id` | Nhận: `{ ok: boolean }` | Trả về: `{ ok: true }`. Lỗi: 404 (không tìm thấy), 409 (còn task đang chạy). | Khớp hoàn toàn. |
| `GET /api/profiles` | Nhận: `Profile[]` gồm `quotaMarks`, `isBusy?: boolean`, `duplicateEmailWith?: string[]`, `enabled: boolean \| number` | Trả về: `ProfileRowWithStatus[]` gồm `quotaMarks`, `busy: boolean`, `duplicateWarning: boolean`, `enabled: number (0 \| 1)`. | Sửa type `Profile`: đổi `isBusy` thành `busy`, đổi `duplicateEmailWith` thành `duplicateWarning`. Cập nhật `ProfilesPage` và fixture mock. |
| `POST /api/profiles` | Gửi: `{ name: string }`<br>Nhận: `Profile` (201) | Body `CreateProfileSchema` (`{ name }`). Trả về `ProfileRow` (status 201). Lỗi: 400, 409. | Khớp hoàn toàn. |
| `POST /api/profiles/:name/login` | Nhận: `{ sessionId: string }` | Trả về: `{ sessionId: string }` (mở phiên PTY agy). | Khớp hoàn toàn. |
| `POST /api/profiles/:name/check` | Nhận: `{ ok: boolean, model: string, output?: string, error?: string }` | Trả về: `{ ok: boolean, output: string, email: string \| null }`. | Sửa type `CheckProfileResponse`: bỏ `model`/`error`, thêm `email: string \| null`. Sửa fixture mock. |
| `PATCH /api/profiles/:name` | Gửi: `{ enabled: boolean }`<br>Nhận: `Profile` | Body `{ enabled: boolean \| number }`. Trả về `ProfileRow`. | Khớp hoàn toàn. |
| `POST /api/profiles/:name/quota` | Gửi: `{ family: string, seconds?: number }`<br>Nhận: `{ ok: boolean }` | Body `{ family: string, seconds?: number, reason?: string }`. Trả về `{ ok: true }`. | Thêm `reason?: string` vào type input. |
| `DELETE /api/profiles/:name/quota` | Gửi query `?family=...`<br>Nhận: `{ ok: boolean }` | Query hoặc body `family`. Trả về `{ ok: true }`. Lỗi: 400 (thiếu family). | Khớp hoàn toàn. |
| `GET /api/tasks` | Gửi: query `project`, `status`<br>Nhận: `Task[]` | Query `project`, `status`. Trả về `TaskRow[]`. Trường `dependsOn` dạng JSON string (`"[]"`), `modelChain` dạng JSON string hoặc null. | Khớp hoàn toàn. Type `Task` hỗ trợ `dependsOn` dạng `string \| string[]`. |
| `POST /api/tasks` | Gửi: `{ project, slug, title, body?, level, dependsOn?, start? }`<br>Nhận: `Task` (201) | Body `CreateTaskSchema` (`project, slug, title, body?, level, dependsOn?, baseRef?, branch?, modelChain?, start?`). Trả về `TaskRow` (201). | Khớp hoàn toàn. |
| `GET /api/tasks/:id` | Nhận: `TaskDetail` với trường `gitCommits?: string[]` | Nhận `:id` dạng `project~slug` hoặc `project/slug`. Trả về task kèm `runs`, `reviews`, `doneContent`, `blockedContent`, `commits: string[]`, `worktreePath`. | Đổi tên trường `gitCommits` thành `commits` trong type `TaskDetail`, trang `TaskDetailPage` và fixture mock. |
| `POST /api/tasks/:id/start` | Nhận: `{ ok: boolean }` | Trả về `TaskRow` (toàn bộ object task sau khi cập nhật status `queued`). | Sửa client trả về `Task`, sửa fixture mock trả về task object thay vì `{ ok: true }`. |
| `POST /api/tasks/:id/cancel` | Nhận: `{ ok: boolean }` | Trả về `TaskRow` (toàn bộ object task sau khi cập nhật status `cancelled`). | Sửa client trả về `Task`, sửa fixture mock trả về task object thay vì `{ ok: true }`. |
| `POST /api/tasks/:id/review` | Gửi: `{ verdict, feedback? }`<br>Nhận: `{ ok: boolean }` | Body `{ verdict, feedback? }` (bắt buộc feedback nếu `changes_requested`). Trả về `TaskRow`. Lỗi 400 nếu task không ở trạng thái review. | Sửa client trả về `Task`, sửa fixture mock trả về task object thay vì `{ ok: true }`. |
| `POST /api/tasks/:id/retry` | Gửi: `{ note? }`<br>Nhận: `{ ok: boolean }` | Body `{ note? }`. Trả về `TaskRow`. Lỗi 400 nếu task không phải failed hoặc blocked. | Sửa client trả về `Task`, sửa fixture mock trả về task object thay vì `{ ok: true }`. |
| `DELETE /api/tasks/:id/worktree` | Nhận: `{ ok: boolean }` | Trả về `{ ok: true }`. Lỗi 409 nếu task chưa done/cancelled. | Khớp hoàn toàn. |
| `GET /api/tasks/:id/log` | Gửi query `run?`, `tail?`<br>Nhận: `string` (text/plain) | Query `run`, `tail` (KB). Trả về `text/plain; charset=utf-8`. | Khớp hoàn toàn. |
| `GET /api/config` | Nhận: `{ modelChains: { hard, easy }, runTimeoutHours }` | Trả về: `{ modelChainHard: string[], modelChainEasy: string[], defaultTimeout: number }` (timeout tính bằng giây). | Sửa type `SystemConfig` thành cấu trúc phẳng (`modelChainHard, modelChainEasy, defaultTimeout`). Sửa trang `SettingsPage` và fixture mock. |
| `PUT /api/config` | Gửi: `{ modelChains: { hard, easy }, runTimeoutHours }`<br>Nhận: config mới | Body `UpdateConfigSchema` (`modelChainHard?, modelChainEasy?, defaultTimeout?`). Trả về config mới. | Sửa payload gửi đi khớp với `UpdateConfigSchema`. Sửa trang `SettingsPage` và fixture mock. |

---

## 2. Đối chiếu SSE (`/api/events`) và WebSocket PTY (`/api/pty/:sessionId`)

### 2.1 Server-Sent Events (SSE)
- **Cơ chế phát sự kiện từ API thật**:
  - API thật dùng `reply.raw.write('id: <id>\nevent: <type>\ndata: <JSON>\n\n')`.
  - Mọi sự kiện SSE dùng **chung một envelope**: `{ type, ts, taskId?, payload }`.
  - Các loại event hệ thống từ EventBus: `task.queued`, `task.running`, `task.review_ready`, `task.blocked`, `task.waiting_quota`, `task.done`, `task.failed`, `task.cancelled`, `task.timeout`, `run.crashed`, `profile.created`, `profile.updated`, `quota.exhausted`, `quota.cleared`, `config.updated`.
    - SSE header: `event: <type>`, kèm `id: <id>` tăng dần tương ứng với khóa chính `id` trong bảng `events`.
    - Data JSON envelope: `{ type, ts, taskId?, payload }`.
  - Sự kiện stream `run.output`:
    - SSE header: `event: run.output` (không kèm `id:` để tránh ghi đè `Last-Event-ID` của bus events).
    - Data JSON envelope: `{ type: 'run.output', ts: '<ISO>', taskId: '<taskId>', payload: { runId: '<runId>', chunk: '<chunk>' } }`.
  - **Hỗ trợ `Last-Event-ID`**:
    - Khi client kết nối lại (qua header `Last-Event-ID` hoặc query `lastEventId`), server gửi bù các sự kiện bus bị lỡ từ bảng `events` (`WHERE id > lastId ORDER BY id`), tối đa 200 sự kiện.
    - Không gửi bù sự kiện `run.output`.
- **Xử lý trên Web client**:
  - Lắng nghe `addEventListener` cho từng sự kiện có tên và `run.output`.
  - Parse theo cấu trúc envelope thống nhất `{ type, ts, taskId?, payload }`.
  - Hàm xử lý `run.output` (`handleRunOutput`): nối `chunk` vào log của đúng run (`getRunLog(runId)` và cache react-query `['runLog', runId]`), đồng thời thông báo cho các listener `subscribeToRunOutput`.
  - Tự động kết nối lại (`EventSource`) với cơ chế exponential backoff (1s, 2s, 4s, ..., tối đa 30s) và tự động khôi phục từ `Last-Event-ID` đã nhận.

### 2.2 WebSocket PTY (`/api/pty/:sessionId?token=...`)
- **API thật**:
  - Giao thức song công qua fastify-websocket.
  - Client gửi JSON: `{ type: 'input', data: string }` hoặc `{ type: 'resize', cols: number, rows: number }` (hoặc raw string fallback).
  - Server gửi: raw terminal text chunk.
  - Đóng kết nối khi process kết thúc hoặc sau 15 phút.
- **Web client**:
  - Dùng xterm.js và `@xterm/addon-fit`. Gửi `resize` khi khởi tạo/resize, gửi `input` khi người dùng gõ phím.
  - Hiển thị trực tiếp text chunk từ server vào terminal qua `term.write`.
- **Kết luận**: Khớp hoàn toàn.

---

## 3. Quy định bật chế độ Mock (MSW)

- **Quy tắc**:
  - Chế độ mock **chỉ** được bật khi đang chạy môi trường phát triển (`import.meta.env.DEV`) hoặc khi build có cờ `VITE_MOCK=1`.
  - Trên bản build chính thức (production build không có `VITE_MOCK=1`), tham số `?mock=1` trên URL **hoàn toàn bị vô hiệu hóa**, không kích hoạt Service Worker mock.
- **Đã sửa**:
  - Hàm `setupMocks()` trong `web/src/mocks/browser.ts` được cập nhật để kiểm tra chặt chẽ điều kiện trên.

---

## 4. Đề xuất sửa API (gửi nhóm backend / kiến trúc)

Sau khi đối chiếu với `docs/PLAN.md` (mục 3.7) và thực tế frontend cần hiển thị, có các điểm đề xuất sau:

1. **Bổ sung metadata cho `GET /api/status` (`running`)**:
   - Hiện tại: mỗi phần tử trong `running` chỉ có `{ taskId, runId, profileName, model, engine, startedAt, elapsedMs }`.
   - Vấn đề: `taskId` ở dạng string `projectId/slug`. Để hiển thị tiêu đề task (`title`) trên bảng worker đang chạy ở Dashboard mà không phải gọi thêm `GET /api/tasks`, frontend hiện phải hiển thị `taskId` hoặc trích xuất slug.
   - Đề xuất: Bổ sung `title?: string` và `projectId?: string` vào các object trong danh sách `running` của `getStatus()`.

2. **Chuẩn hóa cấu trúc JSON payload của `run.output` trong SSE**:
   - **Đã áp dụng** (task `t-sse-format`):
     - Mọi sự kiện SSE dùng **chung một envelope**: `{type, ts, taskId?, payload}`.
     - Riêng `run.output` có `payload = {runId, chunk}`.
     - Dùng `event:` của SSE bằng đúng `type`, và thêm `id:` tăng dần theo `events.id`.
     - Hỗ trợ header `Last-Event-ID`: khi client kết nối lại, gửi bù các sự kiện bus bị lỡ lấy từ bảng `events`, tối đa 200 sự kiện. Không gửi bù `run.output`.
     - Web client: parse theo envelope mới, hàm xử lý `run.output` nối `chunk` vào log của đúng run, `EventSource` tự kết nối lại có backoff và lưu `Last-Event-ID`.

3. **Cập nhật tài liệu `docs/PLAN.md` mục 3.7 cho `/api/config`**:
   - Hiện tại: bảng endpoint trong mục 3.7 chưa có `GET/PUT /api/config`. DEC-001 từng đề xuất format nested `{ modelChains: { hard, easy }, runTimeoutHours }`, nhưng backend `a1-api-mcp` đã cài đặt format phẳng `{ modelChainHard, modelChainEasy, defaultTimeout }` (tính bằng giây).
   - Đề xuất: Cập nhật mục 3.7 trong `docs/PLAN.md` phản ánh chính thức endpoint `GET/PUT /api/config` theo schema phẳng của backend hiện tại.
