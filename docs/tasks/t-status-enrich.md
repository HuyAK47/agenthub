# Task: t-status-enrich – Bổ sung thông tin cho `/api/status` (task nhỏ, khoảng 20 phút)

Nhánh: `t-status-enrich`. **Phạm vi file: `src/services/index.ts` (hàm `getStatus` và lân cận), `web/src/types/api.ts` (chỉ type), các test liên quan.**
Không sửa `web/src/pages/` và `web/src/components/` (một task khác đang đổi giao diện), cũng không sửa `src/api/server.ts`, `src/api/sse.ts`, `src/cli.ts`.
Commit nhỏ. Lệnh có thể chạy lâu phải bọc `timeout`. Khi xong tạo `docs/tasks/t-status-enrich.DONE`.

## Yêu cầu
1. Mỗi phần tử trong mảng `running` của `GET /api/status` có thêm `title`, `projectId`, `slug` và `worktreePath`.
2. Thêm `recentEvents`: 30 sự kiện mới nhất, lấy từ bảng `events`, mỗi phần tử gồm `{id, ts, type, taskId, summary}`. `summary` là một câu tiếng Việt ngắn, sinh từ `type` và `payload`, ví dụ: "a1 chuyển sang chờ review", "g2 hết quota claude tới 16:35".
3. Thêm `tasksByProject`: số task theo từng trạng thái, tách theo từng project.
4. Cập nhật `web/src/types/api.ts` cho khớp. Mọi trường mới đều là optional để không làm hỏng giao diện hiện tại.
5. MCP `hub_status` hiển thị thêm tiêu đề task ở dòng của worker đang chạy.

## Nghiệm thu
- `npm run lint && npm run typecheck && npm test -- --run && npm run build && npm run test:web -- --run` đều đạt.
- Viết test cho từng trường mới.
