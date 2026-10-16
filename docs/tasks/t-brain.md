# Task: t-brain – Hiển thị Claude (bộ não điều phối) trên dashboard (khoảng 30 phút)

Nhánh: `t-brain`. Có 2 task khác đang chạy song song: `t-fix-daemon` (sửa `src/`) và `t-fix-web` (sửa `web/`). Để giảm xung đột:
- **đặt logic trong file mới**: `src/brain.ts`, `web/src/components/BrainCard.tsx`, `web/src/components/ReviewQueue.tsx`;
- ở các file dùng chung (`src/api/server.ts`, `src/mcp/index.ts`, `src/db/index.ts`, `web/src/pages/DashboardPage.tsx`, `web/src/types/api.ts`) chỉ thêm vài dòng nối vào.

Commit nhỏ. Lệnh có thể chạy lâu phải bọc `timeout`. Test chạy bằng `--run`. Khi xong tạo `docs/tasks/t-brain.DONE`.

## Bối cảnh
Người dùng muốn thấy **Claude** trên dashboard. Claude Code là bộ não: lập kế hoạch, viết đề bài, giao việc, review và merge. Hiện dashboard chỉ hiển thị các worker.

## Yêu cầu
1. **Backend (`src/brain.ts`)**
   - Lưu trạng thái của Claude trong bảng mới `brain_status`, chỉ có một dòng: `{activity, detail, taskId?, updatedAt}`. Viết migration mới.
   - `activity` thuộc một trong các giá trị: `planning`, `dispatching`, `reviewing`, `merging`, `deploying`, `waiting`, `idle`, `talking`.
   - API:
     - `GET /api/brain` trả về trạng thái hiện tại, kèm `stale: true` nếu `updatedAt` đã quá 15 phút;
     - `PUT /api/brain`, body `{activity, detail, taskId?}`, validate bằng zod, detail tối đa 300 ký tự;
     - mỗi lần PUT phát sự kiện SSE `brain.status` và ghi vào bảng `events`.
   - Thêm `brain` vào response của `GET /api/status`.
2. **MCP**
   - Thêm tool `hub_brain {activity, detail, taskId?}` để Claude tự cập nhật trạng thái.
   - `hub_review` và `hub_create_task` tự cập nhật trạng thái brain: lần lượt là `reviewing <taskId>` và `dispatching <slug>`.
3. **CLI:** `agenthub brain <activity> "<detail>" [--task id]`, để Claude gọi được từ shell khi chưa có MCP.
4. **Web**
   - **`BrainCard`**, đặt **trên cùng** trang Tổng quan:
     - avatar hoặc icon "Claude" (một hình tròn với chữ C hoặc icon bộ não, màu cam đất `#d97757`), nhãn "Claude · Điều phối viên";
     - activity dịch sang tiếng Việt (Đang lập kế hoạch / Đang giao việc / Đang review / Đang ghép code / Đang triển khai / Đang chờ worker / Rảnh / Đang trao đổi với bạn), cùng `detail`, liên kết tới task nếu có `taskId`, và "cập nhật X phút trước";
     - khi stale: hiển thị mờ, kèm chữ "Claude chưa cập nhật trong 15 phút".
   - **`ReviewQueue`**: danh sách task đang ở trạng thái `review`, ghi chú "chờ Claude review". Task nào trùng `brain.taskId` thì đánh dấu "Claude đang xem".
   - Trong dòng sự kiện, sự kiện `brain.status` và các sự kiện review hoặc done do Claude tạo (`payload.by === 'claude-review'`) hiện với icon Claude.
   - Dùng biến CSS của dark theme hiện có. Không hardcode màu nền.

## Test
- API: PUT với dữ liệu sai trả 400; PUT hợp lệ phát SSE; GET khi đã stale.
- MCP: tool `hub_brain`.
- Web: render `BrainCard` cho từng `activity` và cho trạng thái stale; `ReviewQueue` đánh dấu đúng task.

## Nghiệm thu
`npm run lint && npm run typecheck && npm test -- --run && npm run build && npm run build:web && npm run test:web -- --run` đều đạt.
**Lưu ý:** không được để test ghi vào `dist/web` thật.
