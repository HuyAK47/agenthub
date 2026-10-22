# Hai cách dùng AgentHub

AgentHub có hai mô hình điều phối. Chọn một mô hình cho mỗi project; không cần bật cả hai cùng lúc.

## So sánh nhanh

| | A. Hub độc lập | B. Qua MCP |
|---|---|---|
| Ai lập kế hoạch/review | Bộ não của hub | Claude Code bên ngoài |
| Nơi giao việc | Web Chat, Tasks hoặc Telegram | Claude Code trong VS Code/terminal |
| Cấu hình brain | `auto` hoặc `suggest` | Project đặt `external` (hoặc global `off`) |
| Cần `claude` CLI | Có, phải đăng nhập và còn quota; không cần mở IDE | Có, phải đăng nhập và còn quota |
| Theo dõi | Dashboard và Telegram | Tool `hub_*`, Dashboard và Telegram |

## A. Hub độc lập

### Nên chọn khi nào?

Chọn A nếu bạn muốn giao một mục tiêu từ web hoặc điện thoại, không muốn mở IDE, và để AgentHub tự lập kế hoạch, tạo task, theo dõi worker và đưa việc ra review.

### Điều kiện cần

- AgentHub daemon đang chạy, có ít nhất một project đã đăng ký.
- Ít nhất một tài khoản worker đã đăng nhập: Antigravity CLI (`agy`) và/hoặc Codex CLI.
- CLI `claude` đã cài, có profile/tài khoản đăng nhập và còn quota cho brain của hub; bạn không cần mở IDE hay chạy Claude Code tương tác.
- Quota của worker đủ cho task.
- Telegram là tùy chọn; cần bot token và một chat đã ghép đôi nếu muốn điều khiển từ xa.

### Cài đặt và thiết lập

1. Mở Dashboard, hoàn tất Setup, đăng nhập worker và đăng ký project giả sử tên `my-app`.
2. Vào Settings để đặt brain toàn cục là `auto` (tự lập kế hoạch/giao việc) hoặc `suggest` (chỉ gợi ý). Có thể để `off` nếu không dùng brain.
3. Trong Project settings, chọn `inherit` để dùng cấu hình toàn cục, hoặc chọn `auto`/`suggest` riêng cho project.
4. Nếu cần Telegram, tạo bot, lưu token trong Settings, tạo mã pairing rồi gửi mã cho bot. Chỉ chat đã ghép đôi mới điều khiển được hub.

### Một vòng làm việc

1. Giao việc: vào Web Chat/Tasks hoặc gửi `/newtask` trên Telegram, ví dụ “Thêm bộ lọc trạng thái cho `my-app`, chạy test và chuẩn bị review”.
2. Theo dõi: xem Dashboard, Tasks và log; Telegram có `/status`, `/tasks`, `/task <id>` và thông báo trạng thái.
3. Review: đọc check result, diff và log trên Dashboard; dùng nút Approve/Reject hoặc lệnh Telegram tương ứng.
4. Merge/deploy: sau khi review đạt, dùng cấu hình integration/deploy của project. Không tự giả định deploy production đã bật; kiểm tra trạng thái trên Projects.

### Thiết lập liên quan

- `brain.mode`: `auto`, `suggest`, `off`; project có thể `inherit` hoặc override.
- `brain.permissions`: `standard`, `trusted`, `full`; project cũng có thể `inherit`. `full` bỏ qua prompt quyền nên chỉ dùng với project tin cậy.
- `notifications.telegramContent`: `full` hoặc `minimal` theo project.
- Telegram chỉ là kênh điều khiển/thông báo; token được quản lý bởi hub và chat phải pairing.

### Lỗi thường gặp

- Brain không làm gì: kiểm tra mode hiệu lực của project, daemon, tài khoản worker và quota.
- Telegram không phản hồi: kiểm tra token, bot đã bật và chat đã ghép đôi; xem lại trạng thái trên Settings.
- Task chờ mãi: xem quota, slot song song, disk/load guard và log task.
- Không thấy kết quả review: chờ worker/check hoàn tất rồi mở task detail; không đánh dấu hoàn thành chỉ vì worker đã dừng.

## B. Dùng qua MCP

### Nên chọn khi nào?

Chọn B nếu Claude Code trong VS Code hoặc terminal là nơi bạn muốn viết kế hoạch, gọi tool và review. AgentHub khi đó cung cấp scheduler, worktree, worker, check và trạng thái; Claude bên ngoài là coordinator.

### Điều kiện cần

- AgentHub daemon đang chạy và project đã đăng ký.
- CLI `claude` đã cài, đăng nhập và còn quota.
- Có worker CLI và quota worker để thực thi task.
- Claude Code phải đọc được cấu hình MCP do `agenthub mcp-install` đăng ký.

### Cài đặt và thiết lập

1. Cài/đăng nhập `claude`, rồi đảm bảo lệnh `agenthub` có trong PATH.
2. Chạy:

   ```bash
   agenthub mcp-install
   ```

   Lệnh này đăng ký MCP server AgentHub với Claude Code ở phạm vi user.
3. Khởi động lại phiên Claude Code nếu cần và kiểm tra các tool `hub_*`, chẳng hạn `hub_status`, `hub_projects`, `hub_create_task`, `hub_task`, `hub_review` và `hub_wait`.
4. Vào Project settings của `my-app`, đặt Brain thành **Claude ngoài (VS Code) điều phối** (`brain.mode = external`). Khi external, brain của hub bỏ qua event của project và chỉ thông báo.

### Một vòng làm việc

1. Giao việc: yêu cầu Claude Code phân tích mục tiêu, sau đó gọi `hub_create_task` (hoặc `hub_create_batch` nếu có nhiều task).
2. Theo dõi: Claude gọi `hub_status`, `hub_tasks`, `hub_task`/`hub_task_log` hoặc `hub_wait`; Dashboard vẫn hiển thị trạng thái và log.
3. Review: sau khi check xong, Claude đọc task/diff và gọi `hub_review` với `approved` hoặc `changes_requested` kèm nhận xét.
4. Merge/deploy: nếu project đã bật integration/auto-merge và review chain đạt, hub thực hiện theo cấu hình; nếu chưa, Claude hoặc người dùng tiếp tục qua Projects/Dashboard. Xác nhận kết quả cuối cùng trong hub.

### Thiết lập liên quan

- `brain.mode = external` theo project là cách khuyến nghị để kết hợp B với A ở project khác.
- `brain.permissions` vẫn kiểm soát quyền của phiên brain/chat; external không biến Claude Code thành worker và không tự cấp quyền `full`.
- MCP có các tool đọc trạng thái, project/profile, tạo/sửa task, batch, retry/cancel, review, wait, git, usage và pause/resume. Tool bị giới hạn theo project khi phiên MCP có scope project.
- Telegram vẫn có thể bật để nhận thông báo hoặc thao tác khẩn cấp, nhưng không thay thế coordinator Claude Code.

### Lỗi thường gặp

- Claude không thấy tool: chạy lại `agenthub mcp-install`, kiểm tra daemon và khởi động phiên Claude Code mới.
- Tool báo daemon chưa chạy: chạy `agenthub daemon` hoặc cài service rồi kiểm tra Dashboard.
- Project bị brain hub tự động xử lý: mode hiệu lực chưa phải `external`; lưu lại settings của đúng project.
- Review bị từ chối: đọc feedback/check result, giao task retry hoặc yêu cầu Claude sửa rồi gọi review lại.
- Hết quota Claude: phiên MCP không thể điều phối; chờ quota hoặc dùng mô hình A nếu project được cấu hình phù hợp.

## Kết hợp hai cách

Có thể dùng A cho một số project và B cho project khác. Đặt global `brain.mode` theo mặc định chung, rồi vào từng Project settings chọn `external` cho project do Claude Code quản lý. Các project còn lại có thể `inherit` để dùng `auto`/`suggest`. Tránh để cả brain của hub và Claude Code cùng lập kế hoạch cho một project; chọn `external` để phân quyền rõ ràng.

Xem thêm: [Getting Started](GETTING-STARTED.md), [System Plan](PLAN.md).
