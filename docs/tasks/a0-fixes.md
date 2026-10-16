# Task: a0-fixes – Sửa lỗi scheduler sau review a0-core

Đọc trước: `AGENTS.md`, `docs/PLAN.md` mục 3.5, `src/scheduler/index.ts`.
Nhánh: `a0-core` (đã có). **Mỗi lỗi một commit riêng** (`fix(scheduler): …`). Lần trước toàn bộ a0 nằm trong một commit, lần này không làm như vậy.
Mỗi lỗi phải có test tái hiện: test **fail trước khi sửa và pass sau khi sửa**, dùng fake engine.
Khi xong tạo `docs/tasks/a0-fixes.DONE`. Nếu bị chặn thì tạo `.BLOCKED`.

## 1. [Cao] Task kẹt ở `waiting_quota` vĩnh viễn khi hồ sơ chỉ đang **bận**, không phải hết quota
- **Vị trí:** `scheduleNewTasks()`.
- **Tình huống lỗi:** mỗi họ model có 1 hồ sơ, đang bận chạy task A. Task B ở `queued` không tìm được cặp (model, hồ sơ) nên bị chuyển sang `waiting_quota`. Task B chỉ quay lại `queued` khi có quota mark hết hạn. Nếu không có mark nào thì B **kẹt mãi**, dù A đã chạy xong.
- **Yêu cầu sửa:**
  - Chỉ chuyển sang `waiting_quota` khi **mọi** hồ sơ phù hợp trong cả chuỗi model đều đang có quota mark còn hiệu lực, hoặc khi không tồn tại hồ sơ nào cho engine đó.
  - Nếu chỉ vì hồ sơ bận thì giữ `queued`.
  - Khi một run kết thúc, gọi lại scheduler ngay.

## 2. [Cao] Dừng daemon (restart/upgrade) giết hết worker đang chạy
- **Vị trí:** `stop()` gọi `killTask(…, 'cancelled')` cho mọi task đang chạy, khiến chúng bị **cancelled**.
- **Yêu cầu sửa:**
  - `stop()` chỉ dừng timer và đặt cờ `stopped`. Callback `exit` của child kiểm tra cờ này để không ghi vào DB đã đóng.
  - Worker là process detached nên vẫn chạy tiếp sau khi daemon dừng.
  - Thêm `cancelAll()` riêng cho trường hợp thật sự muốn hủy toàn bộ.

## 3. [Cao] Restart daemon khi worker còn sống làm task bị bỏ rơi
- **Vị trí:** `recoverOnStartup()`. Run có pid **còn sống** được giữ ở trạng thái `running` nhưng không được thêm vào map `running`, nên không ai theo dõi nữa. Task kẹt ở `running` mãi mãi, timeout và hủy đều không có tác dụng.
- **Yêu cầu sửa:**
  - Gắn lại run đó vào map `running`, lấy engine từ `run.engine` và `startTime` từ `run.startedAt`. Từ đó theo dõi bằng cách kiểm tra pid định kỳ.
  - Chống trường hợp pid bị tái sử dụng: lưu `startTime` của process (đọc trường thứ 22 của `/proc/<pid>/stat`) vào cột mới `runs.pidStart`. Nếu giá trị không khớp thì coi là process đã chết.

## 4. [Cao] Thử lại khi gặp lỗi tạm thời bằng `setTimeout` gây kẹt task và tranh hồ sơ
- **Vị trí:** nhánh transient trong `handleRunCompletion()`. Trong thời gian chờ (60–180 giây):
  - task vẫn ở `running` nhưng không có trong map, nên hồ sơ bị coi là rảnh. Task khác có thể chiếm hồ sơ đó, rồi `setTimeout` lại khởi chạy thêm một worker trên cùng hồ sơ;
  - nếu daemon restart trong lúc chờ, task kẹt ở `running` vĩnh viễn vì run đã được đánh dấu `crashed`;
  - `startTask` dùng object `task` cũ, có thể đã bị hủy trong thời gian chờ.
- **Yêu cầu sửa:**
  - Bỏ `setTimeout`. Thêm cột `tasks.notBefore` (epoch) và `tasks.transientRetries`.
  - Khi gặp lỗi tạm thời: chuyển task về `queued`, đặt `notBefore = now + delay` và tăng `transientRetries`. Scheduler bỏ qua task cho đến khi đến `notBefore`.
  - Hết 3 lần thì chuyển `failed`.
  - Reset `transientRetries` về 0 khi một run kết thúc bằng DONE, BLOCKED hoặc quota.

## 5. [Trung bình] Cấp slot sai làm hai task dùng chung port và DB
- **Vị trí:** `startTask`. `usedSlots` được tính bằng `.map((_, i) => i + 1)`, tức là chỉ số mảng chứ không phải slot thật.
- **Tình huống lỗi:** A giữ slot 1, B giữ slot 2. A kết thúc. C bắt đầu, `usedSlots = [1]`, nên C nhận slot 2 và **trùng với B**.
- **Yêu cầu sửa:**
  - Lưu `tasks.slot`. Slot được giữ trong suốt thời gian task còn worktree và chưa `done` hoặc `cancelled`, vì file env trong worktree vẫn dùng slot đó.
  - `usedSlots` lấy từ DB theo điều kiện trên.
  - Nếu hết slot (đã dùng cả 9) thì task chờ ở `queued`, **không** báo `failed`.
- Không được nuốt lỗi khi sinh file env (`catch {}`). Lỗi phải làm task chuyển sang `failed`, kèm sự kiện có nội dung lỗi.

## 6. [Thấp] Các điểm nhỏ
- `handleRunCompletion` đang đọc **toàn bộ** log vào bộ nhớ. Chỉ đọc khoảng 16KB cuối file.
- `scheduleNewTasks` gọi `taskRepo.get` trong vòng lặp lồng nhau. Hãy lưu `projectId` ngay trong `RunningTask`.
- `reviewTask(changes_requested)` khi `feedback` rỗng phải báo lỗi, vì gửi lại cho worker mà không có feedback thì vô nghĩa.

## Nghiệm thu
- `npm run lint && npm run typecheck && npm test -- --run && npm run build` đều đạt.
- Trong file DONE: số test trước và sau khi sửa, và mỗi lỗi kèm hash commit cùng tên test tái hiện.
