# Bắt đầu với AgentHub

Hướng dẫn cho người mới: cài AgentHub, kết nối tài khoản AI và giao việc cho các worker.

AgentHub chạy trên máy của bạn. Nó chia việc lập trình cho các worker AI (Gemini qua Antigravity CLI, Codex CLI). Mỗi task chạy trong một git worktree riêng. Hub theo dõi quota, tải máy, dung lượng ổ đĩa và tự chạy kiểm tra (lint, test…) khi worker làm xong. **Claude Code** đóng vai trò "bộ não": lên kế hoạch, giao việc, review và merge.

> **Hạn chế hiện tại (đọc trước):** khung **Chat với Claude trên dashboard chưa dùng được ổn định**. Để điều khiển hub (giao việc, review, merge), bạn cần **mở Claude Code trong VS Code** (hoặc Claude Code trên terminal) và dùng các công cụ MCP `hub_*` (xem mục 6). Dashboard web vẫn dùng tốt để **xem** tiến độ, log, quota, tải máy và để tạo/huỷ/chạy lại task thủ công.

---

## 1. Yêu cầu

| Thành phần | Ghi chú |
|---|---|
| **Linux** | Đã kiểm chứng trên Ubuntu. Dùng `/proc`, `nice`/`ionice` và systemd user service. |
| **macOS** | Được hỗ trợ: tiến trình đọc bằng `ps`/`lsof`, ưu tiên chỉ dùng `nice`, trình duyệt dùng `open`, service dùng LaunchAgent. `ionice` và systemd không có trên macOS. |
| **Windows** | Không hỗ trợ trực tiếp. Dùng WSL2 và chạy AgentHub trong môi trường Linux. |
| **Node.js 22** | Khuyến nghị cài qua [nvm](https://github.com/nvm-sh/nvm). |
| **git** | Các dự án được giao việc phải là git repository. |
| **Ít nhất một worker CLI** | `agy` (Antigravity CLI, đăng nhập Google) và/hoặc `codex` (Codex CLI, đăng nhập OpenAI). |
| **Claude Code** | Bắt buộc nếu muốn để Claude điều phối (cài extension Claude Code cho VS Code, hoặc CLI `claude`). |
| **Tài nguyên máy** | Mỗi worker có thể build/test nặng. Tham khảo: máy 12 nhân / 15 GB RAM chạy ổn ~4 worker song song. |

## 2. Cài đặt

```bash
git clone https://github.com/ducanh19020217/agenthub.git ~/agenthub
cd ~/agenthub
source ~/.nvm/nvm.sh && nvm install 22 && nvm use 22

npm ci
npm --prefix web ci
npm run build
npm run build:web

node dist/cli.js link     # tạo lệnh `agenthub` trong ~/.local/bin (đảm bảo thư mục này có trong PATH)
agenthub doctor           # kiểm tra Node, git, agy, codex, cổng 7700
```

Dữ liệu (DB SQLite, token, log, worktree) nằm ở `~/.agenthub/`. Muốn đặt chỗ khác thì dùng biến môi trường `AGENTHUB_HOME`.

## 3. Chạy hub nền và mở dashboard

```bash
agenthub install-service          # Linux: systemd; macOS: ~/Library/LaunchAgents/dev.agenthub.plist
loginctl enable-linger "$USER"    # (tuỳ chọn) chạy cả khi chưa đăng nhập màn hình
systemctl --user status agenthub  # kiểm tra đang chạy

agenthub open                     # mở http://127.0.0.1:7700/#token=...
```

- Dashboard chỉ nghe ở `127.0.0.1` và cần token (lấy bằng `agenthub open --no-browser`).
- Xem dashboard từ máy khác: **dùng SSH tunnel**, không mở cổng ra mạng:
  `ssh -L 7700:127.0.0.1:7700 user@may-chay-hub` rồi mở `http://127.0.0.1:7700/#token=...` trên máy của bạn.
- Cập nhật phiên bản mới: `git pull && npm ci && npm --prefix web ci && npm run build && npm run build:web && systemctl --user restart agenthub`.

## 4. Kết nối tài khoản worker

```bash
agenthub profile list
agenthub profile login <tên>      # mở terminal đăng nhập tài khoản agy/codex
agenthub profile check            # kiểm tra quota từng tài khoản
```

Trang **Profiles** trên dashboard hiển thị % quota còn lại theo cửa sổ 5 giờ và theo tuần, cùng bảng mức dùng theo ngày. Hub tự ưu tiên tài khoản đang rảnh và còn nhiều quota.

### Accounts & provider terms

Mặc định AgentHub chỉ cho một hồ sơ **personal** trên mỗi engine để tránh khuyến khích xoay vòng nhiều tài khoản cá nhân nhằm vượt giới hạn. Hồ sơ **API key** và **Team** vẫn được phép thêm. Nếu bật `multiplePerProvider`, dashboard sẽ cảnh báo và bạn chịu trách nhiệm tuân thủ điều khoản của nhà cung cấp; nhiều gói cá nhân cấm chia sẻ hoặc vượt giới hạn. Khi dùng chung, nên ưu tiên API key hoặc gói Team thay vì nhiều gói cá nhân.

## 5. Đăng ký dự án

```bash
agenthub project add <tên> /đường/dẫn/tới/repo
```

Sau đó vào trang **Projects** để chỉnh:

- **`maxParallel`**: số task chạy cùng lúc cho dự án.
- **`envTemplate`**: tạo file `.env` riêng cho mỗi worktree, để các task không giẫm lên nhau. Hỗ trợ biến `{slot}`, `{slug}`, `{slug_underscored}`. Ví dụ: cổng `4{slot}50`, DB `myapp_t_{slug_underscored}`.
- **Hooks `onWorktreeRemoved`**: lệnh dọn dẹp khi xoá worktree, ví dụ xoá DB riêng của task.
- **Merge tự động**: khai báo worktree tích hợp cho từng nhánh đích và các lệnh kiểm tra sau merge (vd. `pnpm lint`, `pnpm typecheck`). Khi duyệt kèm merge, hub merge nhánh task, chạy kiểm tra và tự hoàn tác nếu xung đột hoặc kiểm tra thất bại.

Trong repo dự án nên có file `AGENTS.md` mô tả quy ước (cách chạy, cách test, những gì không được làm). Worker đọc file này trước khi làm việc.

## 6. Điều khiển hub bằng Claude Code trong VS Code (cách khuyến nghị)

Vì chat trên dashboard chưa ổn định, hãy điều khiển qua Claude Code:

1. Đăng ký MCP server của hub với Claude Code (một lần):
   ```bash
   agenthub mcp-install            # = claude mcp add --scope user agenthub -- node .../dist/cli.js mcp
   ```
2. Mở thư mục dự án trong **VS Code**, mở khung **Claude Code**.
3. Nói với Claude bằng ngôn ngữ tự nhiên. Claude dùng các công cụ MCP sau:

| Công cụ | Dùng để |
|---|---|
| `hub_status`, `hub_tasks`, `hub_task`, `hub_task_log` | Xem tình trạng hub, danh sách task, chi tiết và log |
| `hub_create_task`, `hub_update_task` | Tạo task (đề bài, nhánh gốc, model, phụ thuộc), sửa đề bài/phụ thuộc |
| `hub_review` | Duyệt (`approved`, kèm merge nếu đã cấu hình) hoặc trả về (`changes_requested` + nhận xét) |
| `hub_retry`, `hub_cancel` | Chạy lại task lỗi/bị chặn, huỷ task |
| `hub_wait` | Chờ đến khi có task cần review |
| `hub_projects`, `hub_register_project`, `hub_profiles`, `hub_mark_quota` | Quản lý dự án, tài khoản, đánh dấu hết quota |
| `hub_git`, `hub_savings`, `hub_claude_usage`, `hub_brain` | Xem git của task, thống kê tiết kiệm token, mức dùng Claude |

Câu lệnh mẫu:

- *"Đọc docs/PLAN.md, chia giai đoạn 2 thành các task nhỏ chạy song song rồi giao cho hub."*
- *"Có task nào chờ review không? Review và merge những task đạt, task chưa đạt thì trả về kèm lỗi cụ thể."*
- *"Task X chạy lâu quá, xem log và xử lý."*

Không có Claude Code thì vẫn tạo task tay được: trang **Tasks → Tạo task** trên dashboard, hoặc `agenthub task add`.

## 7. Vòng đời một task

`queued` → `running` (worker làm trong worktree riêng, commit theo bước) → worker tạo `.agenthub/DONE` (hoặc `BLOCKED`) → `checking` (hub chạy kiểm tra tự động) → `review` → Claude/bạn **duyệt & merge** hoặc **trả về** (task chạy lại với nhận xét) → `done`.

Nhãn chờ trên dashboard:

- **Chờ slot song song**: dự án đã chạy đủ `maxParallel` task.
- **Chờ tài khoản rảnh**: mọi tài khoản phù hợp đang bận.
- **Chờ ổ đĩa**: ổ worktree hoặc ổ Docker dưới ngưỡng.
- **Chờ quota model**: tài khoản hết lượt.

## 8. Cấu hình bảo vệ máy (khuyến nghị bật)

Trang **Settings** (hoặc `PUT /api/config`):

```json
{
  "load": { "enabled": true, "high": 16, "ok": 11, "minFreeMemGB": 1.5, "recoverAfterSec": 300 },
  "disk": {
    "minFreeGB": 3,
    "extraPaths": [{ "path": "/var/lib/docker", "minFreeGB": 1.5, "label": "Docker" }]
  },
  "defaultTimeout": 5400,
  "multiplePerProvider": false
}
```

- **load**: máy quá tải thì tạm giảm mỗi dự án xuống 1 task. Máy ổn định đủ `recoverAfterSec` thì trả lại.
- **disk**: ổ dưới ngưỡng thì không giao task mới. Thêm ổ chứa dữ liệu Docker nếu dự án dùng Docker.
- **defaultTimeout**: giới hạn thời gian mỗi lượt chạy (giây). Ngoài ra hub cảnh báo khi task chạy lâu mà không commit, hoặc khi chạy lặp lại một lệnh.

Worker và lệnh kiểm tra chạy với ưu tiên thấp (`nice`/`ionice` trên Linux, chỉ `nice` trên macOS), nên IDE và trình duyệt của bạn vẫn mượt.

## 9. Hạn chế và lưu ý

- **Chat trên dashboard chưa dùng được ổn định.** Hãy điều khiển qua Claude Code trong VS Code (mục 6).
- **Chế độ dự phòng:** khi Claude hết quota, reviewer Codex có thể tự duyệt task. Duyệt của Codex **không merge**, nên sau đó cần kiểm tra và merge các task đó.
- Chỉ hỗ trợ chạy cục bộ, một người dùng. Dashboard không có phân quyền nhiều người.
- Worker được chạy với quyền cao trong worktree. Chỉ giao việc cho repo bạn tin tưởng, không đưa secret thật vào `.env` mẫu.
- **Không cho worker chạy `docker build/pull`** trên máy có ổ Docker gần đầy: đầy ổ có thể làm sập Postgres của các dự án khác.

## 10. Xử lý sự cố nhanh

| Hiện tượng | Cách xử lý |
|---|---|
| Dashboard trắng/không vào được | `systemctl --user status agenthub`, xem `~/.agenthub/logs/daemon.out` |
| Task đứng ở "chờ" lâu | Xem nhãn lý do chờ (mục 7). Kiểm tra dung lượng đĩa, tải máy, quota trên Dashboard |
| Máy chậm | Giảm `maxParallel`. Kiểm tra tiến trình mồ côi trên Dashboard (nút "Dọn") |
| Worker báo thiếu thư viện | Hub tự chạy `pnpm/npm install` khi tạo worktree. Nếu lỗi, xem log run của task |
| Task chạy lặp, không commit | Huỷ, rồi tạo lại với phạm vi hẹp hơn và yêu cầu commit sau mỗi bước |

Xem thêm: [USAGE.md](USAGE.md) (quy trình chi tiết), [FEATURES.md](FEATURES.md) (danh sách tính năng), [PLAN.md](PLAN.md) (kiến trúc).
