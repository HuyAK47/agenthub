# Task: a1-fixes – Sửa lỗi bảo mật và triển khai sau review a1

Nhánh: `a1-api-mcp`, đang checkout trong worktree này. **Mỗi lỗi một commit**, ví dụ `fix(auth): …`.
Mỗi lỗi phải có test tái hiện: fail trước khi sửa, pass sau khi sửa.
Các lệnh có thể chạy lâu phải bọc `timeout`. Test chạy bằng `npm test -- --run`.
Khi xong tạo `docs/tasks/a1-fixes.DONE`. Nếu bị chặn thì tạo `.BLOCKED`.

## 1. [NGHIÊM TRỌNG] Gọi được API không cần token bằng đường dẫn mã hóa
Claude đã tái hiện trên daemon thật (fake engine, cổng 7791):
```
curl --path-as-is http://127.0.0.1:7791/%61pi/status
→ 200 {"tasks":{"running":0,...}}        # dữ liệu API thật, KHÔNG có token
```
- **Nguyên nhân:** `registerSecurityHooks` quyết định có cần token hay không bằng `rawUrl.startsWith('/api/')` trên URL **thô**. Router của Fastify lại giải mã `%61` thành `a` rồi mới khớp route `/api/status`.
- Theo cách tương tự, kẻ tấn công có thể dùng `POST /%61pi/projects` rồi `/%61pi/tasks` với `start:true`, tức là **ra lệnh cho agent chạy lệnh tùy ý trên máy**.
- **Yêu cầu sửa: mặc định từ chối (default-deny).**
  - Xác thực trong hook `preHandler`, tức là **sau khi đã khớp route**. Dựa vào `request.routeOptions.url` (mẫu route đã khớp): mọi route có mẫu bắt đầu bằng `/api` đều bắt buộc có token.
  - Chỉ miễn token cho `/health` và các file tĩnh của web (`GET`/`HEAD`).
  - Ngoài ra, ở `onRequest`, trả 400 cho mọi URL mà phần path chứa `%2f`, `%2F`, `%5c`, `%5C`, hoặc segment `.`/`..` (sau khi giải mã).
  - Route WebSocket `/api/pty/:id` và SSE `/api/events` cũng đi qua cùng cơ chế này, token lấy từ query.
- **Test** (đều phải trả 400, 401 hoặc 404, và **tuyệt đối không** được trả dữ liệu API khi không có token):
  `/%61pi/status`, `/%61%70%69/status`, `//api/status`, `/api%2fstatus`, `/./api/status`, `/api/../api/status`, `/API/status`, `/%61pi/events`, `POST /%61pi/projects`.
  Viết thêm một test liệt kê **mọi route** đã đăng ký (dùng `fastify.printRoutes()` hoặc hook `onRoute`) và khẳng định rằng mọi route `/api*` đều trả 401 khi không có token.

## 2. [CAO] Dashboard không hiện khi chạy daemon dưới dạng service
- **Vị trí:** `server.ts`: `path.resolve(process.cwd(), 'dist', 'web')`. Systemd chạy daemon với cwd là `/`, nên lúc nào cũng hiện trang "chưa build web".
- **Yêu cầu sửa:** tìm thư mục web theo vị trí của module, ví dụ `fileURLToPath(new URL('./web', import.meta.url))` khi chạy từ `dist/`. Cho phép ghi đè bằng env `AGENTHUB_WEB_DIR`.
- **Test:** khởi động server với `process.chdir('/')` (hoặc truyền `cwd` khác), `GET /` vẫn trả `index.html` của bản build.

## 3. [TRUNG BÌNH] Route `/api/...` không tồn tại trả về HTML với mã 200
- Hiện tại `setNotFoundHandler` trả trang SPA hoặc trang "chưa build web" với mã 200 cho mọi đường dẫn, kể cả `/api/khong-co`.
- **Yêu cầu sửa:**
  - Đường dẫn bắt đầu bằng `/api` mà không khớp route nào: trả `404 {error:"not_found"}` dạng JSON (sau khi đã kiểm tra token).
  - Fallback SPA chỉ áp dụng cho `GET`, không phải `/api`, và chỉ khi request có `Accept` chứa `text/html`.

## 4. [THẤP]
- `cli.ts`: `exec(\`xdg-open "${url}"\`)` đang ghép chuỗi vào shell. Đổi sang `execFile('xdg-open', [url])`.

## Nghiệm thu
- `npm run lint && npm run typecheck && npm test -- --run && npm run build` đều đạt. Ghi số test trước và sau khi sửa.
- Chạy daemon thật với fake engine, `AGENTHUB_PORT=7792`, `AGENTHUB_HOME` tạm.
  - Chạy lại toàn bộ danh sách curl ở mục 1 với `--path-as-is`, dán kết quả (mã HTTP và 80 ký tự đầu của body) vào file DONE.
  - Kiểm tra `GET /` khi cwd là `/`.
  - Kiểm tra xong thì tắt daemon.
