# Task: t-sse-format – Thống nhất định dạng sự kiện SSE (task nhỏ, khoảng 25 phút)

Nhánh: `t-sse-format`. **Phạm vi file: `src/api/sse.ts`, `web/src/api/sse.ts`, và test của hai file này.**
Không sửa `web/src/pages/`, `web/src/components/`, `src/services/`, `src/api/server.ts`, `src/cli.ts`.
Commit nhỏ. Lệnh có thể chạy lâu phải bọc `timeout`. Khi xong tạo `docs/tasks/t-sse-format.DONE`.

## Vấn đề
Theo `web/CONTRACT.md` mục 4.2: sự kiện bus có dạng `{type, taskId, payload, ts}`, còn `run.output` lại có dạng `{runId, taskId, data}`. Hai định dạng không thống nhất.

## Yêu cầu
1. Mọi sự kiện SSE dùng **chung một envelope**: `{type, ts, taskId?, payload}`. Riêng `run.output` có `payload = {runId, chunk}`.
2. Dùng `event:` của SSE bằng đúng `type`, và thêm `id:` tăng dần. Hỗ trợ header `Last-Event-ID`: khi client kết nối lại, gửi bù các sự kiện bus bị lỡ, lấy từ bảng `events`, tối đa 200 sự kiện. Không gửi bù `run.output`.
3. Web client: parse theo envelope mới. Hàm xử lý `run.output` nối `chunk` vào log của đúng run. `EventSource` tự kết nối lại, có backoff.
4. Ghi định dạng chính thức này vào `web/CONTRACT.md`, mục 4.2 (sửa đoạn đề xuất cũ thành "đã áp dụng").

## Nghiệm thu
- `npm run lint && npm run typecheck && npm test -- --run && npm run test:web -- --run` đều đạt.
- Có test cho envelope, test cho `Last-Event-ID` gửi bù, và test parse phía web.
