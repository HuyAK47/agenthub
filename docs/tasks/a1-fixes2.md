# Task: a1-fixes2 – Cô lập test khỏi dữ liệu thật (task nhỏ)

Nhánh: `a1-api-mcp`. Thời lượng dự kiến 15–30 phút. Commit nhỏ. Lệnh có thể chạy lâu phải bọc `timeout`; test chạy bằng `--run`.
Khi xong tạo `docs/tasks/a1-fixes2.DONE`. Nếu bị chặn thì tạo `.BLOCKED`.

## Lỗi
Lúc 13:36, khi chạy `npm test`, các test `test/api.test.ts` và `test/pty.test.ts` đã tạo hồ sơ **thật** `testuser` và `worker1` trong `~/.agy-homes/` của người dùng. Hồ sơ `testuser` còn có `.gemini/antigravity-cli/log/agy.log`, tức là **agy thật đã được chạy** trong lúc test. Điều này vi phạm AGENTS.md, và có nguy cơ làm hỏng tài khoản thật. Claude đã xóa hai thư mục đó.

## Yêu cầu
1. Mọi test phải dùng thư mục tạm cho **cả** `AGENTHUB_HOME` **và** thư mục hồ sơ agy (`agyHomesDir` trong config, hoặc env tương ứng). Ngoài ra không được đọc `~/.gemini`: email của hồ sơ mặc định phải lấy từ thư mục log giả.
2. Test PTY **không được chạy agy thật**. Cho phép cấu hình lệnh đăng nhập (ví dụ env `AGENTHUB_AGY_BIN`), và trong test trỏ nó tới một script giả `test/fixtures/fake-agy-login.mjs`. Script này in vài dòng, ghi một dòng `authenticated successfully as test@example.com` vào log, rồi thoát.
3. Thêm một "lưới an toàn" chạy cho toàn bộ test suite (`globalSetup` hoặc `setupFiles` của Vitest):
   - trước khi chạy: lưu danh sách thư mục con của `~/.agy-homes` và thời điểm sửa đổi (mtime) của `~/.agenthub`;
   - sau khi chạy: nếu danh sách thay đổi, hoặc `~/.agenthub` bị sửa, thì **làm test fail**.
4. Code chạy thật (không phải test) **không được tự tạo hồ sơ khi chỉ đọc danh sách**: `GET /api/profiles` tuyệt đối không tạo thư mục.

## Nghiệm thu
- `npm run lint && npm run typecheck && npm test -- --run && npm run build` đều đạt.
- Ghi vào file DONE kết quả `ls ~/.agy-homes` **trước và sau** khi chạy `npm test -- --run`: hai danh sách phải giống nhau, gồm `g1 g2 g3` và thư mục `.state` bị ẩn.
