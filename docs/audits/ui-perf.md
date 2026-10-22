# Audit hiệu năng UI

Ngày đo: 2026-10-22, Node 22, `npm run build:web`.

## Bundle trước và sau

Build trước thay đổi có entry `index-BnGZiNJJ.js` 362.83 kB (gzip 111.79 kB). Build sau có entry `index-DovcoTFp.js` 320.94 kB (gzip 102.53 kB), giảm 41.89 kB raw và 9.26 kB gzip (11.5% và 8.3%).

Các chunk lớn sau build:

| Chunk | Raw | Gzip |
| --- | ---: | ---: |
| `index-DovcoTFp.js` | 320.94 kB | 102.53 kB |
| `vendor-xterm-DgJRGhIz.js` | 284.43 kB | 70.65 kB |
| `vendor-markdown-BRbMuXP-.js` | 128.41 kB | 40.09 kB |
| `TaskDag-BmJWM600.js` | 105.73 kB | 36.92 kB |
| `ChatPage-6k-AtM_W.js` | 96.16 kB | 26.46 kB |
| `TaskDetailPage-DKubslvU.js` | 43.43 kB | 9.01 kB |
| `DashboardPage-Domb5-bx.js` | 40.39 kB | 9.62 kB |
| `ProfilesPage-DtleV7vM.js` | 33.53 kB | 9.07 kB |
| `SettingsPage-CRV0p-3l.js` | 32.10 kB | 7.07 kB |
| `ProjectsPage-B6wBzdpV.js` | 30.42 kB | 6.49 kB |
| `PlansPage-FFCRZtbm.js` | 29.15 kB | 6.54 kB |
| `QuotaUsage-CjTyOy3X.js` | 16.77 kB | 3.50 kB |
| `SavingsPage-BAsSh-WL.js` | 15.53 kB | 3.87 kB |
| `TasksPage-BOKiusUY.js` | 13.42 kB | 3.85 kB |
| `SetupPage-B7DuA3S9.js` | 9.86 kB | 3.15 kB |
| `CreateTaskPage-BQmzeeXi.js` | 9.49 kB | 2.41 kB |
| `LoginTerminal-2VUjrjoR.js` | 9.29 kB | 3.37 kB |
| `ClaudeSessionsPage-DSUx5zty.js` | 5.89 kB | 2.03 kB |

Các chunk còn lại đều là shared UI/icon/helper chunk dưới 3.3 kB raw; CSS entry là 88.87 kB (gzip 14.21 kB), `index.html` là 1.64 kB (gzip 0.73 kB). Hash tên chunk thay đổi giữa các build và không mang ý nghĩa cố định.

## Đã sửa

- Lazy-load `SavingsPage`, `ClaudeSessionsPage` và `SetupPage` tại route, giảm code đồng bộ trong entry.
- Lazy-load `LoginTerminal` trong Profiles; xterm chỉ được tải khi mở terminal đăng nhập. Vendor xterm vẫn được tách riêng.
- Giảm polling mã ghép Telegram từ 1 giây xuống 5 giây; nút tạo mã mới vẫn cập nhật cache ngay lập tức.
- Memo hóa `MessageItem` của chat và `KanbanColumn`; memo hóa kết quả nhóm task để các danh sách dài không render lại không cần thiết.
- Giữ virtualized message list và giới hạn số task hiển thị sẵn có hiện tại; không thay đổi hành vi hiển thị.

## Rà soát và việc để lại

- SSE đã có backoff tăng dần 1–30 giây và đóng kết nối khi unmount; giữ nguyên.
- Các query polling 4–10 giây ở dashboard/task/profile được giữ vì đang phục vụ trạng thái trực tiếp; SSE đã invalidate cache theo sự kiện.
- Markdown, xterm và DAG đã được tách vendor/chunk. DAG/markdown vẫn là dependency của các route dùng chúng; chưa thêm virtualization cho Kanban vì UI đã giới hạn 10/20 item mỗi cột.
- Chưa thay đổi API client để truyền `AbortSignal`; việc này cần rà soát hợp đồng nhiều trang hơn và không thuộc nhóm sửa rủi ro thấp của lượt này.

## Kiểm tra

- `npm run lint`: đạt.
- `npm run typecheck`: đạt.
- `npm run test:web -- --run`: đạt, 44 file test / 290 test.
- `npm run build:web`: đạt, 2473 module transformed.

