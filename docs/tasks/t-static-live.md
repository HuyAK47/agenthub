# Task: t-static-live – Phục vụ bản build web mới mà không phải restart daemon (task nhỏ, khoảng 20 phút)

Nhánh: `t-static-live`. **Phạm vi file: chỉ phần phục vụ file tĩnh trong `src/api/server.ts`, và `test/api.test.ts`.**
Không sửa `web/`, `src/services/`, `src/api/sse.ts`, `src/cli.ts`.
Commit nhỏ. Lệnh có thể chạy lâu phải bọc `timeout`. Test chạy bằng `npm test -- --run`. Khi xong tạo `docs/tasks/t-static-live.DONE`.

## Lỗi 1
- `@fastify/static` đang được đăng ký với `wildcard: false`, nên danh sách file chỉ được quét **một lần khi khởi động**.
- Sau khi chạy `npm run build:web`, file JS mới (tên có hash, ví dụ `assets/index-XXXX.js`) bị trả **404**. Kết quả là dashboard trắng trang cho đến khi restart daemon. Lỗi này đã xảy ra thật.
- **Yêu cầu:** phục vụ file tĩnh động.
  - Dùng `wildcard: true`, đồng thời vẫn giữ quy tắc: không phục vụ bất kỳ thứ gì dưới `/api`, và chỉ fallback về SPA cho `GET` có `Accept: text/html`.
  - Nếu lúc khởi động chưa có `index.html` thì vẫn đăng ký phục vụ file tĩnh, và kiểm tra lại sự tồn tại của file ở mỗi request.
  - Ngăn path traversal.
- **Test:** khởi động server với một thư mục web tạm; sau khi server đã chạy, ghi thêm file `assets/new-123.js`; `GET` file đó phải trả 200.

## Lỗi 2: test phụ thuộc môi trường
`test/api.test.ts > GET / returns HTML placeholder when web is not built` bị fail khi repo đã có `dist/web` (nhận được `Built Web from Dist`).
**Yêu cầu:** mọi test liên quan tới thư mục web phải truyền thư mục tạm qua `AGENTHUB_WEB_DIR` hoặc tham số, không phụ thuộc vào việc `dist/web` có tồn tại hay không.
Kiểm tra bằng cách chạy test **cả khi có và khi không có** `dist/web`, cả hai lần đều phải pass.

## Nghiệm thu
`npm run lint && npm run typecheck && npm test -- --run && npm run build` đều đạt.
