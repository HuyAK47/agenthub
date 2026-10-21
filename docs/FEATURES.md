# Tính năng của AgentHub

Tài liệu này mô tả chi tiết các tính năng chính của AgentHub dành cho người dùng và người quản trị hệ thống. Mỗi tính năng được trình bày gồm: **Làm gì**, **Dùng thế nào** và **Mẹo hoặc lỗi thường gặp**.

---

## 1. Chat với Claude (Điều phối viên)

### Làm gì
Tính năng Chat cho phép bạn trò chuyện trực tiếp với **Claude Code** ngay trên giao diện Web Dashboard (thông qua bảng điều khiển hoặc biểu tượng Brain). Claude đóng vai trò là "bộ não điều phối" của AgentHub: nắm rõ toàn bộ trạng thái hệ thống qua các công cụ MCP `hub_*` (tạo task, xem log, review, retry, hủy task, xem quota...). Thay vì tự viết code trực tiếp, Claude sẽ phân tích yêu cầu của bạn, chia nhỏ thành các task độc lập và giao việc cho các AI worker (Gemini/Codex) thực thi.

Hệ thống trang bị giao diện lịch sử tin nhắn ảo hóa (virtualized) cuộn tải dần mượt mà, quản lý phiên toàn diện (tìm kiếm, ghim, xuất Markdown), cơ chế phê duyệt quyền công cụ (Tool Permissions), nén ngữ cảnh tự động (`/compact`, `/fork-summary`) và duy trì tiến trình chạy liên tục (persistent stream-json).

### Dùng thế nào
1. Nhấp vào mục **Trò chuyện** (Chat) trên thanh điều hướng hoặc biểu tượng avatar Claude.
2. **Chọn Model**: Bạn có thể chọn model Claude mong muốn cho phiên trò chuyện:
   - Mặc định: Theo cấu hình hệ thống (`chat.model`, thường là `sonnet`).
   - `sonnet`: Cân bằng giữa tốc độ và khả năng suy luận logic sâu.
   - `haiku`: Tốc độ phản hồi cực nhanh, tiết kiệm chi phí token cho các câu hỏi nhanh.
3. **Chế độ hoạt động (Mode)**:
   - **Chế độ An toàn (`safe` - Mặc định)**: Claude chạy với quyền hạn mặc định (`--permission-mode default`), chỉ được phép dùng các công cụ MCP an toàn (`mcp__agenthub`) và các lệnh đọc kiểm tra (như `git status`, `git log`, `npm test`, `npm run lint`, `npm run typecheck`). Tránh các lệnh ghi phá hoại vào repository.
   - **Chế độ Đầy đủ (`full`)**: Claude được cấp quyền thực thi tự do (`--permission-mode bypassPermissions`). Chỉ dùng khi bạn muốn Claude có toàn quyền can thiệp vào máy. Chế độ này yêu cầu được kích hoạt trước trong cấu hình hệ thống (`chat.allowFullMode: true`).
4. **Tiến trình chạy liên tục (Persistent Process)**:
   - Nếu CLI `claude` của bạn hỗ trợ stream-json (`--input-format stream-json`), AgentHub tự động duy trì một tiến trình Claude chạy nền liên tục cho phiên chat.
   - Giao tiếp qua luồng JSON hai chiều giúp phản hồi tức thì mà không cần khởi động lại tiến trình ở từng lượt chat.
   - Tiến trình tự động tắt sau khoảng thời gian nhàn rỗi `idleTimeoutSec` (mặc định 600 giây = 10 phút) để giải phóng tài nguyên RAM.
5. **Giao diện lịch sử & Quản lý phiên (SessionList & MessageList)**:
   - **Cuộn tải dần**: Sử dụng danh sách ảo hóa với tham số phân trang `before=`, giữ nguyên vị trí cuộn khi tải thêm tin nhắn cũ và tự động cuộn xuống cuối khi có tin nhắn mới hoặc streaming.
   - **Thu gọn bước công cụ (Tool Steps)**: Các bước gọi công cụ được tự động gom nhóm, có thể bấm mở rộng để xem chi tiết hoặc thu gọn cho gọn gàng; hiển thị trạng thái đang chạy kèm hiệu ứng quay cho bước hiện tại.
   - **Quản lý phiên**: Tìm kiếm phiên theo tiêu đề hoặc nội dung tin nhắn, ghim phiên quan trọng lên đầu, đổi tên phiên, lưu trữ (archive), xóa phiên an toàn và xuất toàn bộ nội dung ra định dạng Markdown (`.md`).
6. **Hộp thoại duyệt quyền công cụ (Permission Broker)**:
   - Khi Claude cần thực thi lệnh hoặc công cụ ngoài danh mục an toàn, hộp thoại xin quyền sẽ hiển thị với 3 lựa chọn: **Cho phép**, **Luôn cho phép** (ghi nhớ cho lệnh tương tự trong phiên) hoặc **Từ chối**.
   - Watchdog tự động tạm dừng đếm thời gian im lặng khi đang chờ người dùng quyết định và khởi động lại sau khi có quyết định.
   - Cấu hình MCP riêng cho từng phiên chat được lưu tại `~/.agenthub/sessions/<id>/mcp.json` với quyền bảo mật `0600` và tự dọn dẹp khi xóa phiên.
7. **Nén ngữ cảnh & Mở phiên tóm tắt (Context Management)**:
   - **ContextMeter**: Đo lường và hiển thị trực quan số lượng token ngữ cảnh đang chiếm dụng (bao gồm cả cache read và cache creation) so với giới hạn 200k tokens.
   - **Nén ngữ cảnh (`/compact`)**: Gửi lệnh `/compact` tới Claude CLI để tinh gọn bối cảnh và cập nhật lại số token ngữ cảnh.
   - **Mở phiên mới kèm tóm tắt (`/fork-summary`)**: Claude tóm tắt nội dung phiên hiện tại và mở ra một phiên chat mới sạch sẽ với bản tóm tắt làm tin nhắn đầu vào.
   - **Tự động nén (Auto-compact)**: Khi số token ngữ cảnh vượt ngưỡng `autoCompactPercent` (mặc định 85% của 200.000 tokens), hệ thống sẽ tự động kích hoạt nén ngữ cảnh sau mỗi lượt phản hồi.

### Mẹo hoặc lỗi thường gặp
- **Lỗi 403 Forbidden khi chọn Full Mode**: Nếu bạn chọn chế độ Đầy đủ mà hệ thống báo lỗi 403, nghĩa là file cấu hình `~/.agenthub/config.json` chưa cho phép `chat.allowFullMode = true`. Đây là cơ chế bảo vệ chủ động để tránh thao tác ngoài ý muốn.
- **Hủy lượt chat**: Khi một lượt phản hồi bị treo hoặc bạn muốn dừng sớm, hãy bấm nút **Hủy** (Cancel). Hệ thống sẽ gửi tín hiệu ngắt `SIGINT` nhã nhặn trước, và nếu sau 3 giây tiến trình chưa dừng mới cưỡng chế đóng nhóm tiến trình.
- **Không tìm thấy lệnh `claude`**: Đảm bảo bạn đã cài đặt Claude Code (`npm i -g @anthropic-ai/claude-code`) và lệnh `claude` có trong `$PATH` (hoặc kiểm tra đường dẫn trong `chat.claudeBin`).
- **Tắt tự động nén**: Nếu muốn quản lý nén ngữ cảnh hoàn toàn thủ công, bạn có thể đặt `chat.autoCompactPercent = 0` trong cài đặt.

---

## 2. Reviewer dự phòng bằng Codex & Trạng thái "Chờ người duyệt"

### Làm gì
Để quy trình phát triển không bị gián đoạn khi Claude hết hạn mức (quota exhaustion), AgentHub tích hợp cơ chế **Reviewer dự phòng tự động bằng OpenAI Codex CLI** (mặc định model `codex:gpt-5.6-luna`). Codex reviewer chạy hoàn toàn ở chế độ chỉ đọc (`readOnly: true`), sử dụng lock slot riêng để đánh giá mã nguồn dựa trên đề bài và kết quả autocheck.

### Dùng thế nào
- **Kích hoạt tự động**: Khi Claude gặp lỗi hết quota trong lúc chat hoặc review, trạng thái failover của hệ thống sẽ tự động bật. Bất kỳ task nào hoàn thành và chuyển sang trạng thái `review` sẽ được scheduler tự động giao cho Codex reviewer phụ trách.
- Codex đọc diff của git, xem kết quả autocheck và trả về một trong hai kết luận:
  - `approved` (Chấp thuận): Mã nguồn đạt yêu cầu, task chuyển sang `done`.
  - `changes_requested` (Yêu cầu sửa đổi): Kèm theo góp ý chi tiết (`feedback`), đưa task quay lại hàng đợi `queued` để worker tự sửa tiếp.

### Mẹo hoặc lỗi thường gặp
- **Trạng thái "Chờ người duyệt" (`reviewerEscalated: 1`)**:
  - Task hiển thị huy hiệu màu cam nổi bật **"Chờ người duyệt"** và được ưu tiên xếp lên đầu hàng đợi review trong các trường hợp sau:
    1. **Vượt quá số lần yêu cầu sửa đổi (`reviewer_changes_limit`)**: Codex reviewer đã yêu cầu sửa đổi vượt quá ngưỡng `maxChangesRequested` (mặc định 2 lần) mà worker vẫn chưa đạt. Hệ thống tạm dừng tự động review để tránh vòng lặp tốn quota.
    2. **Lỗi do môi trường chỉ đọc (`reviewer_environment`)**: Codex reviewer báo lỗi do hệ thống file chỉ đọc (EROFS, permission denied) chứ không phải lỗi của worker.
    3. **Thiếu kết quả autocheck (`missing_autocheck_results`)**: Task chưa có kết quả kiểm tra tự động hợp lệ đã lưu.
- **Cách xử lý khi task "Chờ người duyệt"**:
  - Trên Dashboard hoặc trang chi tiết Task, bạn có thể bấm nút **"Chạy lại reviewer"** (Retry reviewer) để cho Codex thử review lại.
  - Hoặc bạn (hoặc Claude) có thể trực tiếp review thủ công: xem git diff trên worktree và bấm nút Duyệt (`approved`) hoặc Yêu cầu chỉnh sửa (`changes_requested`).
- **Lỗi Uncommitted Changes**: Nếu Codex reviewer định chấp thuận nhưng git worktree còn sót lại file chưa commit (`git status` không sạch), hệ thống sẽ đánh dấu run review là lỗi để đảm bảo worker commit toàn bộ mã nguồn trước khi hoàn tất.

---

## 3. Autocheck, Trạng thái "Đang kiểm tra" & Lệnh `npm run check:migrate`

### Làm gì
Trước khi chuyển giao kết quả cho reviewer, AgentHub tự động chạy một bộ kiểm tra mã nguồn (autocheck) trên worktree của task. Trong thời gian này, task mang trạng thái **`checking` ("Đang kiểm tra")** với màu xanh ngọc (teal) và hiệu ứng nhấp nháy. Nếu phát hiện lỗi và cấu hình cho phép, worker sẽ được tự động kích hoạt lại để sửa lỗi trước khi người dùng cần can thiệp.

### Dùng thế nào
1. **Quy trình chuyển trạng thái**:
   - Khi worker tạo marker `.agenthub/DONE`, task lập tức chuyển sang `checking`.
   - Scheduler chạy tuần tự các lệnh kiểm tra đã đăng ký trong project (ví dụ: `lint`, `typecheck`, `test`, `build`, `migrate-live`).
   - Nếu **tất cả vượt qua**: Task chuyển sang `review` kèm kết quả kiểm tra thành công.
   - Nếu **thất bại**: Nếu `autoFixOnFail: true` và số lần sửa `checkFixAttempts < 2`, hệ thống tự động đưa task trở lại `queued` với cờ `resume: 1`, trích xuất 60 dòng log lỗi cuối cùng chèn vào `.agenthub/task.md` để worker đọc và tự sửa tiếp.
2. **Lệnh kiểm tra migration an toàn (`npm run check:migrate`)**:
   - Đây là autocheck chuyên biệt dành cho các project có cơ sở dữ liệu SQLite (`~/.agenthub/hub.db`).
   - Script `scripts/check-migrations-live.mjs` sẽ:
     - Mở DB thật ở chế độ chỉ đọc (`readonly: true`) để đếm số dòng ban đầu của các bảng (`tasks`, `runs`, `profiles`).
     - Dùng cơ chế `.backup()` của SQLite để sao lưu toàn bộ DB ra một thư mục tạm thời trong `/tmp`.
     - Mở bản sao DB tạm bằng hàm `openDatabase` (thực thi toàn bộ migration mới).
     - Kiểm tra toàn vẹn bằng `PRAGMA foreign_key_check` và `PRAGMA integrity_check`.
     - Đối chiếu số dòng dữ liệu để đảm bảo migration không làm mất mát bản ghi.

### Mẹo hoặc lỗi thường gặp
- **An toàn tuyệt đối cho DB thật**: `npm run check:migrate` không bao giờ ghi trực tiếp vào `hub.db`. Nếu môi trường không có DB thật (ví dụ trong CI/CD), script sẽ tự động in thông báo bỏ qua và trả về mã thành công 0.
- **Quên build trước khi check migrate**: Script kiểm tra migration yêu cầu `dist/db/index.js` đã được biên dịch sẵn. Vì vậy, trong cấu hình autocheck, bước `migrate-live` phải luôn được đặt **ngay sau bước `build`**.
- **Giới hạn tự sửa (Auto-fix limit)**: Worker chỉ được tự sửa lỗi autocheck tối đa 2 lần. Nếu sau 2 lần mà kiểm tra vẫn thất bại, task sẽ chuyển sang `review` với cảnh báo lỗi kiểm tra để người review quyết định.

---

## 4. Watchdog (Chống kẹt), Codex 2 Slot & Chuỗi Model (Model Chain)

### Làm gì
- **Watchdog**: Giám sát tiến trình worker theo thời gian thực dựa trên đa nguồn hoạt động (log, conversation database của agy, và git worktree) để phát hiện và xử lý kịp thời các trường hợp worker bị treo máy, chờ lệnh interactive (như hỏi mật khẩu) hoặc chạy lệnh nền không hồi kết.
- **Codex 2 Slot**: Cho phép một hồ sơ Codex CLI chạy song song tối đa 2 tác vụ độc lập mà không xung đột file lock.
- **Chuỗi Model (Model Chain)**: Tự động thử nghiệm danh sách các model theo thứ tự ưu tiên khi model trước đó hết quota.

### Dùng thế nào
1. **Cơ chế Watchdog đa nguồn hoạt động**:
   - **Đa nguồn giám sát**: Scheduler theo dõi 3 nguồn hoạt động để xác định mốc thời gian hoạt động mới nhất (`lastActivityAt`) và nguồn tương ứng (`activitySource`):
     - **File log (`log`)**: Mốc mtime của file log hiện tại (`run.logPath`).
     - **Conversation DB của agy (`conversation`)**: Mốc mtime mới nhất của các file SQLite DB cuộc hội thoại Antigravity (`*.db`, `*.db-wal`) trong thư mục `<HOME>/.gemini/antigravity-cli/conversations/`. Thư mục `<HOME>` được xác định theo từng profile (profile dạng `keyring` dùng `$HOME` thật của hệ thống, profile có thư mục riêng dùng `profile.home` ví dụ `~/.agy-homes/<tên_hồ_sơ>`). Chỉ xét các file thay đổi sau thời điểm run bắt đầu (`rt.startTime`). (Với engine không phải `agy`, nguồn này trả về 0).
       - *Vì sao cần nguồn conversation*: Khi chạy không tương tác (`agy -p`), Antigravity có thể không in bất kỳ stdout/stderr nào ra file log giữa các lượt gọi công cụ (tool call) trong khi agent vẫn đang suy nghĩ hoặc đợi tool hoàn tất. Nếu chỉ giám sát file log, watchdog sẽ lầm tưởng worker bị treo và diệt nhầm (kill nhầm) tiến trình worker Gemini đang chạy bình thường.
     - **Git worktree (`worktree`)**: Mốc mtime của file `.git/index` hoặc quét đệ quy các file trong worktree của task (`task.worktreePath`, tối đa 5.000 file/thư mục, bỏ qua `node_modules`, `.git/objects`, `dist`).
   - **Tối ưu hiệu năng & Cache**: Scheduler tick kiểm tra định kỳ mỗi 2 giây, nhưng việc quét đệ quy worktree và conversation tốn I/O đĩa. Vì vậy, kết quả mtime conversation và worktree được cache tối đa 30 giây trên từng run. Mỗi lần kiểm tra luôn đọc mtime log ngay, sau 30 giây mới quét lại conversation và `.git/index`, và chỉ đệ quy worktree khi cần (đồng thời dừng sớm ngay khi tìm thấy file có mtime mới hơn cache).
   - **Ngưỡng cấu hình và điều kiện coi là kẹt (`isStalled`)**:
     - **Ngưỡng mặc định**: `watchdog.stallMinutes = 20` (thời gian im lặng tối đa tính trên cả 3 nguồn) và `watchdog.waitingMinutes = 15`. Có thể tùy chỉnh các ngưỡng này bằng API `PUT /api/config` (truyền object `watchdog: { stallMinutes, waitingMinutes }`) hoặc thông qua trang Cài đặt trên Web dashboard.
     - **Kẹt do im lặng toàn diện**: Khi thời gian im lặng `silentMs = Date.now() - lastActivityAt` vượt quá `stallMinutes` (20 phút mà không có bất kỳ cập nhật nào từ cả log, conversation lẫn worktree).
     - **Kẹt khi chờ tác vụ nền (`waiting up to`)**: Khi `silentMs > waitingMinutes` (15 phút) VÀ 20 dòng cuối của file log có chứa chuỗi `"waiting up to"` (dấu hiệu worker gọi lệnh nền chờ đợi), trường hợp này **chỉ bị coi là kẹt khi cả log lẫn conversation cùng im lặng** quá `waitingMinutes` (với engine khác ngoài agy, chỉ cần log im lặng quá `waitingMinutes`).
   - **Quy trình xử lý khi bị kẹt (`handleStall`)**:
     - Watchdog tự động diệt toàn bộ nhóm tiến trình (`killProcessGroup`), giải phóng lock slot của profile, cập nhật run thành `crashed` với lý do `stalled` (`runs.reason = 'stalled'`), và phát sự kiện `run.stalled`.
     - Tự động đưa task quay lại hàng đợi `queued` với cờ `resume: 1` và bổ sung ghi chú vào nội dung đề bài: *"Lượt trước bị kẹt khi chờ tác vụ nền. Chạy lệnh trực tiếp với timeout."*
     - Giới hạn thử lại: Tối đa 2 lần (`stalledCount <= 2`). Nếu bị kẹt đến lần thứ 3 (`stalledCount > 2`), task sẽ chuyển sang `failed` với lý do `stalled_limit`.
   - **Trường `activitySource` và `lastActivityAt` trong API Task (`currentRun`)**:
     - Khi gọi API lấy task (`GET /api/tasks` hoặc `GET /api/tasks/:id`), đối tượng `currentRun` của task đang chạy trả về các trường phản ánh trạng thái giám sát:
       - `startedAt`: Thời điểm bắt đầu lượt chạy hiện tại (ISO string).
       - `lastOutputAt`: Thời điểm có output log mới nhất (ISO string).
       - `lastActivityAt`: Mốc thời gian hoạt động mới nhất ghi nhận được từ nguồn gần nhất trong 3 nguồn (ISO string).
       - `activitySource`: Nguồn hoạt động gần nhất mang lại mtime cho `lastActivityAt`, nhận một trong ba giá trị: `'log'` (output log), `'conversation'` (cơ sở dữ liệu hội thoại agy), hoặc `'worktree'` (thay đổi file/index trong git worktree).
2. **Codex chạy 2 Slot**:
   - Cấu hình qua `slotsPerCodexProfile` (mặc định là 2).
   - Hệ thống quản lý thông qua hai file lock riêng biệt: `codex.lock` (slot 1) và `codex.lock2` (slot 2) tại thư mục `.state`.
   - Nhờ đó, một tài khoản Codex có thể đảm nhiệm đồng thời 2 task worker, hoặc 1 task worker và 1 task reviewer cùng lúc.
3. **Chuỗi Model (Model Chain)**:
   - Cấu hình chuỗi model mặc định theo độ khó:
     - Task khó (`hard`): `['codex:gpt-5.6-luna', 'gemini-3.8-flash-high']`
     - Task dễ (`easy`): `['gemini-3.8-flash-medium', 'codex:gpt-5.6-luna']`
   - Khi tạo task, bạn cũng có thể chỉ định riêng mảng `modelChain: ["model-1", "model-2"]`. Khi `model-1` hết quota, scheduler tự động chuyển sang `model-2`. Chỉ khi tất cả model trong chuỗi đều hết quota, task mới chuyển sang `waiting_quota`.

### Mẹo hoặc lỗi thường gặp
- **Tránh chạy lệnh nền trong worker**: Đề bài cho AI worker luôn cần nhắc nhở: *Không chạy test hoặc server ở chế độ nền (background) rồi chờ; luôn chạy trực tiếp (foreground) kèm bọc `timeout 300` và cờ `--run`*.
- **Giới hạn khi hai slot dùng chung một profile**: Khi cấu hình một profile Antigravity chạy đồng thời 2 slot, do hệ thống chưa lưu ID cuộc hội thoại riêng cho từng lượt chạy, scheduler sẽ dùng file conversation DB mới nhất trong thư mục `conversations` của profile đó. Vì vậy, hoạt động của slot này có thể được tính chung cho slot kia, làm mới mốc hoạt động của cả hai.
- **Giới hạn số lần thử lại khi kẹt**: Watchdog chỉ cho phép thử lại tối đa 2 lần. Nếu task bị kẹt đến lần thứ 3, task sẽ chuyển sang `failed` với lý do `stalled_limit`.

---

## 5. Chặn khi Ổ đĩa gần đầy, Tự dọn `node_modules` & Lệnh `agenthub clean`

### Làm gì
Các dự án lớn khi phân nhánh thành nhiều git worktree và cài đặt dependencies (`node_modules`) có thể tiêu tốn hàng chục gigabyte dung lượng ổ cứng. AgentHub trang bị cơ chế tự động bảo vệ ổ đĩa và dọn dẹp dung lượng thông minh.

### Dùng thế nào
1. **Chặn khởi chạy khi ổ đĩa gần đầy**:
   - Cấu hình qua `disk.minFreeGB` (mặc định là 3 GB).
   - Trước khi tạo worktree hoặc khởi chạy task mới, scheduler kiểm tra dung lượng còn trống tại thư mục chứa worktrees.
   - Nếu dung lượng trống `< minFreeGB`: Hệ thống tạm dừng task (chuyển sang `waiting_quota` với lý do `disk`), phát sự kiện `disk.low` và gửi thông báo desktop cảnh báo người dùng.
   - Khi ổ đĩa được giải phóng `>= minFreeGB`, scheduler tự động tiếp tục đưa các task vào hàng đợi chạy (`disk_ready`).
2. **Tự động dọn `node_modules` khi task hoàn tất**:
   - Cấu hình qua `cleanup.nodeModulesOnDone: true` (mặc định bật).
   - Ngay khi task chuyển sang trạng thái `done` hoặc `cancelled`, AgentHub tự động xóa các thư mục `node_modules` và `web/node_modules` bên trong worktree của task.
   - Cấu hình `cleanup.worktreeOnDoneAfterHours` (mặc định 24 giờ): Sau 24 giờ kể từ khi task `done`, toàn bộ thư mục worktree sẽ được dọn sạch hoàn toàn.
3. **Lệnh CLI `agenthub clean`**:
   - Dọn dẹp thủ công các thư mục `node_modules` của toàn bộ task đã hoàn thành:
     ```bash
     # Xem trước các thư mục sẽ xóa và dung lượng dự kiến giải phóng (an toàn)
     agenthub clean --dry-run

     # Thực hiện dọn dẹp thật
     agenthub clean
     ```

### Mẹo hoặc lỗi thường gặp
- **Dọn dẹp Monorepo**: Lệnh clean tự động quét cả thư mục `node_modules` ở gốc worktree lẫn thư mục con `web/node_modules`.
- **Chủ động xóa worktree**: Nếu muốn giải phóng dung lượng ngay lập tức mà không cần đợi sau 24h, bạn chỉ cần bấm nút **"Xóa worktree"** trên thẻ task tại Dashboard.

---

## 6. Hạn mức thật (`/usage`), Trạng thái Đăng nhập & Xác minh Tài khoản

### Làm gì
Thay vì chỉ ước lượng số lượng token đã dùng, AgentHub trực tiếp thu thập dữ liệu hạn mức thực tế mà Google cấp cho từng tài khoản Antigravity (`agy`), đồng thời tự động phát hiện các tài khoản bị mất phiên đăng nhập hoặc cần xác minh danh tính.

### Dùng thế nào
1. **Thu thập hạn mức thật (`/usage`)**:
   - Định kỳ mỗi 5 phút hoặc ngay sau khi worker kết thúc một phiên chạy, AgentHub gọi lệnh `agy -p /usage` trong môi trường cách ly riêng biệt của từng tài khoản (`HOME=~/.agy-homes/<tên_hồ_sơ>`).
   - Dữ liệu thu thập gồm tỷ lệ phần trăm còn lại (`remainingPct`) và thời điểm reset (`resetAt`) cho hai chu kỳ:
     - **Cửa sổ 5 giờ (`5h`)**: Giới hạn tốc độ ngắn hạn.
     - **Cửa sổ tuần (`week`)**: Hạn mức tổng cộng trong tuần.
   - Phân loại rõ ràng theo hai nhóm: `Gemini Models` và `Claude and GPT models`.
2. **Các trạng thái xác thực (`authState`)**:
   - `ok`: Tài khoản đăng nhập bình thường, kết nối quota ổn định.
   - `not_logged_in`: Chưa đăng nhập hoặc phiên xác thực đã hết hạn.
   - `needs_verification`: Tài khoản Google yêu cầu xác minh bảo mật (gặp lỗi `Eligibility check failed`, `Verify your account` hoặc `not eligible`).
   - `error`: Lỗi kết nối máy chủ hoặc lỗi thực thi CLI.

### Mẹo hoặc lỗi thường gặp
- **Tài khoản báo "Cần xác minh" (`needs_verification`)**:
  - Khi gặp lỗi này, AgentHub tự động bóc tách link xác minh của Google (dạng `https://accounts.google.com/...`) từ output dòng lệnh và gắn vào tài khoản.
  - Trên Dashboard, bạn chỉ cần nhấp trực tiếp vào đường link hoặc nút xác minh để mở trình duyệt và hoàn tất xác thực tài khoản Google.
- **Tránh trùng tài khoản khi đăng nhập lại**:
  - Khi chạy `agenthub profile login <tên_hồ_sơ>`, trình duyệt có thể tự dùng lại tài khoản Google cũ. Bạn **bắt buộc phải nhấp chọn "Sử dụng tài khoản khác" (Use another account)** trên trang Google OAuth để đăng nhập đúng tài khoản dự kiến.

---

## 7. Trang Hiệu quả Ủy quyền (Savings Page)

### Làm gì
Trang **Hiệu quả** (Savings) lượng hóa giá trị thực tế của hệ thống bằng cách tính toán số lượng token Claude được tiết kiệm khi bạn giao việc cho các worker giá rẻ (Gemini Flash, Codex) làm thay, đồng thời so sánh với chi phí token Claude đã dùng để điều phối và review.

### Dùng thế nào
Truy cập mục **Hiệu quả** trên thanh điều hướng Web Dashboard. Bạn có thể lọc báo cáo theo từng dự án hoặc mốc thời gian (`since`).

#### Ý nghĩa các chỉ số tổng quan:
1. **Worker Tokens**: Tổng số token mà các AI worker (Gemini, Codex) đã tiêu thụ.
2. **Claude Tiết kiệm (`claudeSavedTokens`)**: Số token Claude tiết kiệm được nhờ không phải tự viết code.
3. **Chi phí Claude (`claudeCostTokens`)**: Số token Claude tiêu tốn để đọc đề bài, giao việc và thực hiện review mã nguồn.
4. **Tỷ lệ Tiết kiệm (`savingsRatio`)**: Tỷ lệ phần trăm hiệu quả ủy quyền.
5. **Tổng dòng thay đổi (+/-)**: Số dòng mã nguồn thêm mới (`linesAdded`) và xóa bỏ (`linesDeleted`) do worker thực hiện, đo lường trực tiếp từ `git diff --shortstat`.
6. **Số task hoàn thành**: Số lượng task đã đạt trạng thái `done` sau khi được review chấp thuận.
7. **Số vòng review trung bình (`avgReviewRounds`)**: Số lần yêu cầu chỉnh sửa (`changes_requested`) trung bình trên mỗi task hoàn thành.

#### Công thức tính toán và các hệ số:
- **Token của Codex**: Đọc trực tiếp từ dòng tổng kết `"tokens used: <số>"` ở cuối log thực thi.
- **Token của Antigravity (Gemini)**:
  $$\text{tokens} = \frac{(\text{usageBefore} - \text{usageAfter}) \times \text{bucketTokens}}{100 \times \text{concurrentRunsCount}}$$
  *(Nếu có nhiều tiến trình chạy đồng thời trên cùng tài khoản hoặc số liệu sụt giảm $\le 0$, số token sẽ được đánh dấu là ước tính $\sim$)*.
- **Hệ số cấu hình mặc định trong `config.json`**:
  - `bucketTokens.gemini`: 5.000.000 tokens (dung lượng tương đương 100% quota 5h của Gemini).
  - `bucketTokens.claude`: 5.000.000 tokens.
  - `claudeFactor`: **0.9** (Nghĩa là 1 token worker tương đương 0.9 token Claude nếu Claude tự viết mã: $\text{claudeSavedTokens} = \text{taskTokens} \times 0.9$, chỉ tính cho task `done`).
  - `claudeOverheadPerTask`: **40.000 tokens** (Chi phí Claude đọc bối cảnh và giao việc cho 1 task).
    $$\text{taskClaudeCost} = \text{claudeOverheadPerTask} \times (1 + \text{reviewRounds})$$
  - **Công thức tỷ lệ tiết kiệm**:
    $$\text{savingsRatio} = \frac{\text{claudeSavedTokens}}{\text{claudeSavedTokens} + \text{claudeCostTokens}}$$

### Mẹo hoặc lỗi thường gặp
- **Chỉ task `done` mới tính tiết kiệm**: Các task đang chạy, thất bại hoặc bị hủy sẽ không được tính vào số token tiết kiệm, đảm bảo số liệu báo cáo luôn trung thực và phản ánh đúng giá trị code thực tế đã được nghiệm thu.
- **Dấu ngã $\sim$ trước số token**: Thể hiện số token được ước tính (estimated) do thiếu mốc snapshot quota trước/sau hoặc có nhiều worker cùng chạy trên một tài khoản.

---

## 8. Giao diện Sáng/Tối & Song ngữ Tiếng Việt / Tiếng Anh

### Làm gì
AgentHub hỗ trợ tùy biến giao diện toàn diện với chế độ màu Sáng/Tối (Light/Dark Theme) bảo vệ mắt và hỗ trợ song ngữ (i18n) hoàn chỉnh giữa Tiếng Việt và Tiếng Anh.

### Dùng thế nào
- **Chuyển đổi Theme**: Nhấp vào biểu tượng Mặt Trời / Mặt Trăng trên thanh điều hướng trên cùng. Bạn có thể chọn:
  - **Tối (Dark)**: Giao diện nền tối mặc định của hệ thống.
  - **Sáng (Light)**: Giao diện nền sáng tương phản cao.
  - **Hệ thống (System)**: Tự động đổi theo cấu hình giao diện của hệ điều hành.
- **Chuyển đổi Ngôn ngữ**: Nhấp vào nút `VI` / `EN` trên thanh điều hướng để đổi tức thì toàn bộ nhãn, bảng thống kê và thông báo sang Tiếng Việt hoặc Tiếng Anh.

### Mẹo hoặc lỗi thường gặp
- **Đồng bộ màu sắc với Terminal**: Khi đổi theme, cửa sổ dòng lệnh xterm tương tác (như màn hình đăng nhập profile) cũng tự động cập nhật bảng màu nền, chữ và con trỏ tương thích ngay lập tức.
- **Lưu cấu hình tự động**: Lựa chọn theme và ngôn ngữ được tự động lưu vào `localStorage` của trình duyệt (`agenthub_theme` và `agenthub_locale`) để giữ nguyên cấu hình ở các lần truy cập sau.
- **Định dạng số theo quốc gia**: Các con số thống kê (token, dung lượng đĩa, ngày giờ) tự động định dạng chuẩn theo ngôn ngữ được chọn (`vi-VN` dùng dấu chấm phân tách hàng nghìn, `en-US` dùng dấu phẩy).

---

## 9. Thông báo Desktop (Desktop Notifications)

### Làm gì
Hệ thống tự động phát các thông báo nổi trên màn hình desktop (OS notifications) khi có sự kiện quan trọng phát sinh, giúp bạn có thể thu nhỏ trình duyệt để làm việc khác mà vẫn nắm bắt kịp thời tiến độ thực hiện task.

### Dùng thế nào
AgentHub sử dụng công cụ tiêu chuẩn `notify-send` trên Linux để phát thông báo cho các sự kiện:
- `task.review_ready`: Task đã code xong và autocheck hoàn tất, sẵn sàng chờ review (kèm biểu tượng `✓` hoặc `✗` checks).
- `task.failed` / `task.blocked`: Task gặp lỗi không thể tiếp tục hoặc worker tạo báo cáo bị chặn.
- `review.escalated`: Task rơi vào trạng thái "Cần người duyệt".
- `quota.exhausted`: Hồ sơ AI worker hết quota kèm thời gian mở khóa dự kiến.
- `disk.low` / `disk.ok`: Cảnh báo dung lượng ổ đĩa gần đầy hoặc thông báo ổ đĩa đã đủ chỗ để tiếp tục chạy task.

Các thông báo đều được thiết lập:
- Gắn cờ định danh ứng dụng `-a AgentHub` để hệ điều hành dễ dàng phân loại và gom nhóm.
- Tự động đóng sau 10 giây (`-t 10000`).
- Cơ chế chống spam (debounce): Tự động chặn lặp lại thông báo có cùng nội dung trong vòng 30 giây.

### Mẹo hoặc lỗi thường gặp
- **Tắt thông báo**: Nếu không muốn nhận thông báo nổi, bạn có thể tắt bằng cách sửa cấu hình `~/.agenthub/config.json`:
  ```json
  {
    "notifications": {
      "desktop": false
    }
  }
  ```
- **Thông báo không tự tắt trên một số desktop Linux**: Nếu bạn dùng các trình quản lý thông báo tối giản (như một số phiên bản cũ của `dunst` hoặc `mako`) không hỗ trợ tham số timeout `-t`, thông báo có thể lưu lại trên màn hình. Bạn có thể kiểm tra cấu hình timeout trong file cấu hình của notification daemon trên máy hoặc khởi động lại daemon thông báo (`pkill dunst && dunst &`).

---

## 10. Đăng nhập tài khoản Claude & Quản lý hồ sơ Claude

### Làm gì
AgentHub hỗ trợ quản lý đa hồ sơ Claude Code (`claude`), cho phép phân tách bối cảnh, lưu trữ phiên làm việc biệt lập theo từng dự án hoặc tài khoản và tích hợp liền mạch với cơ chế luân chuyển tài khoản trong chuỗi dự phòng.

### Dùng thế nào
1. **Thư mục lưu trữ biệt lập**:
   - Mỗi hồ sơ Claude được lưu trữ tại:
     ```
     ~/.agenthub/claude-homes/<tên_hồ_sơ>/
     ```
   - Thư mục được cấp quyền truy cập nghiêm ngặt `0700` (chỉ user sở hữu có quyền đọc/ghi), chứa cấu hình Claude cục bộ `.claude.json` và chứng thực `.credentials.json`.
2. **Tạo và đăng nhập hồ sơ**:
   - **Qua Web Dashboard**: Mở trang **Tài khoản (Profiles)** -> bấm **Thêm tài khoản** -> chọn engine **Claude** -> nhập tên hồ sơ -> chọn loại tài khoản (`personal`, `team`, `api_key`) -> bấm **Tạo & Đăng nhập**. Giao diện mở terminal tương tác PTY và tự động gửi lệnh `/login`. Bạn mở liên kết trình duyệt được cung cấp, xác thực tài khoản Anthropic, sao chép mã ủy quyền một lần (OAuth code) và dán vào ô nhập trên dashboard.
   - **Qua dòng lệnh CLI**:
     ```bash
     agenthub profile add claude-work --engine claude
     agenthub profile login claude-work
     ```
3. **Trạng thái xác thực tự động**:
   - Hệ thống tự động phân tích file `.claude.json` để trích xuất email tài khoản và xác minh phiên đăng nhập.
   - Thẻ hồ sơ hiển thị trạng thái:
     - **Đã đăng nhập**: Hiển thị email và sẵn sàng nhận lệnh điều phối.
     - **Chưa đăng nhập**: Phiên đăng nhập hết hạn hoặc chưa cấu hình, kèm nút đăng nhập nhanh.
     - **Lỗi**: Không đọc được thông tin cấu hình hoặc tiến trình CLI bị lỗi.
4. **Hỗ trợ đa loại tài khoản (Account Types)**:
   - `personal`: Gói cá nhân (Claude Pro).
   - `team`: Gói đội ngũ (Claude Team / Enterprise).
   - `api_key`: Dùng token API trả trước hoặc theo mức dùng.
   - Mặc định AgentHub chỉ cho phép 1 hồ sơ `personal` để tránh xoay vòng tài khoản cá nhân; hồ sơ `team` và `api_key` có thể thêm không giới hạn.

### Mẹo hoặc lỗi thường gặp
- **Mã xác thực hết hạn**: Mã OAuth của Claude thường chỉ có hiệu lực trong khoảng 60 giây. Nếu bị chậm, hãy bấm **Đăng nhập lại** trên dashboard để nhận mã mới.
- **Xóa hồ sơ an toàn**: Khi xóa một hồ sơ Claude, bạn có thể chọn giữ lại thư mục đăng nhập (chỉ ẩn hồ sơ khỏi hub) hoặc xóa sạch hoàn toàn thư mục `~/.agenthub/claude-homes/<tên>`.

---

## 11. Chuỗi dự phòng khi hết token (Claude Fallback Chain)

### Làm gì
Khi Claude đóng vai trò là bộ não điều phối hoặc reviewer, việc gặp lỗi giới hạn tốc độ (HTTP 429) hoặc cạn kiệt hạn mức sử dụng (usage limits / quota exhaustion) có thể làm tê liệt toàn bộ quy trình phát triển tự động. Tính năng **Chuỗi dự phòng Claude (Fallback Chain)** giải quyết vấn đề này bằng cách tự động kích hoạt tuần tự các bước dự phòng đã định nghĩa trong cấu hình `brain.fallback` mà không làm gián đoạn các task đang chạy.

### Dùng thế nào
1. **Các bước dự phòng hỗ trợ**:
   Hệ thống hỗ trợ 5 loại bước dự phòng có thể tùy biến thứ tự ưu tiên:
   - **`profile` (Đổi hồ sơ Claude)**: Chuyển sang một hồ sơ Claude khác đã đăng nhập và đang kích hoạt (ví dụ: chuyển từ gói cá nhân sang gói Team).
     ```json
     { "type": "profile", "profile": "claude-team" }
     ```
     *(Nếu không khai báo thuộc tính `profile`, hub sẽ tự động tìm hồ sơ Claude bất kỳ khác đang ở trạng thái đã đăng nhập).*
   - **`model` (Hạ cấp model)**: Chuyển sang model Claude nhẹ hơn (như Claude 3.5 Haiku) để tiếp tục phản hồi với mức tiêu thụ quota thấp hơn.
     ```json
     { "type": "model", "model": "haiku" }
     ```
   - **`apiKey` (Dùng Anthropic API Key có trần chi phí)**: Kích hoạt API key Anthropic trả phí trực tiếp.
     ```json
     { "type": "apiKey", "dailyCapUSD": 5 }
     ```
   - **`engine` (Chuyển sang Codex reviewer / engine)**: Kích hoạt OpenAI Codex CLI (chế độ chỉ đọc `readOnly: true`) để tiếp tục review code.
     ```json
     { "type": "engine", "engine": "codex" }
     ```
   - **`wait` (Chờ reset quota)**: Tạm dừng và chờ đợi đến thời điểm mở khóa quota tiếp theo của Claude (`resetAt`).
     ```json
     { "type": "wait" }
     ```
2. **Ví dụ cấu hình toàn diện trong `~/.agenthub/config.json`**:
   ```json
   {
     "brain": {
       "fallback": [
         { "type": "profile", "profile": "claude-team" },
         { "type": "model", "model": "haiku" },
         { "type": "apiKey", "dailyCapUSD": 5 },
         { "type": "engine", "engine": "codex" },
         { "type": "wait" }
       ]
     }
   }
   ```
3. **Cơ chế kiểm soát chi phí & Bảo mật API Key**:
   > [!WARNING] **Cảnh báo chi phí khi sử dụng API key**
   > Khác với các gói thuê bao cố định tháng (Claude Pro / Team), Anthropic API key tính phí trực tiếp trên từng token gửi nhận (pay-as-you-go). Khi giao việc cho các task lớn, chi phí API key có thể tăng nhanh nếu không có cơ chế giới hạn.
   > AgentHub bảo vệ ngân sách của bạn thông qua các nguyên tắc nghiêm ngặt:
   > - **Trần chi phí hàng ngày (`dailyCapUSD`)**: Bắt buộc phải khai báo mức chi phí tối đa cho phép mỗi ngày (ví dụ 5 USD/ngày). Chi phí được theo dõi chính xác theo từng lượt gọi và tự động reset vào 00:00 UTC mỗi ngày. Khi chi phí trong ngày chạm ngưỡng trần, hệ thống lập tức khóa bước API key và chuyển tiếp sang bước dự phòng tiếp theo.
   > - **Bảo mật tuyệt đối**: API key được lưu tại file `~/.agenthub/secrets/anthropic.key` với quyền truy cập `0600`. Key không bao giờ được lưu vào database `hub.db`, không xuất hiện trong log và không trả về qua API (chỉ báo `{ apiKeyConfigured: true }`).
4. **Theo dõi trạng thái Fallback**:
   - Trên Dashboard, thẻ trạng thái Brain và mục Cài đặt (Settings) hiển thị bước dự phòng đang kích hoạt, lý do kích hoạt, thời điểm reset dự kiến và tổng chi phí API key đã tiêu thụ trong ngày.
   - Khi có sự kiện chuyển đổi bước dự phòng, hệ thống phát sự kiện `claude.fallback_changed`, gửi thông báo desktop và tin nhắn Telegram tức thời.

### Mẹo hoặc lỗi thường gặp
- **Không tự động merge khi Codex review**: Khi bước dự phòng chuyển sang Codex review, để đảm bảo an toàn tuyệt đối, các quyết định `approved` của Codex sẽ không tự động merge code vào nhánh chính mà giữ ở trạng thái chờ người dùng kiểm tra lại.
- **Hồ sơ chưa đăng nhập bị bỏ qua**: Khi chuyển bước sang một profile Claude cụ thể, nếu profile đó chưa đăng nhập hoặc bị vô hiệu hóa, hệ thống sẽ tự động bỏ qua và chuyển tiếp ngay sang bước kế tiếp.

---

## 12. Điều khiển từ xa qua Telegram (Telegram Remote Control)

### Làm gì
Tính năng Điều khiển từ xa qua Telegram Bot cho phép bạn giám sát toàn bộ hoạt động của AgentHub, nhận cảnh báo thời gian thực, duyệt code hoàn thành, phê duyệt quyền công cụ bằng nút bấm và trò chuyện trực tiếp với Claude Code ngay trên điện thoại di động mà không cần mở máy tính hay mở cổng mạng ra Internet.

### Dùng thế nào
1. **Tạo bot với @BotFather**:
   - Mở ứng dụng Telegram, tìm kiếm tài khoản chính thức **`@BotFather`**.
   - Gửi lệnh `/newbot`, nhập tên hiển thị (ví dụ: `MyAgentHubBot`) và username kết thúc bằng `bot` (ví dụ: `my_agenthub_bot`).
   - Sao chép chuỗi mã HTTP API Bot Token được cung cấp (dạng: `123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ`).
2. **Cấu hình Token vào AgentHub**:
   - **Qua Web Dashboard**: Mở trang **Settings**, tìm mục **Telegram Bot**, nhập token và bấm **Lưu token**.
   - **Qua file bí mật**:
     ```bash
     mkdir -p ~/.agenthub/secrets
     echo "YOUR_BOT_TOKEN_HERE" > ~/.agenthub/secrets/telegram.token
     chmod 0600 ~/.agenthub/secrets/telegram.token
     ```
   - Cấu hình các loại thông báo trong `~/.agenthub/config.json`:
     ```json
     {
       "telegram": {
         "enabled": true,
         "botTokenFile": "~/.agenthub/secrets/telegram.token",
         "allowedChatIds": [],
         "notify": {
           "reviewReady": true,
           "failed": true,
           "blocked": true,
           "quota": true,
           "fallback": true
         }
       }
     }
     ```
3. **Quy trình Ghép đôi an toàn (Pairing Flow)**:
   - Trên Web Dashboard (trang **Settings** -> mục Telegram) hoặc gọi API `POST /api/telegram/pair-code`, bấm **Tạo mã ghép đôi**.
   - Hệ thống sinh một mã xác thực 6 chữ số ngẫu nhiên (có hiệu lực trong 5 phút).
   - Mở bot Telegram của bạn, bấm **Start** hoặc gửi tin nhắn chứa mã 6 chữ số (hoặc cú pháp `/start <mã>` / `/pair <mã>`).
   - Bot đối chiếu mã, xác nhận kết nối thành công và lưu `chatId` của bạn vào danh sách cho phép (`allowedChatIds`).
4. **Danh sách lệnh điều khiển từ xa**:
   - **Quản lý hệ thống**:
     - `/status`: Báo cáo tình trạng hệ thống: số task đang chạy/chờ, mức sử dụng CPU/RAM, ổ đĩa, tình trạng quota các tài khoản.
     - `/pause`: Tạm dừng giao task mới cho worker (task đang chạy vẫn tiếp tục).
     - `/resume`: Khôi phục việc giao task mới.
     - `/help`: Xem danh sách lệnh và hướng dẫn cú pháp.
   - **Quản lý Task**:
     - `/tasks [trạng thái]`: Liệt kê các task (ví dụ: `/tasks review` xem task chờ duyệt, `/tasks running` xem task đang chạy).
     - `/task <id>`: Xem chi tiết task (đề bài, kết quả autocheck, commit mới nhất) kèm các nút bấm thao tác nhanh.
     - `/log <id>`: Trích xuất 30 dòng log thực thi mới nhất của task.
     - `/approve <id>`: Duyệt task hoàn thành (tự động merge nếu dự án đã cấu hình worktree merge).
     - `/reject <id> <nhận xét>`: Trả về task yêu cầu worker sửa lại kèm nhận xét cụ thể.
     - `/cancel <id>`: Hủy task đang chạy hoặc chờ (hiển thị nút inline xác nhận an toàn trước khi hủy).
     - `/retry <id>`: Chạy lại task bị lỗi hoặc bị chặn.
   - **Trò chuyện trực tiếp với Claude**:
     - Mọi tin nhắn văn bản thông thường (không có dấu `/` ở đầu) gửi tới bot được tự động định tuyến vào phiên trò chuyện Claude riêng biệt (`telegram:<chatId>`).
     - `/new`: Khởi tạo một phiên trò chuyện mới với Claude.
     - `/stop`: Dừng lượt phản hồi hiện tại của Claude.
   - **Duyệt quyền công cụ (Permission Prompt)**:
     - Khi Claude ở chế độ an toàn cần thực thi lệnh hoặc công cụ, bot sẽ gửi tin nhắn yêu cầu kèm 3 nút inline: **Cho phép**, **Luôn cho phép** và **Từ chối**. Bạn chỉ cần bấm nút trực tiếp trên điện thoại để phê duyệt.
   - **Thông báo sự kiện tự động**:
     - Nhận tin nhắn thông báo khi task hoàn thành autocheck (`reviewReady`), kèm các nút bấm inline để Duyệt (`approve`), Trả về (`reject`), hoặc Xem log (`log`) ngay lập tức.
     - Cảnh báo khi task gặp lỗi (`failed`), worker bị chặn (`blocked`), tài khoản hết quota (`quota`), hoặc khi kích hoạt chuỗi dự phòng (`fallback`).
5. **Kiến trúc Bảo mật**:
   - **Chỉ chat đã ghép đôi mới có quyền điều khiển**: Mọi tin nhắn từ người dùng hoặc nhóm chat lạ chưa qua ghép đôi đều bị từ chối ngay lập tức và ghi log cảnh báo; người ngoài không thể gửi lệnh hay truy cập dữ liệu máy chủ.
   - **Token bot lưu với quyền 0600**: File token `telegram.token` chỉ cho phép tài khoản người dùng hệ thống sở hữu file đọc/ghi (`chmod 0600`).
   - **Che giấu token an toàn**: Token không bao giờ được lưu trong cơ sở dữ liệu `hub.db`, không xuất hiện trong file log hay trả về qua API/UI (chỉ hiển thị cờ `configured: true`).

### Mẹo hoặc lỗi thường gặp
- **Tin nhắn Telegram dài quá 4096 ký tự**: AgentHub tự động chia nhỏ các phản hồi dài thành nhiều tin nhắn tuần tự để đảm bảo không bị lỗi giới hạn độ dài của Telegram API.
- **Giới hạn tốc độ cập nhật tin nhắn (Rate Limit)**: Trong lúc Claude streaming phản hồi, AgentHub điều tiết tần suất chỉnh sửa tin nhắn (`editMessageText`) tối thiểu 1.5 giây một lần để tránh bị Telegram chặn vì spam API.
- **Gỡ bỏ chat đã ghép đôi**: Bạn có thể dễ dàng hủy quyền điều khiển của một chat ID bất kỳ trên trang Cài đặt (Settings) của Web Dashboard hoặc gọi API `DELETE /api/telegram/chats/:id`.

## 13. Tham chiếu chỉ đọc (References) & Rào chắn bảo vệ worker (Worker Guardrails)
### Làm gì
Để tránh trường hợp AI worker tự ý sửa đổi code gốc của các thư viện dùng chung, tài liệu đặc tả, bảng thuật ngữ hoặc vô tình thực hiện các thao tác phá hủy (như `git push`, gọi lệnh mạng SSH ra ngoài, can thiệp container Docker hệ thống), AgentHub cung cấp cơ chế bảo vệ hai lớp:
1. **Tham chiếu chỉ đọc (`settings.references`)**: Cung cấp đường dẫn và tài liệu ngữ cảnh ngoài repo cho worker với cam kết CHỈ ĐỌC, đồng thời chụp snapshot trước khi chạy và phát hiện mọi hành vi ghi/sửa file để chặn task kịp thời.
2. **Rào chắn lệnh (Worker Command Shims & Codex Sandbox)**: Tạo các shim chặn các lệnh nguy hiểm (`ssh`, `docker`, `git push`, v.v.) trong môi trường worker, và hỗ trợ kích hoạt sandbox giới hạn ghi của Codex worker (`workers.codexSandbox`).

### Dùng thế nào
#### 1. Cấu hình Tham chiếu (`settings.references`)
Trong cài đặt của dự án (`settings.references`), bạn có thể khai báo danh sách các thư mục hoặc file tài liệu dùng chung:
```json
{
  "references": [
    {
      "name": "design_system",
      "path": "/shared/docs/design-system.md",
      "inject": true
    },
    {
      "name": "shared_lib",
      "path": "/shared/packages/core",
      "inject": false
    }
  ]
}
```
- **Tự động đưa vào ngữ cảnh worker (`.agenthub/context/references.md`)**:
  - Liệt kê đầy đủ tên tham chiếu, đường dẫn tuyệt đối, và quy tắc nghiêm ngặt: **CHỈ ĐỌC, không sửa đổi, không commit vào git**.
  - Tự động thiết lập biến môi trường `AGENTHUB_REF_<NAME>` (ví dụ: `AGENTHUB_REF_DESIGN_SYSTEM`) trỏ đến đường dẫn của từng tham chiếu để worker hoặc script kiểm tra có thể truy cập thuận tiện.
- **Tự động nhúng nội dung (`inject: true`)**:
  - Với file văn bản có kích thước $\le$ 64KB, nội dung file sẽ được nhúng trực tiếp vào `.agenthub/context/references.md` giúp worker nắm bắt quy ước và bảng thuật ngữ nhanh chóng mà không cần tốn lượt gọi công cụ đọc file.
  - File lớn hơn 64KB hoặc thư mục sẽ chỉ được liệt kê đường dẫn kèm cảnh báo trong ngữ cảnh và log.
  - Đường dẫn tham chiếu không tồn tại sẽ hiển thị cảnh báo trong ngữ cảnh nhưng không làm sập hay chặn task.
- **Tự động chép `AGENTS.md` dự án**:
  - File hướng dẫn quy tắc chung `AGENTS.md` (kích thước $\le$ 32KB) ở thư mục gốc của repository sẽ được tự động sao chép vào `.agenthub/context/AGENTS.md` để worker luôn đọc được dù ở trong nhánh worktree cô lập.
- **Chụp snapshot và phát hiện sửa đổi (Modification Detection)**:
  - Trước khi worker bắt đầu, scheduler tự động chụp snapshot trạng thái từng tham chiếu:
    - Repository git: ghi nhận `git status --porcelain` và mã băm commit `HEAD`.
    - Thư mục thông thường: ghi nhận đệ quy `mtime` và kích thước các file.
    - File đơn lẻ: ghi nhận `mtime`, dung lượng và mã băm SHA-256.
  - Khi worker kết thúc, scheduler kiểm tra lại snapshot. Nếu phát hiện bất kỳ file nào bị thêm, sửa hoặc xóa:
    - Thu hồi và xóa file đánh dấu `.agenthub/DONE` nếu worker đã tạo.
    - Tạo file `.agenthub/BLOCKED` liệt kê chi tiết danh sách file bị sửa đổi.
    - Chuyển trạng thái task sang `blocked`, phát sự kiện `reference.modified` và `task.blocked`.
    - **Lưu ý**: AgentHub tuyệt đối không tự ý hoàn tác (`revert`) để tránh rủi ro mất dữ liệu của bạn; người dùng có thể tự kiểm tra và hoàn tác thủ công.

#### 2. Rào chắn lệnh cho Worker (`<hubHome>/shims`)
Khi khởi chạy worker (`agy` hoặc `codex`), AgentHub đưa thư mục `shims` vào đầu biến môi trường `PATH`:
- **Chặn các lệnh mạng và container nguy hiểm**:
  - `ssh`, `scp`, `sftp`, `docker`, `docker-compose`, `podman`: Nếu worker gọi các lệnh này, shim sẽ ngay lập tức từ chối, in thông báo lỗi rõ ràng ra `stderr` và thoát với mã lỗi 1 (`exit 1`).
- **Wrapper an toàn cho `git`**:
  - Chặn lệnh `git push` và `git remote set-url` để ngăn worker vô tình đẩy code chưa qua review lên remote repo hoặc thay đổi cấu hình remote.
  - Mọi lệnh git hợp lệ khác (`git status`, `git commit`, `git log`, `git diff`, `git add`, v.v.) được chuyển tiếp nguyên vẹn tới binary git thật của hệ điều hành (bỏ qua thư mục shims trong `PATH`).

> [!WARNING]
> **Hàng rào chống nhầm lẫn, không phải Sandbox an ninh tuyệt đối**:
> Cơ chế shim hoạt động dựa trên độ ưu tiên tìm kiếm lệnh trong biến môi trường `PATH`. Shim chỉ chặn được các lệnh được worker gọi theo tên (ví dụ: `git push` hoặc `docker run`). Nếu một worker độc hại hoặc vô tình gọi bằng đường dẫn tuyệt đối (ví dụ: `/usr/bin/ssh` hoặc `/usr/bin/git`), lệnh đó vẫn có thể được thực thi. Đây là hàng rào bảo vệ (guardrail) nhằm ngăn chặn các sơ suất phổ biến của mô hình AI, không phải là một giải pháp sandbox bảo mật cô lập hoàn toàn.

#### 3. Cấu hình Codex Sandbox (`workers.codexSandbox`)
Đối với engine OpenAI Codex, bạn có thể cấu hình chế độ sandbox trong file `~/.agenthub/config.json`:
```json
{
  "workers": {
    "codexSandbox": "workspace-write"
  }
}
```
- `off` (mặc định): Chạy Codex với cờ `--dangerously-bypass-approvals-and-sandbox` như trước đây.
- `workspace-write`: Chạy Codex với cờ `--sandbox workspace-write`, tận dụng cơ chế cô lập của chính CLI `codex` để chỉ cho phép quyền ghi trong thư mục worktree hiện tại của task.

### Mẹo hoặc lỗi thường gặp
- **Task bị chuyển sang trạng thái `blocked` với lý do tham chiếu bị sửa**: Kiểm tra nội dung file `.agenthub/BLOCKED` trong worktree của task để biết chính xác tham chiếu và file nào đã bị tác động. Sau khi hoàn tác sửa đổi trong thư mục tham chiếu, bạn có thể bấm **Retry** task trên Web Dashboard hoặc gửi `/retry <id>` qua Telegram.
- **Biến môi trường `AGENTHUB_REF_<NAME>`**: Tên biến được chuẩn hóa thành chữ hoa và thay thế các ký tự không phải chữ cái/chữ số thành dấu gạch dưới `_`. Ví dụ tham chiếu có tên `core-api/v1` sẽ có biến tương ứng là `AGENTHUB_REF_CORE_API_V1`.
