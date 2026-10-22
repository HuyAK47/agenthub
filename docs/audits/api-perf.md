# Audit hiệu năng API

## Phạm vi và route

Đã rà soát các route Fastify trong `src/api/`, `src/brain.ts` và `src/chat/service.ts`.
Các nhóm route gồm: health/version; status/setup; projects, knowledge, notes, deploy; profiles/quota/usage; tasks/graph/logs/checks; batches; config/models; savings và daily usage; Claude sessions/quota/failover; brain; chat sessions/messages/permissions; Telegram; system orphans; SSE `/api/events`; và WebSocket PTY `/api/pty/:sessionId`. Các route ghi dữ liệu chủ yếu là thao tác đơn bản ghi hoặc điều phối worker, không nằm trên đường đọc dashboard hot path.

Hot path được xác định là `/api/status`, `/api/tasks`, `/api/tasks/graph`, `/api/savings`, `/api/usage/daily`, `/api/chat/sessions/:id/messages` và `/api/events`. `/api/events` còn đọc log đồng bộ mỗi giây cho từng run đang chạy; đây là thiết kế polling/throttle hiện tại và cần một bộ đệm log bất đồng bộ nếu tải SSE lớn hơn.

## Đo benchmark

Chạy bằng `node --import tsx scripts/benchmark-api.mjs` với DB tạm, 5.000 task, 50.000 event và 50.000 chat message. Script tự đo cùng một fixture trước và sau khi bật các index mới; mặc định có 25 mẫu/route (lần kiểm tra này dùng 5 mẫu để rút ngắn thời gian).

| Route | Trước p50/p95 (ms) | Sau p50/p95 (ms) |
|---|---:|---:|
| `GET /api/tasks` | 639.81 / 742.46 | 421.55 / 1784.96 |
| `GET /api/tasks?project&status` | 182.67 / 1174.88 | 111.86 / 1013.25 |
| `GET /api/status` | 97.05 / 557.17 | 107.03 / 192.24 |
| `GET /api/savings` | 208.27 / 294.24 | 337.22 / 387.17 |
| `GET /api/usage/daily` | 3.48 / 4.57 | 5.85 / 6.39 |
| `GET /api/chat/sessions/:id/messages` | 10.47 / 12.84 | 1.95 / 2.44 |

Các số đo p95 nhỏ mẫu có nhiễu; không dùng chúng để khẳng định mọi route nhanh hơn. Kết quả đáng tin cậy nhất là truy vấn message giảm rõ rệt và filter task giảm p50. Benchmark chưa gọi SSE vì stream sống lâu; SSE được kiểm tra qua code path và ghi nhận riêng trong phần đề xuất.

## Đã sửa

- Thêm migration index cho filter/sort task, dependency ngược, event theo task, run theo outcome/task, check result và chat message theo session/thời gian.
- `TaskRepo.list()` đẩy filter project/status xuống SQLite thay vì tải toàn bộ task rồi lọc trong JavaScript.
- `AppService.listTasks()` cache project theo id, loại bỏ truy vấn project lặp lại theo từng task.
- `SavingsService.getSavings()` tải runs, metrics và reviews một lần rồi nhóm theo task, loại bỏ N+1 query của endpoint savings.
- Thêm `scripts/benchmark-api.mjs`; script không chạy agy/codex thật và chỉ dùng thư mục tạm.

## Việc để lại / đề xuất

- Danh sách task và graph vẫn trả toàn bộ dữ liệu theo hợp đồng hiện tại; nên bổ sung pagination/cursor trong một thay đổi API-web riêng.
- SSE hiện `statSync`/`openSync`/`readSync` mỗi giây cho từng run; nên chuyển sang watcher hoặc log tail bất đồng bộ khi cần nhiều client.
- Search chat dùng `LIKE '%...%'`, không tận dụng B-tree; nếu search là hot path nên cân nhắc SQLite FTS5.
- Payload task detail/log và export chat có thể lớn; cần giới hạn kích thước hoặc pagination theo hợp đồng web trước khi thay đổi.
