# Task: t-quota-usage – Hạn mức thật của từng tài khoản + trạng thái bận chính xác (khoảng 40 phút)

Nhánh: `t-quota-usage`. Các task khác đang sửa `src/services/index.ts`, `src/api/server.ts` và `web/src/pages/`. Để giảm xung đột:
- **đặt logic trong file mới**: `src/quota/usage.ts`, `src/profiles/locks.ts`, `web/src/components/QuotaUsage.tsx`;
- ở các file dùng chung chỉ thêm vài dòng nối vào (import, route, render component).

Commit nhỏ. Lệnh có thể chạy lâu phải bọc `timeout`. **Không gọi agy thật trong test**: dùng script giả in đúng định dạng bên dưới. Khi xong tạo `docs/tasks/t-quota-usage.DONE`.

## Phát hiện (Claude đã kiểm chứng trên máy)
Lệnh `agy -p "/usage"`, chạy trong môi trường của hồ sơ (cùng hàm env như engine dùng; với hồ sơ isolated thì đặt HOME và DBUS như PLAN 2.1), **không tốn quota**. Lệnh in ra stdout các dòng phân tách bằng TAB:
```
Gemini Models	Weekly Limit Remaining	85%	2026-10-22T03:47:49Z
Gemini Models	Five Hour Limit Remaining	45%	2026-10-15T08:47:49Z
Claude and GPT models	Weekly Limit Remaining	49%	2026-10-22T03:53:50Z
Claude and GPT models	Five Hour Limit Remaining	0%	2026-10-15T08:53:50Z
```
- "Claude and GPT models" là một nhóm dùng chung quota, ứng với họ `claude` và `gpt` (tức `gpt-oss`). "Gemini Models" ứng với họ `gemini`.
- Lệnh chạy mất khoảng 5–20 giây. Đặt timeout 60 giây.

## Yêu cầu
1. **`src/quota/usage.ts`**
   - `parseUsage(text)` trả về `[{group, families[], window: '5h'|'week', remainingPct, resetAt}]`. Bỏ qua các dòng lạ; hàm phải chịu được dòng thiếu cột.
   - `fetchUsage(profile)` chạy lệnh trên. Không chạy song song quá 2 lần.
   - **Bộ thu thập**:
     - cứ 5 phút thu một lần cho mọi hồ sơ agy đã đăng nhập;
     - thu thêm ngay sau khi một run kết thúc;
     - thu khi có yêu cầu qua `POST /api/profiles/:name/usage/refresh`.

     Lưu vào bảng mới `quota_usage(profileName, grp, window, remainingPct, resetAt, fetchedAt)` (viết migration mới).
   - **Tích hợp vào scheduler**:
     - khi `remainingPct` của cửa sổ 5h hoặc tuần **bằng 0**, tạo quota mark cho các họ tương ứng, hạn đến `resetAt`. Sự kiện `quota.exhausted` đi kèm lý do "usage".
     - khi chọn hồ sơ, **ưu tiên hồ sơ có `remainingPct` của cửa sổ 5h cao nhất** cho họ model cần dùng. Gặp các hồ sơ cùng email thì dùng chung một số liệu.
2. **`src/profiles/locks.ts`** – trạng thái bận chính xác:
   - Ngoài daemon, các script ngoài (`agy-run` / `agy-account`) cũng chạy agent và giữ khóa `flock` trên các file `~/.agy-homes/.state/<tên>.lock` (slot 1) và `<tên>.lock2` (slot 2). Daemon phải coi những slot này là đang bận.
   - Kiểm tra bằng cách chạy `flock -n <file> true` qua `execFile` (exit khác 0 nghĩa là đang bị khóa), có cache 3 giây. Hồ sơ `codex` dùng file `codex.lock`.
   - `GET /api/profiles` trả thêm `slotsUsed` và `slotsTotal` (mặc định 2 với agy, 1 với codex). `busy` là true khi `slotsUsed >= slotsTotal`.
   - Scheduler chỉ khởi chạy trên hồ sơ còn slot trống. Khi daemon tự chạy một agent, nó cũng phải **giữ đúng khóa đó**: bọc lệnh bằng `flock -n <file>`, để `agy-run` thấy được và không chồng lên.
3. **API**: `GET /api/profiles` trả thêm `usage: [{group, window, remainingPct, resetAt, fetchedAt}]`. Thêm route refresh như ở mục 1.
4. **Web**: component `QuotaUsage`, render trong bảng Tài khoản thay cho cột hạn mức cũ:
   - với mỗi nhóm (Gemini, Claude+GPT), vẽ 2 thanh tiến độ 5h và Tuần, màu xanh > 50%, vàng 20–50%, đỏ < 20%;
   - hiển thị "còn X% · reset sau 1h12m";
   - nút làm mới;
   - cột Trạng thái hiện "Đang chạy 2/2", "1/2" hoặc "Rảnh".

   Dùng biến CSS theme nếu đã có, không hardcode màu nền.
5. **MCP `hub_profiles`**: thêm một dòng mỗi hồ sơ, ví dụ `g2: gemini 5h 91% (reset 16:24) · tuần 97% | claude 5h 0% (reset 16:34) | slots 1/2`.

## Test
- `parseUsage` chạy với đúng mẫu ở trên và với input lỗi.
- Usage 0% tạo ra quota mark có hạn đúng bằng `resetAt`.
- Scheduler chọn hồ sơ có `remainingPct` cao hơn.
- Khóa: test khóa một file bằng `flock` thật trong thư mục tạm (spawn `flock <file> sleep 5`), rồi kiểm tra `slotsUsed` bằng 1.

## Nghiệm thu
- `npm run lint && npm run typecheck && npm test -- --run && npm run build && npm run build:web && npm run test:web -- --run` đều đạt.
- Chạy thật **chỉ đọc**: `node dist/cli.js` với một lệnh mới `agenthub usage` in bảng usage của mọi hồ sơ. Dán kết quả vào file DONE.
