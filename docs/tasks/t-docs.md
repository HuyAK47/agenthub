# Task: t-docs – Cập nhật tài liệu (task nhỏ, khoảng 20 phút, chỉ sửa tài liệu)

Nhánh: `t-docs`. **Phạm vi file: `docs/PLAN.md`, `README.md`, file mới `docs/USAGE.md`.** Không sửa code.
**Riêng task này được phép sửa `docs/PLAN.md`.**
Khi xong tạo `docs/tasks/t-docs.DONE`.

## Yêu cầu
1. `docs/PLAN.md`:
   - **Mục 3.5:** chuỗi model mặc định hiện nay là `hard`: `gemini-3.8-flash-high` → `codex:gpt-5.6-luna`; `easy`: `gemini-3.8-flash-medium` → `codex:gpt-5.6-luna`. Opus chỉ dùng khi chỉ định. Worker không được dùng subagent. Mỗi hồ sơ agy chạy tối đa 2 agent đồng thời.
   - **Mục 3.7:** thêm `GET/PUT /api/config`, dùng schema phẳng `{modelChainHard, modelChainEasy, defaultTimeout}` (đơn vị giây). Đọc `src/services/index.ts` để lấy schema chính xác.
   - **Mục 3.7:** thêm ghi chú *"định dạng sự kiện SSE: xem web/CONTRACT.md 4.2"*.
   - **Mục 2:** thêm bài học thực tế "Lỗi do crash máy": file bị ghi rỗng, object git rỗng. Cách kiểm tra: `git fsck` và `find -size 0`.
2. `README.md`: giới thiệu ngắn; cài đặt (`npm ci`, `npm --prefix web ci`, `npm run build`, `npm run build:web`); các lệnh `agenthub daemon|open|doctor|install-service|mcp-install|link`; liên kết sang USAGE.
3. `docs/USAGE.md`, hướng dẫn **cho người dùng** (tiếng Việt, dễ hiểu):
   - thêm tài khoản Gemini (trên dashboard, hoặc bằng `agenthub profile login`), mẹo "Sử dụng tài khoản khác";
   - đọc dashboard: ý nghĩa từng trạng thái và màu;
   - quy trình cùng Claude Code: Claude tạo task qua MCP → worker chạy → Claude review → duyệt hoặc yêu cầu sửa;
   - xử lý sự cố thường gặp: hết quota, lỗi 503, trùng tài khoản, dashboard trắng trang thì build lại web.

## Nghiệm thu
Markdown sạch, không có liên kết hỏng tới file không tồn tại. Liệt kê các mục đã sửa trong file DONE.
