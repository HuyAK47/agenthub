# Task: a0-core – Lõi AgentHub

Đọc trước: `AGENTS.md`, rồi **toàn bộ** `docs/PLAN.md`. Mục 2 và 3 là quan trọng nhất.
Nhánh: `a0-core`, tạo từ `main`.

## Phạm vi
Task này làm phần lõi của daemon. **Chưa làm** HTTP API đầy đủ, MCP và web (để cho a1, a2), nhưng phải chừa sẵn cấu trúc cho chúng.

1. **Khung dự án**
   - `package.json` dùng ESM, `"bin": {"agenthub": "dist/cli.js"}`.
   - TypeScript strict, ESLint (flat config) + Prettier, Vitest.
   - Các script: `build` (tsc), `dev`, `lint`, `typecheck`, `test`.
   - Cấu trúc thư mục:
     ```
     src/
       cli.ts                 # điểm vào: daemon | status | profile … | task …
       config.ts              # ~/.agenthub, config.json, chuỗi model mặc định (PLAN 3.5); ghi đè thư mục bằng env AGENTHUB_HOME (cho test)
       db/                    # better-sqlite3, migrations dạng mảng SQL đánh số, repository cho từng bảng (PLAN 3.2)
       profiles/              # ProfileService: tạo HOME isolated (symlink như PLAN 2.1), email từ log, phát hiện trùng email, import ~/.agy-homes
       quota/                 # QuotaService: mark/clear/active marks, lan sang hồ sơ cùng email, parse reset time
       engines/               # Engine interface + agy.ts + codex.ts + fake.ts (cho test)
       worktrees/             # tạo/xóa worktree, .git/info/exclude, sinh file env từ envTemplate (PLAN 3.6)
       scheduler/             # Scheduler (PLAN 3.5) + EventBus (EventEmitter + ghi bảng events)
       protocol.md            # giao thức worker (PLAN 3.4), copy vào dist khi build
       daemon.ts              # khởi tạo services + scheduler; Fastify chỉ có GET /health (a1 làm phần còn lại)
     test/
     ```
2. **Profiles**
   - Khi khởi động: tự đăng ký hồ sơ `chinh` (kind=keyring, engine=agy), hồ sơ `codex` (nếu tìm thấy Codex CLI), và mọi thư mục con trong `~/.agy-homes/` (bỏ qua `.state`).
   - Import các quota mark còn hạn từ `~/.agy-homes/.state/*.exhausted`. Tên file có dạng `<tên>@<họ>.exhausted`.
   - Đường dẫn `~/.agy-homes` lấy từ config, để test trỏ được sang thư mục tạm.
   - `email` đọc từ log theo PLAN 2.1. Với `chinh`, đọc log trong `~/.gemini/antigravity-cli/log`.
3. **Engines**
   - `agy` và `codex` làm đúng PLAN 2.1, 2.2 và 3.3. Spawn với `detached: true`; ghi stdout và stderr vào logPath; stdin là `/dev/null`.
   - `fake`: chạy `node test/fixtures/fake-agent.mjs`. Hành vi điều khiển qua env `FAKE_MODE=done|blocked|quota|crash|slow`. Ví dụ: mode `quota` in ra dòng `AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): … Resets in 1h2m3s."}`; mode `done` ghi file `.agenthub/DONE`.
4. **Worktrees**
   - Theo PLAN 3.5 và 3.6.
   - Slot cấp phát theo project: dùng số nhỏ nhất trong 1–9 chưa bị task đang chạy nào chiếm.
   - Sinh file env: copy `copyFrom` (nếu có) rồi thay hoặc thêm các biến trong `vars`.
5. **Scheduler**: làm đủ PLAN 3.5, gồm phụ thuộc, `maxParallel`, chọn (model, hồ sơ), chuyển trạng thái, resume, timeout, hủy, phục hồi khi khởi động lại, và `waiting_quota` → `queued` khi mark hết hạn.
6. **CLI tối thiểu** (gọi thẳng service, chưa cần HTTP):
   - `agenthub daemon`
   - `agenthub status`
   - `agenthub profile list|check [tên]|login <tên>`. `login` chạy agy tương tác với `stdio: 'inherit'` trong môi trường của hồ sơ, sau đó in email.
   - `agenthub project add <name> <path>`
   - `agenthub task add <project> <slug> --title … --level … --body-file … [--depends a,b] [--start]`
   - `agenthub task list|show|log`

## Test bắt buộc (Vitest, dùng fake engine + git repo tạm + AGENTHUB_HOME tạm)
- Parse thời gian reset: `Resets in 4h54m26s` ra 17726 giây, `try again in 2h 3m` ra 7440, không có thông tin thì 18000.
- `detectQuota` chỉ xét 8 dòng cuối: chữ "429" xuất hiện ở đầu log thì không bị tính là hết quota.
- Họ model: `claude-opus-4-6-thinking` → `claude`, `gemini-3.8-flash-high` → `gemini`, `codex:gpt-5.6-luna` → `codex`.
- Quota mark lan sang hồ sơ cùng email.
- Task phụ thuộc chỉ chạy khi task trước đã `done`.
- Với `maxParallel=2` và 3 task: tối đa 2 task chạy đồng thời.
- Một hồ sơ không bao giờ chạy 2 task cùng lúc.
- Lỗi quota → hồ sơ bị đánh dấu → task chạy tiếp trên hồ sơ khác cùng họ. Hết hồ sơ thì sang model kế tiếp trong chuỗi. Hết toàn bộ thì task ở `waiting_quota`.
- DONE → `review`. Review `changes_requested` → feedback được ghi vào `task.md`, marker bị xóa, task chạy lại có cờ resume.
- Hủy task → process group bị kill.
- Khởi động lại khi đang có run → run thành `crashed`, task quay lại `queued`.
- Worktree được tạo đúng nhánh và đúng base; file env sinh đúng slot.
- Import `~/.agy-homes` giả: đủ hồ sơ, đọc được email từ log giả, nhận đủ quota mark.

## Nghiệm thu
- `npm run lint && npm run typecheck && npm test && npm run build` đều đạt.
- Chạy thật: `AGENTHUB_HOME=$(mktemp -d) node dist/cli.js profile list` liệt kê `chinh`, `g1`, `g2`, `g3`, `codex` cùng email đúng, và **không** sửa gì trong `~/.agy-homes`. Dán kết quả vào file `.DONE`.
- Viết `README.md` ngắn: cài đặt và các lệnh.
