# Hướng dẫn sử dụng AgentHub

## Tắt / bật AgentHub

`agenthub stop` gọi shutdown có xác thực, đưa task đang chạy về hàng chờ để resume rồi dừng daemon. Thêm `--disable` để service không tự bật khi đăng nhập; dùng `agenthub start` để bật lại và chờ health OK. Đóng tab web chỉ đóng giao diện. `agenthub uninstall-service` là gỡ service, không phải tắt tạm.

AgentHub là nền tảng điều phối cục bộ (local hub) giúp người dùng và **Claude Code** quản lý, giao việc và giám sát các AI coding worker (Antigravity CLI / Gemini và OpenAI Codex CLI). Tài liệu này hướng dẫn chi tiết cách sử dụng hệ thống từ giao diện Web Dashboard và CLI.

> [!TIP]
> Để tìm hiểu chi tiết cơ chế hoạt động, công thức tính toán và mẹo khắc phục lỗi cho từng tính năng, hãy xem [Tài liệu danh sách tính năng (docs/FEATURES.md)](FEATURES.md).

---

## 1. Thêm và quản lý tài khoản AI Worker (Gemini / Antigravity)

Để tận dụng tối đa quota miễn phí hoặc đa tài khoản, AgentHub cho phép bạn chạy song song nhiều tài khoản Antigravity (`agy`) hoàn toàn cách ly với nhau mà không sợ xung đột phiên.

### 1.1 Thêm tài khoản trên Web Dashboard
1. Truy cập Web Dashboard bằng lệnh `agenthub open` hoặc mở trình duyệt tại `http://127.0.0.1:7700`.
2. Chuyển sang mục **Tài khoản** (Profiles) trên thanh điều hướng.
3. Nhấp vào nút **+ Thêm tài khoản**.
4. Nhập tên định danh cho hồ sơ mới (ví dụ: `g4`, `work`, `ca-nhan` — chỉ dùng chữ cái, số và dấu gạch ngang/dưới).
5. Một cửa sổ dòng lệnh (terminal xterm) sẽ xuất hiện trực tiếp ngay trên trang web để bắt đầu quá trình xác thực OAuth của `agy`.

### 1.2 Thêm tài khoản qua dòng lệnh CLI
Bạn cũng có thể khởi tạo và đăng nhập trực tiếp từ terminal:
```bash
source ~/.nvm/nvm.sh && nvm use 22
agenthub profile login <tên_hồ_sơ>
# Ví dụ: agenthub profile login g4
```

### 1.3 Mẹo quan trọng: "Sử dụng tài khoản khác" (Use another account)
> [!IMPORTANT]
> **Tránh bị trùng tài khoản:**  
> Khi `agy` mở trình duyệt để xác thực OAuth với Google, trình duyệt thường sẽ tự động đăng nhập bằng tài khoản Google bạn đang dùng sẵn.  
> **Bạn phải chọn "Sử dụng tài khoản khác" (Use another account)** trên trang đăng nhập Google và điền thông tin tài khoản mong muốn.

Sau khi đăng nhập thành công trên trình duyệt:
- Quay trở lại cửa sổ terminal (trên web hoặc CLI).
- Gõ `/exit` hoặc nhấn `Ctrl+C` để hoàn tất phiên đăng nhập.
- AgentHub sẽ tự động đọc email từ file log và cập nhật vào danh sách hồ sơ trên dashboard.

### 1.4 Kiểm tra tình trạng tài khoản (Check profile)
- Trên dashboard: bấm nút **Check** bên cạnh tài khoản để gửi lệnh thử nghiệm nhanh (`gemini-3.8-flash-low`).
- Qua CLI: chạy `agenthub profile check <tên_hồ_sơ>` hoặc `agenthub profile check` (kiểm tra tất cả).

---

## 2. Hướng dẫn đọc Web Dashboard

Dashboard cung cấp cái nhìn trực quan toàn diện về tiến độ dự án, trạng thái tài nguyên và nhật ký thực thi trực tiếp.

### 2.1 Bảng số liệu tổng quan & Dòng sự kiện
- **Thống kê task**: Các thẻ trên đầu trang hiển thị tổng số task đang chạy, chờ duyệt, chờ quota và thất bại.
- **Worker đang chạy**: Danh sách các tiến trình worker đang thực thi, gồm mã task, model đang dùng, tài khoản phụ trách và thời gian đã chạy (`elapsed`).
- **Hoạt động gần đây (SSE stream)**: Luồng sự kiện theo thời gian thực (task được đưa vào hàng đợi, bắt đầu chạy, hoàn thành, hết quota...).

### 2.2 Ý nghĩa trạng thái Task và màu sắc nhận diện

| Trạng thái | Nhãn hiển thị | Màu sắc | Ý nghĩa và hành động tiếp theo |
|---|---|---|---|
| `draft` | **Nháp** | Xám phiến (Slate) | Task đã được tạo cấu hình nhưng chưa đưa vào hàng đợi. Nhấn **Bắt đầu** để chuyển sang `queued`. |
| `queued` | **Chờ chạy** | Xám (Gray) | Task đang chờ trong hàng đợi. Scheduler sẽ tự động phân phối khi có slot worktree và tài khoản phù hợp còn quota. |
| `running` | **Đang chạy** | Xanh dương (Blue, chấm nhấp nháy) | Worker đang chạy trên worktree riêng. Nhấp vào task để xem **log trực tiếp** (live log streaming). |
| `review` | **Chờ duyệt** | Tím (Purple) | Worker đã hoàn thành mã nguồn và tạo báo cáo `DONE`. Đang chờ Claude Code hoặc người dùng review. |
| `done` | **Hoàn thành** | Xanh lá (Emerald) | Mã nguồn đã được review chấp thuận (`approved`). Bạn có thể bấm **Xóa worktree** để giải phóng dung lượng đĩa. |
| `blocked` | **Bị chặn** | Cam (Orange) | Worker gặp vướng mắc không tự giải quyết được và tạo báo cáo `BLOCKED`. Cần người dùng hoặc Claude Code can thiệp. |
| `failed` | **Lỗi** | Đỏ (Rose) | Tiến trình bị lỗi runtime, crash hoặc kết thúc bất thường. Có thể nhấn **Thử lại** (Retry) kèm ghi chú. |
| `waiting_quota` | **Chờ quota** | Vàng hổ phách (Amber) | Tất cả tài khoản cho các model trong chuỗi đều đã chạm ngưỡng giới hạn quota. Task sẽ tự chạy lại khi hết thời gian khóa. |
| `cancelled` | **Đã hủy** | Xám kẽm (Zinc) | Task đã bị hủy bởi người dùng hoặc Claude Code. |

### 2.3 Trạng thái hồ sơ tài khoản
- **Đang bận (`busy`)**: Tài khoản đang có 1 worker chạy. Mỗi tài khoản chỉ nhận 1 task tại một thời điểm để đảm bảo an toàn quota và tài nguyên.
- **Khóa Quota (`Quota Marks`)**: Huy hiệu màu vàng cam hiển thị họ model bị khóa (ví dụ: `gemini` hoặc `claude`) kèm đồng hồ đếm ngược thời gian mở khóa tự động.
- **Cảnh báo trùng email (Tam giác vàng)**: Cảnh báo khi có từ 2 hồ sơ trở lên đăng nhập cùng một địa chỉ email Google.

---

## 3. Quy trình làm việc cùng Claude Code

Quy trình chuẩn kết hợp sức mạnh kiến trúc của Claude Code và năng lực thực thi tự động của AgentHub:

```
┌──────────────────┐               ┌──────────────────┐               ┌──────────────────┐
│   Claude Code    │ ──(1) create──▶│     AgentHub     │ ──(2) spawn──▶│    AI Worker     │
│  (Architect/QA)  │ ◀──(4) review──│ (Scheduler & WT) │ ◀──(3) done───│  (agy / codex)   │
└──────────────────┘               └──────────────────┘               └──────────────────┘
```

### 3.1 Quy trình sử dụng hằng ngày (Daily Workflow)

Dưới đây là chu trình làm việc chuẩn được khuyến nghị mỗi ngày:

1. **Khởi động AgentHub và mở Dashboard**:
   - Nếu đã cài đặt systemd user service (`agenthub install-service`), daemon sẽ tự chạy nền khi bạn đăng nhập.
   - Nếu chạy thủ công từ terminal:
     ```bash
     source ~/.nvm/nvm.sh && nvm use 22
     agenthub daemon
     ```
   - Mở Web Dashboard trên trình duyệt:
     ```bash
     agenthub open
     ```
2. **Kiểm tra trạng thái tài khoản và hạn mức**:
   - Vào mục **Tài khoản** (Profiles) trên dashboard.
   - Quan sát hạn mức thực tế (`/usage`) của từng tài khoản (chu kỳ 5 giờ và tuần).
   - Nếu tài khoản hiển thị "Cần xác minh" (`needs_verification`), nhấp vào đường link Google Verification được hệ thống tự động bóc tách để hoàn tất xác thực trên trình duyệt (xem [Mục 6 của FEATURES.md](FEATURES.md#6-hạn-mức-thật-usage-trạng-thái-đăng-nhập--xác-minh-tài-khoản)).
3. **Lập kế hoạch và giao việc**:
   - **Cách 1 (Khuyên dùng)**: Mở Claude Code trong terminal và sử dụng các công cụ MCP AgentHub (như `hub_create_task`) để chia việc.
   - **Cách 2**: Sử dụng tính năng **Trò chuyện** (Chat) trực tiếp trên Web Dashboard để yêu cầu Claude phân tích yêu cầu và giao việc cho worker (xem [Mục 1 của FEATURES.md](FEATURES.md#1-chat-với-claude-điều-phối-viên)).
   - **Cách 3**: Tạo task trực tiếp trên Dashboard hoặc qua CLI: `agenthub task add <tên_dự_án> "<tiêu đề>"`.
4. **Theo dõi Worker thực thi và Autocheck**:
   - Scheduler tự động cấp phát git worktree riêng biệt, cấp phát slot và khởi chạy AI worker phù hợp còn quota (Gemini Flash hoặc Codex).
   - Bạn có thể nhấp vào task đang chạy trên Dashboard để xem trực tiếp luồng log thực thi (live streaming logs).
   - Khi worker hoàn thành, task chuyển sang trạng thái **`checking` ("Đang kiểm tra")** để chạy bộ autocheck. Nếu có lỗi, worker sẽ tự động sửa tối đa 2 lần trước khi chuyển sang review (xem [Mục 3 của FEATURES.md](FEATURES.md#3-autocheck-trạng-thái-đang-kiểm-tra--lệnh-npm-run-checkmigrate)).
5. **Review và nghiệm thu mã nguồn**:
   - Task chuyển sang trạng thái `review`. Claude Code ở terminal sẽ tự động đón sự kiện hoặc bạn có thể gọi `hub_review`.
   - Nếu Claude hết quota, hệ thống tự động kích hoạt **Codex reviewer dự phòng**.
   - Nếu task rơi vào trạng thái **"Chờ người duyệt"** (`reviewerEscalated`), bạn có thể bấm nút **"Chạy lại reviewer"** hoặc trực tiếp duyệt (`approved`) / yêu cầu sửa đổi (`changes_requested`) trên dashboard (xem [Mục 2 của FEATURES.md](FEATURES.md#2-reviewer-dự-phòng-bằng-codex--trạng-thái-chờ-người-duyệt)).
6. **Đánh giá hiệu quả và bảo trì ổ đĩa**:
   - Vào mục **Hiệu quả** (Savings) để xem thống kê số token Claude đã tiết kiệm được, chi phí và tỷ lệ tiết kiệm (xem [Mục 7 của FEATURES.md](FEATURES.md#7-trang-hiệu-quả-ủy-quyền-savings-page)).
   - Định kỳ dọn dẹp các thư mục `node_modules` của các task đã hoàn tất bằng lệnh CLI:
     ```bash
     agenthub clean
     ```

### 3.2 Chi tiết các bước phối hợp giữa Claude Code và AI Worker

1. **Claude Code lập kế hoạch và tạo task qua MCP**:
   - Claude Code gọi tool `hub_create_task` với tiêu đề, nội dung chi tiết đề bài, cấp độ (`easy` hoặc `hard`), nhánh cơ sở và quan hệ phụ thuộc (`dependsOn`).
2. **AgentHub tự động lập lịch và khởi chạy worker**:
   - Scheduler tạo git worktree độc lập (`agenthub/<slug>`), tạo file môi trường `.env`.
   - Lựa chọn model và hồ sơ phù hợp còn quota (ưu tiên Gemini Flash High/Medium rồi fallback sang Codex Luna).
   - Worker nhận đề bài tại `.agenthub/task.md` và thực hiện code tuần tự trên worktree riêng.
3. **Worker hoàn tất và gửi tín hiệu**:
   - Khi hoàn thành, worker commit mã nguồn theo chuẩn Conventional Commits và tạo file `.agenthub/DONE`.
   - AgentHub phát hiện marker `DONE`, chuyển trạng thái task sang `checking` để chạy autocheck rồi sang `review` và phát sự kiện `task.review_ready`.
4. **Claude Code review kết quả**:
   - Claude Code dùng tool `hub_wait` để đón sự kiện hoặc `hub_task` để lấy thông tin chi tiết: đường dẫn worktree, danh sách commit, nội dung báo cáo nghiệm thu.
   - Claude Code tự đọc git diff trong thư mục worktree để đánh giá chất lượng mã nguồn và độ bao phủ kiểm thử.
5. **Duyệt hoặc yêu cầu sửa đổi**:
   - **Chấp thuận**: Claude Code gọi `hub_review(verdict='approved')` → task chuyển sang `done`. Hệ thống tự động xóa `node_modules` để tiết kiệm đĩa.
   - **Yêu cầu chỉnh sửa**: Claude Code gọi `hub_review(verdict='changes_requested', feedback='...')` → AgentHub chèn phản hồi review vào đề bài, xóa marker cũ và đưa task trở lại hàng đợi `queued` để worker sửa tiếp.

### 3.3 Cấu hình autocheck kiểm tra migration trên DB thật (dành cho người review)

Để bảo vệ cơ sở dữ liệu thật khỏi rủi ro migration làm hỏng schema hoặc mất mát dữ liệu, người review có thể cấu hình autocheck `migrate-live` cho project `agenthub`. Check này sẽ tự động chạy `npm run check:migrate` ngay sau bước `build`, chạy kiểm tra an toàn trên một bản sao của `~/.agenthub/hub.db`.

Cấu hình qua API `PATCH /api/projects/agenthub` bằng `curl`:

```bash
TOKEN=$(cat ~/.agenthub/token)

curl -X PATCH http://127.0.0.1:7700/api/projects/agenthub \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "checks": [
      { "name": "lint", "cmd": ["npm", "run", "lint"] },
      { "name": "typecheck", "cmd": ["npm", "run", "typecheck"] },
      { "name": "test", "cmd": ["npm", "run", "test", "--", "--run"] },
      { "name": "build", "cmd": ["npm", "run", "build"] },
      { "name": "migrate-live", "cmd": ["npm", "run", "check:migrate"] },
      { "name": "build:web", "cmd": ["npm", "--prefix", "web", "run", "build"] },
      { "name": "test:web", "cmd": ["npm", "--prefix", "web", "run", "test", "--", "--run"] }
    ]
  }'
```

> [!NOTE]
> Check `{name: 'migrate-live', cmd: ['npm', 'run', 'check:migrate']}` được đặt **ngay sau bước build** (để `dist/db/index.js` đã được biên dịch sẵn). Script mở DB thật ở chế độ readonly để `.backup()` ra thư mục tạm, sau đó gọi `openDatabase` trên bản sao nhằm kiểm tra `PRAGMA foreign_key_check` rỗng, `PRAGMA integrity_check` là `ok`, và số dòng của các bảng `tasks`, `runs`, `profiles` không bị giảm. Nếu môi trường không có DB thật, check sẽ tự động in "bỏ qua" và kết thúc thành công với mã 0. Xem thêm tại [Mục 3 của FEATURES.md](FEATURES.md#3-autocheck-trạng-thái-đang-kiểm-tra--lệnh-npm-run-checkmigrate).

---

## 4. Xử lý sự cố thường gặp (Troubleshooting)

### 4.1 Hết quota (RESOURCE_EXHAUSTED / Mã lỗi 429)
- **Hiện tượng**: Task chuyển sang trạng thái `waiting_quota`, trên trang Tài khoản xuất hiện quota mark kèm đếm ngược (mặc định 5 giờ hoặc theo thông báo của API).
- **Cơ chế xử lý tự động**: AgentHub sẽ tự động chuyển sang hồ sơ khác hoặc fallback sang model tiếp theo trong chuỗi cấu hình (ví dụ từ Gemini sang Codex). Nếu tất cả đều hết quota, hệ thống sẽ tạm dừng task và tự động kích hoạt lại ngay khi quota mark hết hạn.
- **Can thiệp thủ công**: Nếu bạn biết tài khoản đã được cấp lại quota trước thời hạn, hãy bấm nút **Xóa quota** (Clear Quota) trên trang Tài khoản để mở lại ngay lập tức.

### 4.2 Lỗi 503 (Service Unavailable / Eligibility check failed)
- **Hiện tượng**: Output của agy báo lỗi kết nối máy chủ Google: `UNAVAILABLE (code 503): The service is currently unavailable` hoặc `Eligibility check failed`.
- **Cơ chế xử lý**: AgentHub coi đây là lỗi tạm thời của hệ thống mạng/dịch vụ chứ **không phải lỗi hết quota**, do đó không đánh dấu quota tài khoản. Hệ thống tự động thử lại tối đa 3 lần với thời gian chờ giãn cách (60s, 120s, 180s).
- **Hành động**: Nếu sau 3 lần vẫn lỗi, task sẽ chuyển sang `failed`. Bạn chỉ cần đợi dịch vụ ổn định và bấm nút **Thử lại** (Retry) trên dashboard.

### 4.3 Cảnh báo trùng tài khoản (Duplicate Email Warning)
- **Hiện tượng**: Thẻ tài khoản hiển thị tam giác cảnh báo màu vàng "Trùng email với...".
- **Nguyên nhân**: Khi đăng nhập tài khoản mới bằng `agenthub profile login`, người dùng chưa chọn "Sử dụng tài khoản khác" nên trình duyệt tự động dùng lại phiên Google cũ.
- **Hậu quả**: Vì 2 hồ sơ thực chất cùng 1 tài khoản Google, việc hết quota ở hồ sơ này sẽ đồng thời khóa luôn hồ sơ kia.
- **Cách sửa**: Bấm **Đăng nhập lại** trên dashboard (hoặc chạy lại lệnh CLI), sau đó nhớ bấm chọn **"Sử dụng tài khoản khác"** trên trang Google OAuth.

### 4.4 Dashboard bị trắng trang
- **Hiện tượng**: Truy cập `http://127.0.0.1:7700` nhưng trình duyệt chỉ hiện màn hình trắng, hoặc console của trình duyệt báo lỗi không tìm thấy file bundle JS/CSS (`404 Not Found`).
- **Nguyên nhân**: Thư mục `dist/web/` chưa được build hoặc bản build web bị thiếu sau khi cập nhật/pull mã nguồn mới.
- **Cách khắc phục**:
  ```bash
  source ~/.nvm/nvm.sh && nvm use 22
  npm run build:web
  ```
  Sau khi lệnh build hoàn tất, tải lại trang web bằng tổ hợp phím `Ctrl + F5` (hoặc `Cmd + Shift + R` trên macOS) để xóa cache trình duyệt.

### 4.5 Task bị kẹt ở trạng thái review ("Chờ người duyệt")
- **Hiện tượng**: Task dừng ở trạng thái `review` rất lâu mà không có phản hồi, hoặc hiển thị nhãn màu cam **"Chờ người duyệt"** (`reviewerEscalated: 1`).
- **Nguyên nhân**:
  1. Claude Code ở terminal chưa gọi công cụ review (`hub_wait` / `hub_review`), hoặc phiên Claude Code đã thoát.
  2. Claude hết quota và failover sang Codex reviewer, nhưng Codex reviewer gặp các tình huống cần con người can thiệp:
     - Worker đã được yêu cầu sửa quá số lần tối đa (`reviewer_changes_limit`, mặc định 2 lần) mà vẫn chưa đạt yêu cầu.
     - Reviewer gặp lỗi môi trường chỉ đọc của chính nó (`reviewer_environment`).
     - Task chưa có kết quả autocheck hợp lệ đã lưu (`missing_autocheck_results`).
- **Cách khắc phục**:
  - Nhấp vào task trên Dashboard để đọc log chi tiết của worker và reviewer.
  - Nếu muốn Codex thử review lại, bấm nút **"Chạy lại reviewer"** (Retry reviewer) trên Dashboard hoặc trang chi tiết task.
  - Người dùng có thể trực tiếp review thủ công: Bấm nút **Duyệt** (`approved`) nếu thấy code đạt yêu cầu, hoặc nhập feedback cụ thể và bấm **Yêu cầu sửa** (`changes_requested`).
  - Nếu đang mở Claude Code trong terminal, bạn có thể gọi tool:
    ```json
    hub_review(taskId: "<task-id>", verdict: "approved")
    ```
  - Chi tiết về cơ chế này: xem [Mục 2 của FEATURES.md](FEATURES.md#2-reviewer-dự-phòng-bằng-codex--trạng-thái-chờ-người-duyệt).

### 4.6 Đầy ổ đĩa hoặc task bị tạm dừng do thiếu dung lượng
- **Hiện tượng**: Task chuyển sang trạng thái `waiting_quota` kèm lý do `disk`, trên desktop xuất hiện thông báo nổi: *"Ổ đĩa còn X GB (< 3 GB): tạm dừng khởi chạy task"*.
- **Nguyên nhân**: Dung lượng còn trống tại thư mục chứa git worktrees (`~/.agenthub/worktrees`) nhỏ hơn ngưỡng an toàn `disk.minFreeGB` (mặc định là 3 GB). Hệ thống tự động kích hoạt cơ chế an toàn để tránh làm treo hệ điều hành do cạn kiệt dung lượng đĩa.
- **Cách khắc phục**:
  1. Dọn dẹp thư mục `node_modules` của các task đã hoàn thành bằng lệnh CLI:
     ```bash
     source ~/.nvm/nvm.sh && nvm use 22
     # Kiểm tra trước dung lượng dự kiến giải phóng:
     agenthub clean --dry-run
     # Thực hiện dọn dẹp thật:
     agenthub clean
     ```
  2. Xóa các git worktree của task cũ: Trên Web Dashboard, bấm nút **"Xóa worktree"** trên các thẻ task có trạng thái `done`.
  3. Nếu ổ cứng của bạn có dung lượng hạn chế nhưng muốn tiếp tục chạy task, bạn có thể hạ ngưỡng cảnh báo trong `~/.agenthub/config.json`:
     ```json
     {
       "disk": {
         "minFreeGB": 1
       }
     }
     ```
  - Ngay khi dung lượng trống đạt trên ngưỡng `minFreeGB`, AgentHub sẽ phát sự kiện `disk.ok` và tự động đưa các task đang chờ trở lại hàng đợi `queued` để tiếp tục thực thi (xem [Mục 5 của FEATURES.md](FEATURES.md#5-chặn-khi-ổ-đĩa-gần-đầy-tự-dọn-nodemodules--lệnh-agenthub-clean)).

### 4.7 Thông báo desktop không tắt được hoặc bị kẹt
- **Hiện tượng**: Các cửa sổ thông báo nổi (desktop alerts) của AgentHub xuất hiện cố định trên màn hình, không tự biến mất sau 10 giây hoặc xếp chồng đè lên nhau gây vướng tầm nhìn.
- **Nguyên nhân**:
  - AgentHub luôn gửi thông báo qua lệnh hệ thống `notify-send` kèm cờ thời gian tự tắt `-t 10000` (10 giây) và cờ gom nhóm `-a AgentHub`.
  - Tuy nhiên, một số trình quản lý thông báo trên Linux (như bản cũ của `dunst`, `mako`, `xfce4-notifyd`) có thể bỏ qua cờ `-t` trong cấu hình, hoặc tiến trình notification daemon của desktop bị treo.
- **Cách khắc phục**:
  1. Khởi động lại daemon thông báo trên máy tính:
     ```bash
     killall dunst && dunst &    # Nếu desktop dùng dunst
     killall mako && mako &      # Nếu desktop dùng mako
     ```
  2. Kiểm tra cấu hình của notification daemon (ví dụ trong file `~/.config/dunst/dunstrc`, đảm bảo tùy chọn `timeout` không bị đặt cố định thành `0`).
  3. Nếu không muốn nhận thông báo desktop từ AgentHub, bạn có thể tắt tính năng này trong cấu hình `~/.agenthub/config.json`:
     ```json
     {
       "notifications": {
         "desktop": false
       }
     }
     ```
     Sau đó khởi động lại daemon: `agenthub daemon` (hoặc restart systemd service).
  - Chi tiết về thông báo desktop: xem [Mục 9 của FEATURES.md](FEATURES.md#9-thông-báo-desktop-desktop-notifications).

### 4.8 Xử lý sự cố máy bị crash hoặc mất điện đột ngột
- Khi máy tính bị tắt đột ngột trong lúc worker đang ghi code hoặc git đang ghi commit, một số file có thể bị rỗng (0 bytes) hoặc loose object của git bị lỗi:
  - Kiểm tra tính toàn vẹn git: `git fsck` (nếu có corrupt object, xóa object hỏng đó trong `.git/objects/`).
  - Tìm nhanh các file rỗng trong dự án: `find . -size 0` để kiểm tra và khôi phục từ git checkout.

### 4.9 Chẩn đoán worker có vẻ bị treo

Khi thấy một worker đang ở trạng thái `running` nhưng không in thêm log trong một khoảng thời gian dài, bạn có thể thực hiện 3 bước kiểm tra sau để xác định worker đang làm việc bình thường hay thực sự bị treo:

1. **Xem `activitySource` và `lastActivityAt` trong `currentRun`**:
   - Truy vấn thông tin task đang chạy qua API (hoặc xem trên Web dashboard):
     ```bash
     TOKEN=$(cat ~/.agenthub/token)
     curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7700/api/tasks/<task-id> | jq .currentRun
     ```
   - Kết quả trả về gồm:
     - `activitySource`: Cho biết nguồn hoạt động gần nhất (`'log'`, `'conversation'`, hoặc `'worktree'`). Ví dụ với Antigravity (`agy`), khi agent đang gọi công cụ hoặc suy nghĩ mà không in stdout, `activitySource` sẽ là `'conversation'` hoặc `'worktree'`.
     - `lastActivityAt`: Mốc thời gian của hoạt động gần nhất. Nếu mốc này vẫn được cập nhật trong vòng dưới 20 phút (`watchdog.stallMinutes`), worker vẫn đang hoạt động bình thường chứ không bị treo.
2. **Kiểm tra lịch sử run kẹt (`runs.reason = 'stalled'`)**:
   - Trong dữ liệu task (`runs`) hoặc bảng `runs` của `hub.db`, kiểm tra các lượt chạy trước:
     ```bash
     curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7700/api/tasks/<task-id> | jq '.runs[] | {id, status, reason}'
     ```
   - Nếu có run kết thúc với `reason: "stalled"`, watchdog đã từng phát hiện worker bị kẹt và tự động can thiệp (diệt nhóm tiến trình, giải phóng lock, và đưa task trở lại hàng đợi `queued` với cờ `resume: 1` kèm ghi chú nhắc nhở trong đề bài).
   - Lưu ý: Hệ thống chỉ tự động thử lại tối đa 2 lần (`stalledCount <= 2`). Đến lần thứ 3, task sẽ chuyển sang `failed` với lý do `stalled_limit`.
3. **Xem cây tiến trình hệ thống (Process Tree)**:
   - Sử dụng PID của worker (từ thông tin run hoặc danh sách tiến trình) để xem cây tiến trình:
     ```bash
     # Tìm PID của worker agy hoặc codex đang chạy
     ps aux | grep -E "agy|codex"
     # Xem cây tiến trình chi tiết của worker
     pstree -ap <PID>
     # Hoặc: ps -f --forest -g <PID>
     ```
   - Kiểm tra xem tiến trình con có đang chờ lệnh tương tác (như lệnh sudo/git hỏi mật khẩu hoặc xác nhận bàn phím) hoặc chạy lệnh nền không thoát (như test suite chạy chế độ watch, dev server không có timeout) hay không.

