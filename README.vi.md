# AgentHub

**Landing page:** [Giới thiệu AgentHub](https://ducanh19020217.github.io/agenthub/)

[English](README.md) | **Tiếng Việt**

AgentHub là "hệ điều hành" cục bộ quản lý các worker AI coding (Antigravity CLI và Codex CLI), được điều phối và giám sát bởi **Claude Code** qua giao thức MCP (Model Context Protocol) cùng giao diện Web Dashboard trực quan.

Hệ thống tự động hóa việc phân chia task độc lập trên từng git worktree riêng biệt, theo dõi và luân chuyển tài khoản/quota khi gặp giới hạn tốc độ (rate limit/quota exhaustion), lưu trữ nhật ký thực thi và hỗ trợ chu trình review code liên tục.

**Người mới bắt đầu:** xem [Hướng dẫn cài đặt & sử dụng (docs/GETTING-STARTED.md)](docs/GETTING-STARTED.md).

Để chọn mô hình làm việc, xem [Hai cách dùng AgentHub (docs/USAGE-MODES.md)](docs/USAGE-MODES.md): hub độc lập qua Web/Telegram hoặc Claude Code qua MCP.

> **Điều khiển linh hoạt:** Bạn có thể điều khiển AgentHub (giao việc, review, quản lý task) thông qua **Chat với Claude trực tiếp trên Web Dashboard**, **Bot Telegram từ xa** trên điện thoại, hoặc **Claude Code trong VS Code** qua giao thức MCP (`agenthub mcp-install`). Dashboard cung cấp đầy đủ công cụ theo dõi tiến độ, log thời gian thực, quota tài khoản, tải máy và quản lý task.

Chi tiết tính năng và mẹo sử dụng: xem [Danh sách tính năng (docs/FEATURES.md)](docs/FEATURES.md).  
Hướng dẫn quy trình sử dụng và xử lý sự cố: xem [Hướng dẫn sử dụng (docs/USAGE.md)](docs/USAGE.md) và [Hai cách dùng](docs/USAGE-MODES.md).
Kế hoạch kiến trúc và thiết kế hệ thống: xem [Kế hoạch chi tiết (docs/PLAN.md)](docs/PLAN.md).

---

## Tính năng chính

- **Điều phối AI Worker thông minh**: Tự động chia task độc lập trên từng git worktree riêng biệt, luân chuyển linh hoạt giữa các tài khoản và chuỗi model (Gemini Flash, Codex Luna); trang bị watchdog giám sát chống treo worker.
- **Chat với Claude trực tiếp trên Web Dashboard**: Trò chuyện điều phối cùng Claude Code ở chế độ An toàn (`safe`) hoặc Đầy đủ (`full`), hỗ trợ chọn model (`sonnet`, `haiku`), giao diện lịch sử ảo hóa cuộn tải dần, quản lý phiên (tìm kiếm, ghim, tóm tắt, xuất Markdown), duyệt quyền công cụ tương tác (Cho phép/Từ chối), nén ngữ cảnh tự động (`/compact`, `/fork-summary`) và duy trì tiến trình chạy liên tục (persistent stream-json).
- **Điều khiển từ xa an toàn qua Telegram Bot**: Nhận thông báo tức thời về task và quota, xem log, duyệt/trả về task, phê duyệt quyền công cụ bằng nút bấm inline và trò chuyện trực tiếp với Claude từ điện thoại. Xác thực ghép đôi an toàn bằng mã 6 số, bảo mật nghiêm ngặt với token lưu quyền `0600` và chỉ nhận lệnh từ chat đã ghép đôi.
- **Đăng nhập & Quản lý đa hồ sơ Claude**: Lưu trữ cấu hình và token biệt lập tại `~/.agenthub/claude-homes/<tên_hồ_sơ>/` (quyền thư mục `0700`), hỗ trợ các gói tài khoản Cá nhân (`personal`), Đội ngũ (`team`) và API key (`api_key`).
- **Chuỗi dự phòng Claude thông minh (Fallback Chain)**: Tự động đổi hồ sơ Claude đã đăng nhập khác, hạ cấp model (`haiku`), sử dụng Anthropic API key có trần chi phí bảo vệ (`dailyCapUSD`) hoặc kích hoạt Codex reviewer dự phòng khi Claude gặp giới hạn tốc độ (rate limit / 429) hoặc hết hạn mức.
- **Hệ thống Review kép & Autocheck**: Tự động chạy bộ kiểm tra (lint, typecheck, test, build, `check:migrate`) khi worker xong việc; tự động kích hoạt Codex reviewer dự phòng khi Claude hết quota và chuyển trạng thái "Chờ người duyệt" khi cần con người can thiệp.
- **Quản lý tài nguyên & Ổ đĩa chủ động**: Thu thập % hạn mức thực tế từ máy chủ (`/usage`), phát hiện tài khoản cần xác minh; cơ chế chặn khởi chạy khi ổ đĩa gần đầy và tự động dọn dẹp `node_modules` qua lệnh `agenthub clean`.
- **Phân tích Hiệu quả ủy quyền (Savings Page)**: Lượng hóa số token Claude tiết kiệm được, chi phí token điều phối, tỷ lệ tiết kiệm và thống kê chi tiết theo từng model, engine và ngày thực hiện.
- **Trải nghiệm người dùng hiện đại**: Giao diện hỗ trợ Dark/Light mode, song ngữ Tiếng Việt / Tiếng Anh, terminal tương tác trực tiếp trên web và thông báo nổi desktop khi có sự kiện quan trọng.

### Accounts & provider terms

AgentHub mặc định giới hạn một hồ sơ cá nhân trên mỗi engine; hồ sơ API key hoặc Team vẫn được phép. Có thể bật `multiplePerProvider` khi bạn hiểu và chấp nhận điều khoản của nhà cung cấp. Nhiều gói cá nhân cấm chia sẻ hoặc vượt giới hạn, vì vậy nên dùng API key hoặc gói Team cho nhu cầu dùng chung.

👉 Xem chi tiết tại [Danh sách tính năng đầy đủ (docs/FEATURES.md)](docs/FEATURES.md).

---

## 1. Cài đặt

Cài đặt nhanh (nên đọc và kiểm tra script trước khi chạy):

```bash
curl -fsSL https://raw.githubusercontent.com/ducanh19020217/agenthub/main/scripts/install.sh -o /tmp/agenthub-install.sh
less /tmp/agenthub-install.sh
sh /tmp/agenthub-install.sh
```

Script có thể cập nhật/gỡ cài đặt an toàn; dùng `--dry-run` để xem lệnh trước. Dữ liệu `~/.agenthub/` chỉ bị xoá khi chạy `--uninstall --purge` và xác nhận.

### Cài đặt trên macOS

Máy Mac mới không cần cài Node.js, nvm hay Xcode Command Line Tools khi cài từ release. Installer chỉ dùng `curl` và `tar`, tự tải Node.js 22 chính thức đúng kiến trúc (`darwin-arm64` hoặc `darwin-x64`), kiểm tra `SHASUMS256.txt` và lưu runtime riêng tại `~/.agenthub/runtime/node-v22.x`. Linux cũng dùng runtime riêng nếu PATH không có Node 22.

Nếu muốn dùng nvm, chọn rõ bằng `--use-nvm`. Nếu cài từ source gặp lỗi thiếu Command Line Tools, chạy `xcode-select --install` rồi chạy lại. Các lỗi checksum hoặc archive sai kiến trúc thường được khắc phục bằng cách tải lại release đúng máy.

### Cài đặt thủ công

Yêu cầu môi trường: **Node.js >= 22** (hoặc dùng installer release để tự tải) và **npm**.

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
- `agenthub stop`: Tắt êm AgentHub, đưa task đang chạy về hàng chờ để lần sau tiếp tục.
- `agenthub stop --disable`: Tắt và không tự bật khi đăng nhập; `agenthub start` bật lại.
- Đóng tab web chỉ đóng giao diện; `uninstall-service` là gỡ service chứ không phải tắt tạm.
- `agenthub mcp-install`: Đăng ký AgentHub MCP server với Claude Code ở phạm vi người dùng (`claude mcp add --scope user agenthub ...`), cho phép Claude Code tương tác trực tiếp với AgentHub từ bất kỳ dự án nào (hỗ trợ cờ `--print`).
- `agenthub link`: Tạo symlink tiện ích tại `~/.local/bin/agenthub` trỏ tới script wrapper, giúp chạy lệnh `agenthub` từ bất kỳ thư mục nào trong terminal.

### Các lệnh quản lý bổ trợ:
- `agenthub status`: Xem nhanh số lượng hồ sơ, quota marks và trạng thái các task trong hàng đợi.
- `agenthub profile list|check|login`: Quản lý hồ sơ AI worker / Claude, kiểm tra kết nối quota và mở terminal đăng nhập tài khoản.
- `agenthub profile add <name> [--engine agy|claude|codex]`: Thêm hồ sơ worker (`agy`, `codex`) hoặc bộ não điều phối (`claude`).
- `agenthub project add <name> <path>`: Đăng ký một git repository vào AgentHub.
- `agenthub task add|list|show|log`: Thêm task mới, liệt kê danh sách task, xem chi tiết và tra cứu log thực thi.
- `agenthub clean`: Dọn dẹp các thư mục `node_modules` của các task đã hoàn thành để giải phóng dung lượng đĩa (hỗ trợ cờ `--dry-run`).

---

## 3. Điều khiển từ xa qua Telegram & Chuỗi dự phòng Claude

### Điều khiển từ xa qua Telegram
AgentHub tích hợp bot Telegram cho phép theo dõi task, duyệt code và trò chuyện trực tiếp với Claude từ điện thoại:
1. **Tạo bot**: Mở Telegram, chat với `@BotFather`, gửi lệnh `/newbot` để tạo bot và lấy mã HTTP API Bot Token.
2. **Cấu hình Token**: Nhập token trên trang **Settings** của Web Dashboard (hoặc ghi vào file `~/.agenthub/secrets/telegram.token` với quyền bảo mật `0600`).
3. **Ghép đôi an toàn (Pairing)**: Bấm **Tạo mã ghép đôi** trên Dashboard để nhận mã 6 chữ số (hiệu lực 5 phút), sau đó gửi mã này cho bot qua Telegram.
4. **Lệnh điều khiển**:
   - Quản lý hệ thống & task: `/status`, `/tasks [trạng thái]`, `/task <id>`, `/log <id>`, `/approve <id>`, `/reject <id> <nhận xét>`, `/cancel <id>`, `/retry <id>`, `/pause`, `/resume`.
   - Trò chuyện với Claude: Gửi tin nhắn văn bản thông thường, `/new` (mở phiên mới), `/stop` (dừng lượt chat).
   - Phê duyệt quyền công cụ: Khi Claude cần chạy lệnh kiểm tra, bot gửi tin nhắn kèm các nút inline: **Cho phép**, **Luôn cho phép**, **Từ chối**.
   - Bảo mật: Chỉ chat đã ghép đôi mới được phép gửi lệnh; bot token lưu biệt lập với quyền `0600` và không bao giờ để lộ ra ngoài.

### Chuỗi dự phòng khi hết token (Claude Fallback Chain)
Khi tài khoản Claude gặp lỗi giới hạn tốc độ (HTTP 429) hoặc hết hạn mức, AgentHub tự động kích hoạt chuỗi dự phòng cấu hình trong `brain.fallback`:
```json
{
  "brain": {
    "fallback": [
      { "type": "profile", "profile": "claude-team" },
      { "type": "model", "model": "haiku" },
      { "type": "apiKey", "dailyCapUSD": 5 },
      { "type": "engine", "engine": "codex" },
      { "type": "wait" }
    ]
  }
}
```
- Các bước dự phòng gồm: đổi hồ sơ Claude khác (`profile`), hạ model nhẹ hơn (`model: haiku`), dùng Anthropic API key có trần chi phí (`apiKey`), chuyển sang Codex reviewer (`engine: codex`), hoặc chờ mở khóa hạn mức (`wait`).
- **Cảnh báo chi phí API key**: Anthropic API key tính phí theo lượng token thực tế (pay-as-you-go). Luôn đặt trần chi phí hàng ngày (`dailyCapUSD`, ví dụ 5 USD/ngày) để tránh phát sinh chi phí ngoài ý muốn; API key được lưu tại `~/.agenthub/secrets/anthropic.key` với quyền `0600`.

---

## 4. Kiểm thử và Kiểm tra chất lượng mã nguồn

Chạy bộ kiểm tra tự động trước khi đóng gói hoặc triển khai:

```bash
# Kiểm tra lint, typecheck và chạy toàn bộ unit/integration test
npm run lint
npm run typecheck
npm test

# Kiểm thử giao diện web
npm run test:web
```

## Giấy phép

AgentHub phát hành theo giấy phép [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only).

- Bạn được dùng, sửa và phân phối lại miễn phí, kể cả cho mục đích thương mại.
- Nếu bạn phân phối bản đã sửa, hoặc cho người khác dùng bản đã sửa qua mạng (dịch vụ, SaaS), bạn phải công khai mã nguồn phần đã sửa theo cùng giấy phép.
- Cần dùng AgentHub mà không muốn chịu các điều kiện trên (ví dụ tích hợp vào sản phẩm đóng mã): liên hệ tác giả để có giấy phép thương mại.

Copyright (C) 2026 ducanh19020217
