# Task: t-fix-daemon – Sửa lỗi phía server (khoảng 30 phút)

Nhánh: `t-fix-daemon`. **Phạm vi file: `src/` và `test/`. KHÔNG sửa `web/`** (task `t-fix-web` đang làm song song ở đó, theo hợp đồng ở mục "Hợp đồng" bên dưới).
Một task khác (`t-status-enrich`) đang sửa hàm `getStatus` trong `src/services/index.ts`. **Đừng đụng vào `getStatus`.**
Mỗi lỗi một commit. Lệnh có thể chạy lâu phải bọc `timeout`. Test chạy bằng `npm test -- --run`. **Không chạy agy thật trong test.** Khi xong tạo `docs/tasks/t-fix-daemon.DONE`.

## Hợp đồng với web (làm đúng y như sau)
- `POST /api/profiles/:name/check`
  - Trả **ngay lập tức** `202 {"started":true}`. Nếu hồ sơ đó đang có một lượt check chạy dở thì trả `409`.
  - Khi chạy xong, phát sự kiện SSE `profile.check` với payload `{name, ok, message, email?, durationMs}`.
- `GET /api/version` trả `{version, webBuildId}`.
  - `webBuildId` = mtime (epoch ms) của `index.html` trong thư mục web đang được phục vụ (theo `AGENTHUB_WEB_DIR`), hoặc `null` nếu không có file.
  - Endpoint này cần token như mọi route `/api` khác.

## 1. [CAO] `POST /api/profiles/:name/check` bị treo quá 120 giây
Claude đo được: daemon không trả lời trong 120 giây. Trong khi đó prompt thật mất 28 giây và `agy -p "/usage"` chỉ mất 5,6 giây.
- Check chuyển sang dùng `agy -p "/usage"` qua `QuotaUsageService` (đã có ở `src/quota/usage.ts`), chạy trong môi trường của hồ sơ. Chạy nền, timeout 60 giây.
- **Kết quả OK** khi parse được ít nhất một dòng usage. Đồng thời lưu usage luôn, tức check cũng là refresh hạn mức.
- **Kết quả lỗi** khi output chứa "not logged in" hoặc "authentication", hoặc khi timeout. Ghi rõ lý do vào `message`.
- Riêng hồ sơ codex: check bằng `codex --version` hoặc `codex login status` nếu có. Timeout 20 giây.
- Tìm và sửa luôn nguyên nhân gây treo. Ghi nguyên nhân vào file DONE.

## 2. [CAO] Test ghi đè `dist/web/index.html` thật
- `test/web.test.ts`, test *"serves index.html when cwd is changed…"*, ghi `Built Web from Dist` vào `dist/web/index.html` **thật**. Khi file đó đã tồn tại từ trước thì test **không khôi phục** lại bản gốc. Hậu quả: dashboard đang chạy bị trắng trang, đã xảy ra 2 lần.
- **Yêu cầu sửa:** test này phải dùng thư mục tạm. Truyền `webDir` qua `AGENTHUB_WEB_DIR` hoặc tham số của `createServer`. Để kiểm thử hành vi "tìm thư mục web theo vị trí module", tách logic tìm thư mục ra thành hàm thuần `resolveWebDir(moduleUrl, env)` và test hàm đó; tuyệt đối không ghi file thật.
- Mở rộng lưới an toàn trong `test/safety-check.ts`: lưu checksum của `dist/web/index.html` trước khi chạy test; nếu checksum thay đổi sau khi chạy thì cho test fail.

## 3. [TRUNG BÌNH] Daemon chỉ chạy 1 agent mỗi hồ sơ
- `isProfileBusy` trong scheduler đang coi hồ sơ là bận ngay khi có **1** run trong map. Trong khi đó `ProfileLockService` cho phép 2 slot với agy.
- **Yêu cầu sửa:** dùng số slot thật. Hồ sơ còn slot trống (tính cả khóa do `agy-run` bên ngoài đang giữ) thì scheduler được chạy thêm agent trên hồ sơ đó.
- Thêm cấu hình `slotsPerAgyProfile` trong `config.json` (mặc định 2) và cho phép sửa qua `PUT /api/config`.
- **Test:** 1 hồ sơ, 3 task, `maxParallel` của project là 3 → chạy đồng thời đúng 2 task.

## 4. [THẤP] Hồ sơ codex bị hiển thị "chưa đăng nhập"
- Codex không có email, nên `GET /api/profiles` trả `email: null`, và web hiểu đó là chưa đăng nhập.
- **Yêu cầu sửa:** thêm trường `loggedIn: boolean` cho mọi hồ sơ.
  - agy isolated: có file token hay không.
  - agy keyring: luôn `true`.
  - codex: `~/.codex/auth.json` có tồn tại hay không. Chỉ kiểm tra file có tồn tại, **không đọc nội dung**.

## Nghiệm thu
- `npm run lint && npm run typecheck && npm test -- --run && npm run build` đều đạt.
- Chạy thêm `npm run build:web` rồi `npm test -- --run` một lần nữa: checksum của `dist/web/index.html` phải giữ nguyên.
- Trong file DONE: ghi nguyên nhân gây treo, số test trước và sau khi sửa, và mỗi lỗi kèm hash commit.
