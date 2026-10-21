# Task: a3a-web-contract – Khớp web client với API thật (task nhỏ)

Nhánh: `a3a-web-contract`, đang checkout trong worktree này. **Chỉ sửa trong `web/`.**
Thời lượng dự kiến khoảng 30 phút. Commit nhỏ. Lệnh có thể chạy lâu phải bọc `timeout`; test chạy bằng `--run`.
Khi xong tạo `docs/tasks/a3a-web-contract.DONE`. Nếu bị chặn thì tạo `.BLOCKED`.

## Bối cảnh
Web (`web/`) được viết dựa trên **mock**. API thật đã được viết ở một nhánh khác, nằm trong thư mục **`/home/user/Desktop/AgentHub-wt/a1-api-mcp/`**. Ở thư mục đó chỉ **ĐỌC**, tuyệt đối không sửa và không chạy git:
- `src/api/server.ts`: các route;
- `src/services/index.ts`: dữ liệu trả về và schema zod của input;
- `src/api/sse.ts`: tên sự kiện SSE và payload;
- `src/api/pty.ts`: giao thức WebSocket.

## Việc cần làm
1. So từng endpoint mà web gọi (`web/src/api/`, `web/src/types/api.ts`) với API thật: method, path, body, **hình dạng JSON trả về** (tên trường, chỗ nào bọc trong `{data}`, chỗ nào không), và mã lỗi.
   Ghi bảng đối chiếu vào `web/CONTRACT.md` với các cột: endpoint, web đang gửi/nhận, API thật, đã sửa gì.
2. Sửa **web** cho khớp với API thật: type, client, các trang và **cả fixture mock**. Mock phải trả đúng hình dạng của API thật, để chế độ mock không che giấu chỗ lệch.
3. Đối chiếu tên sự kiện SSE và payload (bao gồm `run.output`), và giao thức WebSocket PTY.
4. Chế độ mock chỉ được bật khi `import.meta.env.DEV` hoặc khi build với `VITE_MOCK=1`. **Không** cho bật bằng `?mock=1` trên bản build chính thức.
5. Nếu thấy **API thật** sai so với `docs/PLAN.md` mục 3.7 thì **không sửa API**. Ghi vào cuối `web/CONTRACT.md`, mục "Đề xuất sửa API".

## Nghiệm thu
- `npm run lint && npm run typecheck && npm run build:web && npm run test:web -- --run` đều đạt.
- Thêm ít nhất 3 test cho phần client đã sửa.
