# AgentHub

AgentHub là "hệ điều hành" cục bộ quản lý các worker AI coding (Antigravity CLI và Codex CLI), được điều phối và giám sát bởi **Claude Code** qua giao thức MCP (Model Context Protocol) cùng giao diện Web Dashboard trực quan.

Hệ thống tự động hóa việc phân chia task độc lập trên từng git worktree riêng biệt, theo dõi và luân chuyển tài khoản/quota khi gặp giới hạn tốc độ (rate limit/quota exhaustion), lưu trữ nhật ký thực thi và hỗ trợ chu trình review code liên tục.

Chi tiết tính năng và mẹo sử dụng: xem [Danh sách tính năng (docs/FEATURES.md)](docs/FEATURES.md).  
Hướng dẫn quy trình sử dụng và xử lý sự cố: xem [Hướng dẫn sử dụng (docs/USAGE.md)](docs/USAGE.md).  
Kế hoạch kiến trúc và thiết kế hệ thống: xem [Kế hoạch chi tiết (docs/PLAN.md)](docs/PLAN.md).

---

## Tính năng chính

- **Điều phối AI Worker thông minh**: Tự động chia task độc lập trên từng git worktree riêng biệt, luân chuyển linh hoạt giữa các tài khoản và chuỗi model (Gemini Flash, Codex Luna); trang bị watchdog giám sát chống treo worker.
- **Chat với Claude trực tiếp trên Web Dashboard**: Trò chuyện điều phối cùng Claude Code ở chế độ An toàn (Safe) hoặc Đầy đủ (Full), hỗ trợ chọn model (`sonnet`, `haiku`) và duy trì tiến trình chạy liên tục (persistent stream-json).
- **Hệ thống Review kép & Autocheck**: Tự động chạy bộ kiểm tra (lint, typecheck, test, build, `check:migrate`) khi worker xong việc; tự động kích hoạt Codex reviewer dự phòng khi Claude hết quota và chuyển trạng thái "Chờ người duyệt" khi cần con người can thiệp.
- **Quản lý tài nguyên & Ổ đĩa chủ động**: Thu thập % hạn mức thực tế từ máy chủ (`/usage`), phát hiện tài khoản cần xác minh; cơ chế chặn khởi chạy khi ổ đĩa gần đầy và tự động dọn dẹp `node_modules` qua lệnh `agenthub clean`.
- **Phân tích Hiệu quả ủy quyền (Savings Page)**: Lượng hóa số token Claude tiết kiệm được, chi phí token điều phối, tỷ lệ tiết kiệm và thống kê chi tiết theo từng model, engine và ngày thực hiện.
- **Trải nghiệm người dùng hiện đại**: Giao diện hỗ trợ Dark/Light mode, song ngữ Tiếng Việt / Tiếng Anh, terminal tương tác trực tiếp trên web và thông báo nổi desktop khi có sự kiện quan trọng.

👉 Xem chi tiết tại [Danh sách tính năng đầy đủ (docs/FEATURES.md)](docs/FEATURES.md).

---

## 1. Cài đặt

Yêu cầu môi trường: **Node.js >= 22** (khuyến nghị thông qua NVM) và **npm**.

```bash
# Kích hoạt môi trường Node 22
source ~/.nvm/nvm.sh && nvm use 22

# Cài đặt dependencies cho backend và frontend web
npm ci
npm --prefix web ci

# Build backend và frontend web
npm run build
npm run build:web
```

Thư mục dữ liệu và cấu hình mặc định đặt tại `~/.agenthub/` (có thể tùy biến qua biến môi trường `AGENTHUB_HOME`).

---

## 2. Các lệnh CLI chính

AgentHub cung cấp bộ lệnh CLI để khởi động daemon, tích hợp công cụ và quản lý hệ thống:

- `agenthub daemon`: Khởi chạy tiến trình daemon của AgentHub (HTTP REST API, WebSocket PTY, Server-Sent Events và Web UI tại `http://127.0.0.1:7700`).
- `agenthub open`: Lấy token xác thực cục bộ và tự động mở Web Dashboard trên trình duyệt mặc định (`http://127.0.0.1:7700/#token=...`). Có thể dùng cờ `--no-browser` để chỉ in URL.
- `agenthub doctor`: Kiểm tra, chẩn đoán sức khỏe hệ thống và môi trường thực thi (phiên bản Node.js, CLI `agy`, `codex`, git worktree, cổng mạng và tình trạng các tài khoản).
- `agenthub install-service`: Tạo và kích hoạt systemd user service (`~/.config/systemd/user/agenthub.service`) để daemon tự động chạy nền khi đăng nhập hệ thống (hỗ trợ cờ `--print` để xem trước nội dung file service).
- `agenthub mcp-install`: Đăng ký AgentHub MCP server với Claude Code ở phạm vi người dùng (`claude mcp add --scope user agenthub ...`), cho phép Claude Code tương tác trực tiếp với AgentHub từ bất kỳ dự án nào (hỗ trợ cờ `--print`).
- `agenthub link`: Tạo symlink tiện ích tại `~/.local/bin/agenthub` trỏ tới script wrapper, giúp chạy lệnh `agenthub` từ bất kỳ thư mục nào trong terminal.

### Các lệnh quản lý bổ trợ:
- `agenthub status`: Xem nhanh số lượng hồ sơ, quota marks và trạng thái các task trong hàng đợi.
- `agenthub profile list|check|login`: Quản lý hồ sơ AI worker, kiểm tra kết nối quota và mở terminal đăng nhập tài khoản.
- `agenthub project add <name> <path>`: Đăng ký một git repository vào AgentHub.
- `agenthub task add|list|show|log`: Thêm task mới, liệt kê danh sách task, xem chi tiết và tra cứu log thực thi.
- `agenthub clean`: Dọn dẹp các thư mục `node_modules` của các task đã hoàn thành để giải phóng dung lượng đĩa (hỗ trợ cờ `--dry-run`).

---

## 3. Kiểm thử và Kiểm tra chất lượng mã nguồn

Chạy bộ kiểm tra tự động trước khi đóng gói hoặc triển khai:

```bash
# Kiểm tra lint, typecheck và chạy toàn bộ unit/integration test
npm run lint
npm run typecheck
npm test

# Kiểm thử giao diện web
npm run test:web
```
