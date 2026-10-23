# AgentHub — Kế hoạch v2

## Phạm vi v1 (bản đang phát hành)
v1 chỉ xử lý **nội bộ trên máy chạy hub**:
- Worker (Gravity/agy, Codex, Gemini, Claude) làm việc trong worktree local.
- Codex duyệt; khi Codex không dùng được thì Claude duyệt thay. Hub tự merge vào nhánh tích hợp **local**.
- Chỉ repo AgentHub có self-deploy và tự push. Hub **không** push code dự án khác ra ngoài.
- Điều khiển qua web dashboard, Telegram và MCP.
- **Không** kết nối hệ thống quản lý việc bên ngoài (OpenProject, Jira…) và **không** tạo merge request trên Git server.
- Đã chuyển lên v1 (23/10): **phòng ban** (nhóm project, tài khoản, giới hạn, bộ não theo phòng, chia lượt công bằng, topic Telegram theo phòng), **quy ước commit/nhánh theo project** (`externalRef`, autocheck `commit-message`), **chế độ tập trung** theo project, và Telegram tách theo project.

## Mục tiêu v2
Đưa hub ra làm việc với hệ thống của tổ chức: **nhận việc từ công cụ quản lý dự án, giao kết quả qua merge request**, đồng thời giữ mặc định an toàn.

### Nguyên tắc
1. **Chỉ đọc là mặc định.** Mỗi thao tác ghi ra bên ngoài (comment, đổi trạng thái, push, tạo MR) phải được bật riêng cho từng project, và có danh sách cho phép cụ thể.
2. **Có người duyệt ở chỗ quan trọng.** Kế hoạch chia việc từ việc bên ngoài mặc định chờ người duyệt (`planApproval: manual`). Có thể chuyển sang `auto` khi đã tin tưởng.
3. **Bí mật nằm ngoài cấu hình.** Token lưu trong `~/.agenthub/secrets/` (quyền 0600), không trả qua API, không ghi log, không commit.
4. **Dùng tài khoản bot,** quyền giới hạn trong project liên quan, không dùng tài khoản cá nhân.
5. **Polling là cách chính.** Hub chỉ nghe localhost, nên không nhận webhook từ bên ngoài.
6. **Kiểm tra khả năng trước khi gọi.** Đọc `_links`/quyền mà API trả về; thao tác nào không được phép thì bỏ qua và ghi log, không đoán.

## Các hạng mục

### A. Kết nối công cụ quản lý việc (tracker)
- Interface `Tracker` (`fetchNew`, `get`, `comment`, `transition`, `addChild`, `link`). Bản đầu tiên làm OpenProject (API v3), sau đó là Jira và GitLab Issues.
- Luồng: kéo work item theo bộ lọc → tạo **Kế hoạch** (Plan) → bộ não chia thành task có phụ thuộc → worker làm → duyệt → merge → đồng bộ ngược (comment tiến độ, đổi trạng thái theo bảng ánh xạ, tùy chọn tạo việc con).
- Bước chuyển trạng thái lấy từ workflow thật (form/transitions API), không hardcode.
- File quy định cho mỗi project (ví dụ `docs/AI-WORKFLOW.md`): việc nào được nhận, cách chia việc, thao tác nào AI được tự làm, thao tác nào phải hỏi người.
- Task nháp: `v2-openproject-sync`.

### B. Quy ước commit và nhánh theo project — *đã chuyển lên v1*
Phần nền (template nhánh/commit, `externalRef`, autocheck) làm trong v1. v2 chỉ thêm việc tự lấy mã việc từ tracker.

### C. Giao kết quả qua Git server (GitLab/GitHub)
- Sau khi duyệt xong: push nhánh và tạo **merge request** (không push thẳng vào nhánh chính). Tiêu đề và mô tả MR có mã việc để tracker tự liên kết.
- Theo dõi trạng thái MR và CI. Comment review của con người trên MR sẽ thành feedback cho worker.
- Bật riêng cho từng project, dùng token bot, có danh sách remote được phép.
- Task nháp: `v2-git-mr`.

### D. Phòng ban — *đã chuyển lên v1*
Xem các task `d-departments`, `d-brain-per-dept`, `d-fair-scheduler`, `d-telegram-topics`.

## Thứ tự đề xuất
1. **A** (tracker) ở chế độ chỉ đọc + tạo Kế hoạch. Sau đó bật comment, rồi bật đổi trạng thái.
2. **C** (merge request).

## Chuẩn bị phía tổ chức trước khi bật
- Tài khoản bot trên tracker và Git server, quyền giới hạn theo project.
- API token của bot. Admin bật API token, và nếu cần thì cấp quyền xem phần liên kết Git trên tracker.
- Bảng ánh xạ trạng thái của workflow (ví dụ: đang làm, chờ review, xong, tạm dừng).
- Nếu tracker hoặc Git server dùng chứng chỉ nội bộ: cung cấp CA để hub tin cậy.
