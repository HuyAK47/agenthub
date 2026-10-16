# Task: a2-web – Web dashboard AgentHub

Đọc trước: `AGENTS.md`, `docs/PLAN.md`, đặc biệt mục **3.1** (bảo mật), **3.7** (hợp đồng API) và **3.9** (dashboard).
Nhánh: `a2-web`, đang checkout sẵn trong worktree này. Commit nhỏ, theo Conventional Commits.

Một agent khác đang làm song song task `a1-api-mcp` (HTTP API thật).
**Không sửa gì trong `src/`** (backend). Chỉ làm trong `web/`, và nếu cần thì thêm script vào `package.json` gốc.
Khi xong tạo `docs/tasks/a2-web.DONE`. Nếu bị chặn thì tạo `.BLOCKED`.

## Phạm vi
1. **Cấu trúc:**
   - Thư mục `web/` là app Vite + React 18 + TypeScript strict + Tailwind 4 + TanStack Query + React Router + xterm.js.
   - Có `package.json` riêng trong `web/`, dùng npm.
   - Build ra `../dist/web`, để daemon phục vụ dạng file tĩnh (phần phục vụ do a1 làm).
   - Thêm vào package gốc các script `build:web`, `dev:web`, `test:web`.
2. **API client** (`web/src/api/`):
   - Định nghĩa type cho mọi endpoint trong PLAN 3.7.
   - `fetch` gắn header `Authorization: Bearer <token>`.
   - Token đọc từ `location.hash` (`#token=…`) khi mở trang, lưu vào `sessionStorage`, rồi xóa hash bằng `history.replaceState`.
   - Thiếu token hoặc API trả 401 thì hiển thị màn hình hướng dẫn: "Chạy `agenthub open` để mở dashboard".
   - SSE `/api/events?token=…`: dùng `EventSource`, tự kết nối lại. Mỗi sự kiện làm mới (invalidate) đúng các query liên quan.
3. **Mock** để chạy khi chưa có backend:
   - Dùng MSW, bật khi `VITE_MOCK=1` (`npm run dev:web -- --mode mock` hoặc biến env).
   - Fixture giống thật:
     - các hồ sơ `chinh`, `g1` (trùng email với chinh), `g2`, `g3` (chưa đăng nhập), `codex`, kèm quota mark;
     - 2 project (XFarm, AgentHub);
     - khoảng 8 task phủ mọi trạng thái, có runs và log;
     - SSE giả phát sự kiện định kỳ.
4. **Các trang** (tiếng Việt, đúng PLAN 3.9):
   - **Tổng quan**
     - Ô số liệu: đang chạy, chờ review, chờ quota, lỗi.
     - Bảng worker đang chạy: task, project, model, hồ sơ, thời gian đã chạy (tự cập nhật).
     - Dòng sự kiện.
   - **Task**
     - Kanban theo trạng thái, lọc theo project.
     - Trang chi tiết:
       - đề bài render markdown (`react-markdown`, **không** dùng `dangerouslySetInnerHTML`);
       - danh sách runs (model, hồ sơ, kết quả, thời lượng);
       - **log trực tiếp**: tail qua `/log?tail=`, cập nhật theo SSE `run.output`, tự cuộn xuống cuối nhưng dừng tự cuộn khi người dùng cuộn lên;
       - báo cáo DONE và danh sách commit.
     - Các nút: Start, Hủy (hỏi xác nhận), Thử lại (kèm ghi chú), Duyệt, Yêu cầu sửa (bắt buộc nhập feedback).
     - Form tạo task: project, slug, tiêu đề, level, phụ thuộc (chọn nhiều), đề bài dạng textarea markdown có xem trước.
   - **Tài khoản**
     - Bảng gồm: tên, engine, email, các quota mark kèm **đồng hồ đếm ngược**, trạng thái bận, cảnh báo trùng email (chữ đỏ, kèm gợi ý relogin), công tắc bật/tắt.
     - Nút **Check** gọi `/check` rồi hiển thị kết quả, nút **Xóa quota mark**.
     - **Thêm tài khoản**:
       - Dialog nhập tên, gọi `POST /api/profiles`, rồi `POST /api/profiles/:name/login` để nhận `sessionId`.
       - Mở terminal **xterm.js** nối với WebSocket `/api/pty/:sessionId?token=…`. Gửi phím gõ lên server, nhận output về; xử lý resize bằng message JSON `{type:"resize",cols,rows}`. Phím gõ gửi dạng `{type:"input",data}`, output nhận về là text thô.
       - Hiển thị hướng dẫn nổi bật: "Trên trang Google, bấm **Sử dụng tài khoản khác** để không bị trùng tài khoản đang đăng nhập sẵn".
       - Khi WS đóng, tự gọi lại `/api/profiles` để hiện email mới.
       - Trong chế độ mock, giả lập WS bằng output mẫu.
   - **Project**: danh sách và form đăng ký (name, path, defaultBranch, maxParallel, envTemplate dạng JSON có validate).
   - **Cài đặt**: xem và sửa chuỗi model mặc định. Endpoint là `GET/PUT /api/config`, **mục này bổ sung vào hợp đồng API**; ghi chú lại trong `docs/DECISIONS.md` để a1 làm theo.
5. **Giao diện:**
   - Sạch, gọn, có dark mode theo hệ thống và công tắc chuyển đổi.
   - Màu trạng thái thống nhất trên mọi trang: queued xám, running xanh dương, review tím, done xanh lá, blocked cam, failed đỏ, waiting_quota vàng.
   - Dùng được trên màn hình rộng 1280px trở lên, và không vỡ layout ở 768px.

## Test
- Vitest + Testing Library:
  - xử lý token (đọc hash, lưu, xóa hash);
  - API client gắn header đúng, xử lý 401;
  - đồng hồ đếm ngược quota;
  - form "Yêu cầu sửa" chặn khi feedback rỗng;
  - Kanban nhóm đúng theo trạng thái.
- Ít nhất 10 test.

## Nghiệm thu
- Ở thư mục gốc chạy được `npm run lint && npm run typecheck && npm test -- --run && npm run build && npm run build:web && npm run test:web`.
- Chạy chế độ mock, kiểm tra bằng curl rằng trang trả về 200. Mô tả trong file DONE những gì đã kiểm tra thủ công trên các trang.
