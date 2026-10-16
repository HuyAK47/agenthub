# Task: a1-api-mcp – HTTP API, bảo mật, SSE, PTY, MCP server, cài đặt

Đọc trước: `AGENTS.md`, `docs/PLAN.md`, đặc biệt mục **3.1, 3.5, 3.7, 3.8 và 3.10**.
Đọc thêm code lõi trong `src/`: scheduler, db, profiles, quota.
Nhánh: `a1-api-mcp`, đang checkout trong worktree này. Commit nhỏ theo Conventional Commits, **mỗi phần dưới đây ít nhất một commit**.
Một agent khác đang làm `web/` (task a2) song song. **Không đụng vào `web/`.**
Khi xong tạo `docs/tasks/a1-api-mcp.DONE`. Nếu bị chặn thì tạo `.BLOCKED`.

## 0. Thay đổi so với PLAN (đã được người dùng chốt)
- **Chuỗi model mặc định** trong `src/config.ts`:
  - `hard`: `gemini-3.8-flash-high` → `codex:gpt-5.6-luna`
  - `easy`: `gemini-3.8-flash-medium` → `codex:gpt-5.6-luna`

  Opus chỉ được dùng khi task chỉ định `modelChain`. Cập nhật test liên quan.
- **Prompt gửi worker** phải thêm câu: *"KHÔNG dùng subagent / agent con; tự làm tuần tự trong phiên này. Tránh đọc lại file lớn không cần thiết."*
- **Endpoint mới** `GET /api/config` và `PUT /api/config`, để đọc và sửa `modelChainHard`, `modelChainEasy`, `defaultTimeout`.
  - Validate bằng zod: mỗi model phải là id agy hợp lệ hoặc có tiền tố `codex:`.
  - Lưu vào `config.json` và áp dụng ngay, không cần restart daemon.
- Khi **thêm hồ sơ, đăng nhập xong, xóa quota mark hoặc bật lại một hồ sơ**: chuyển ngay mọi task đang `waiting_quota` về `queued`. Hiện tại chúng chỉ quay lại khi có mark hết hạn.

## 1. HTTP API (Fastify 5) – làm đủ bảng ở PLAN 3.7
- Có tầng service riêng để sau này MCP và CLI dùng chung. Mọi input validate bằng zod.
- Lỗi trả về dạng `{error, message}` kèm HTTP code đúng: 400, 401, 403, 404, 409 (ví dụ xóa project khi còn task đang chạy).
- `GET /api/tasks/:id` trả thêm:
  - nội dung `.agenthub/DONE` và `.agenthub/BLOCKED` nếu có;
  - `commits`: kết quả `git log --oneline <baseRef>..<branch>`, chạy bằng `execFile` **có mảng tham số**, không ghép chuỗi vào shell;
  - `worktreePath`.
- `GET /api/tasks/:id/log?tail=N`: đọc N KB cuối, tối đa 512KB.
- Phục vụ `dist/web` dạng file tĩnh tại `/`, có fallback về `index.html` cho route của SPA. Nếu chưa có bản build web thì `/` trả một trang HTML đơn giản ghi "chưa build web".

## 2. Bảo mật (PLAN 3.1) – bắt buộc, có test riêng
- Chỉ bind `127.0.0.1:7700`, đổi được bằng env `AGENTHUB_PORT`.
- Token 32 byte lưu ở `~/.agenthub/token` với quyền 600; tạo nếu chưa có. So sánh token bằng `timingSafeEqual`.
- Mọi request `/api/*` đều cần `Authorization: Bearer`. Riêng SSE và WebSocket nhận `?token=`.
- Kiểm tra `Host` theo allowlist, và `Origin` nếu có. Sai thì trả **403**.
- **Test:**
  - thiếu token → 401;
  - sai token → 401;
  - `Host: evil.com:7700` → 403;
  - `Origin: http://evil.com` → 403;
  - `/health` không cần token;
  - SSE không có token → 401.

## 3. SSE `/api/events`
- Phát sự kiện từ EventBus.
- Gửi kèm sự kiện `run.output`: theo dõi file log của các run đang chạy bằng cách đọc thêm phần mới mỗi khoảng 1 giây. Mỗi sự kiện tối đa 4KB, mỗi run tối đa 1 sự kiện/giây.
- Gửi ping 20 giây một lần.
- Dọn listener khi client ngắt kết nối. Có test kiểm tra không rò listener.

## 4. PTY đăng nhập
- `POST /api/profiles/:name/login`:
  - Tạo phiên `node-pty`, chạy `agy` tương tác trong môi trường của hồ sơ (cùng hàm env như engine dùng), cwd là HOME của hồ sơ.
  - Trả về `{sessionId}`.
  - Mỗi hồ sơ chỉ có tối đa 1 phiên. Phiên tự đóng sau 15 phút.
- WebSocket `/api/pty/:sessionId?token=` (dùng `@fastify/websocket`):
  - client gửi `{type:"input",data}` và `{type:"resize",cols,rows}`;
  - server gửi lại output thô.
- Khi PTY thoát: đọc lại email của hồ sơ từ log, phát sự kiện `profile.updated` (kèm cảnh báo nếu trùng email), rồi đưa các task `waiting_quota` về `queued` (xem mục 0).
- `node-pty` là module native. Nếu không cài được, ghi vào `docs/DECISIONS.md` và dùng phương án thay thế `script -qfc` qua `child_process`.

## 5. MCP server (`agenthub mcp`) – PLAN 3.8
- Dùng `@modelcontextprotocol/sdk` với transport stdio.
- Mỗi tool là một lệnh HTTP gọi daemon. Đọc token từ file. Khi daemon không chạy thì trả thông báo rõ ràng: *"AgentHub daemon chưa chạy: `agenthub install-service` hoặc `agenthub daemon`"*.
- Output là **text ngắn gọn**. Ví dụ `hub_status`:
  ```
  Đang chạy 2 · chờ review 1 · chờ quota 0 · lỗi 0
  - xfarm/phase-1 [running] gemini-3.8-flash-high@g2 12m
  …
  Hồ sơ: chinh(gemini✓ claude✗→15:54) g2(…)…
  ```
- `hub_create_task` nhận `body` (markdown). Nếu `start` được truyền là true thì đưa thẳng vào hàng đợi.
- `hub_wait`: long-poll trên SSE cho đến khi một task được theo dõi chuyển sang `review | blocked | failed | waiting_quota | done`, hoặc hết `timeoutSec` (mặc định 600, tối đa 1800). Trả về những task đã thay đổi.
- `hub_task` trả: trạng thái, các run, báo cáo DONE, danh sách commit, `worktreePath`, và câu gợi ý *"Review: đọc diff bằng `git -C <worktree> diff <base>...HEAD`"*.
- **Test:** dùng client MCP in-memory của SDK, gọi từng tool trên một daemon test (token tạm, `AGENTHUB_HOME` tạm, fake engine).

## 6. CLI và cài đặt
- `agenthub open`: in ra và mở (`xdg-open`) `http://127.0.0.1:7700/#token=…`.
- `agenthub install-service`:
  - Tạo `~/.config/systemd/user/agenthub.service` với `ExecStart` là **đường dẫn tuyệt đối** tới node 22 hiện tại cộng `dist/cli.js daemon`, `Environment=PATH=…` lấy từ PATH hiện tại (để thấy git, docker, agy), `Restart=on-failure`.
  - Sau đó chạy `systemctl --user daemon-reload && systemctl --user enable --now agenthub`.
  - Chỉ in hướng dẫn chứ **không tự chạy** nếu có cờ `--print`.
- `agenthub mcp-install`: chạy `claude mcp add --scope user agenthub -- <node> <abs>/dist/cli.js mcp`. Có cờ `--print` để chỉ in lệnh.
- Viết `bin/agenthub` (shell wrapper gọi node 22 + `dist/cli.js`) và lệnh `agenthub link` để tạo symlink vào `~/.local/bin/agenthub`.
- **Trong lúc làm task, không tự chạy `install-service` hay `mcp-install` thật.** Chỉ test bằng `--print`. Việc cài thật Claude sẽ làm sau khi review.

## Nghiệm thu
- `npm run lint && npm run typecheck && npm test -- --run && npm run build` đều đạt. Ghi số test vào file DONE.
- Chạy thử thật với `AGENTHUB_HOME` tạm, `AGENTHUB_PORT=7790` và fake engine (chọn qua env, ví dụ `AGENTHUB_FAKE_ENGINE=1`):
  - khởi động daemon;
  - dùng curl: tạo project trỏ tới một git repo tạm, tạo task, start, chờ task chuyển sang `review`, approve;
  - kiểm tra SSE nhận được sự kiện.

  Dán log tóm tắt vào file DONE, rồi tắt daemon.

## Ghi chú cho lượt tiếp (từ Claude, sau lượt 1)
- Lượt 1 đã commit 3 phần (core, API/bảo mật/SSE/PTY, MCP). Ngoài ra còn các thay đổi chưa commit: `src/cli.ts`, `bin/` và `test/cli.test.ts`. Kiểm tra và commit chúng, rồi làm tiếp phần còn thiếu, chủ yếu là mục 6 và mục Nghiệm thu.
- Lượt 1 bị dừng vì agent **chờ một tiến trình chạy nền không bao giờ kết thúc**: `agenthub open`, daemon, hoặc test ở chế độ watch. Từ lượt này:
  - Test luôn chạy bằng `npm test -- --run`, không dùng watch.
  - Mọi lệnh có thể chạy lâu hoặc chạy mãi đều phải bọc `timeout`, ví dụ `timeout 120 …`.
  - Daemon thử nghiệm: chạy nền, lưu PID, kiểm tra xong thì `kill` PID đó.
  - **Không** chạy `agenthub open` thật, vì nó mở trình duyệt. Chỉ kiểm tra phần URL được in ra (thêm cờ `--no-browser`).
