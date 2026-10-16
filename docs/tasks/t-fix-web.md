# Task: t-fix-web – Sửa lỗi phía web (khoảng 30 phút)

Nhánh: `t-fix-web`. **Phạm vi file: CHỈ `web/`.** Không sửa `src/`, vì task `t-fix-daemon` đang làm phía server song song.
Commit nhỏ. Lệnh có thể chạy lâu phải bọc `timeout`. Khi xong tạo `docs/tasks/t-fix-web.DONE`.

## Hợp đồng với server (server đang được viết theo đúng hợp đồng này; ở web hãy làm sẵn và mock theo nó)
- `POST /api/profiles/:name/check`: trả ngay `202 {"started":true}`. Trả `409` nếu đang có một lượt check chạy dở. Khi check xong, server phát sự kiện SSE `profile.check` với payload `{name, ok, message, email?, durationMs}`.
- `GET /api/version`: trả `{version, webBuildId}`. Cần token.
- Mỗi phần tử của `GET /api/profiles` có thêm trường `loggedIn: boolean`.

## Việc cần làm
1. **Nút Check:**
   - Bấm xong thì nút chuyển sang trạng thái "Đang kiểm tra…" kèm spinner và bị vô hiệu hóa.
   - Khi nhận sự kiện SSE `profile.check` có `name` khớp: hiển thị toast ✓ hoặc ✗ kèm `message` và thời gian chạy, rồi tải lại danh sách hồ sơ và usage.
   - Nếu sau 75 giây vẫn chưa có kết quả thì báo "quá thời gian".
   - Gặp `409` thì báo "đang kiểm tra".
2. **Trạng thái đăng nhập:** dùng `loggedIn` để quyết định có hiện "Chưa đăng nhập / Đăng nhập ngay" hay không, **không** dựa vào `email`.
   - Hồ sơ codex đã đăng nhập: hiển thị "Codex (ChatGPT)" ở chỗ email.
   - Nút "Đăng nhập" chỉ hiện với hồ sơ agy isolated.
   - Nếu `loggedIn` không có trong response (server cũ), giữ hành vi cũ.
3. **Báo có bản mới:**
   - Cứ 60 giây gọi `GET /api/version` một lần, và gọi thêm khi tab được focus lại.
   - Nếu `webBuildId` khác với giá trị lúc trang vừa tải, hiện thanh thông báo trên đầu trang: "Có phiên bản dashboard mới" kèm nút **Tải lại** (`location.reload()`).
   - Gặp 404 (server cũ) thì bỏ qua, không báo lỗi.
4. **Loại MSW khỏi bản build chính thức:**
   - Chỉ `import()` động `./mocks/browser` khi `import.meta.env.DEV || import.meta.env.VITE_MOCK === '1'`, để Vite loại hẳn code mock khỏi bản build chính thức.
   - Bản build chính thức không chứa `mockServiceWorker.js`: chuyển file này sang chỉ phục vụ khi dev, hoặc xóa khỏi `dist` bằng plugin hay cấu hình `publicDir` riêng cho mock.
   - Kiểm tra: sau `npm run build:web`, `grep -r "serviceWorker" ../dist/web` không ra kết quả nào.
5. **Bỏ cảnh báo chunk lớn hơn 500 kB:** tách xterm, react-markdown và các trang thành chunk riêng bằng `React.lazy` cho từng route, cộng thêm `manualChunks` nếu cần.

## Nghiệm thu
- `npm run lint && npm run build:web && npm run test:web -- --run` đều đạt.
- Thêm test cho: nút Check (202, rồi nhận SSE, rồi hiện toast); xử lý 409; banner phiên bản mới; logic `loggedIn`.
- Dán kết quả lệnh `grep` ở mục 4 vào file DONE.
