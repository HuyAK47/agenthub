# Quyết định kiến trúc (Decisions Log)

## DEC-003: Watchdog dùng đa nguồn hoạt động của worker

- **Bối cảnh**: `agy -p` có thể không ghi stdout trong khi agent vẫn đang gọi công cụ. Chỉ dùng mtime log khiến watchdog kill nhầm worker Gemini.
- **Quyết định**: Mốc hoạt động là mtime mới nhất của log, conversation DB đúng HOME/profile hoặc worktree (tối đa 5000 mục, bỏ qua `node_modules`, `.git/objects`, `dist`). Conversation chỉ xét file thay đổi sau khi run bắt đầu; profile keyring dùng HOME thật. Với trạng thái `waiting up to`, chỉ coi là kẹt khi log và conversation cùng im lặng quá `waitingMinutes`.
- **Ngưỡng mặc định**: `stallMinutes = 20`, `waitingMinutes = 15`, để đủ thời gian cho các lượt gọi tool dài của agy mà vẫn phát hiện worker thực sự không còn hoạt động.
- **Giới hạn**: Khi một profile chạy hai slot đồng thời, run chưa lưu conversation id nên dùng file conversation mới nhất của profile, có thể đánh dấu hoạt động của slot còn lại.
- **Hiệu năng**: Sau mỗi lần đo, conversation/worktree được cache tối đa 30 giây trên từng run; mỗi lần quét ưu tiên log, conversation và `.git/index`, chỉ đệ quy worktree khi cần và dừng sớm khi gặp mtime mới hơn cache.

## DEC-004: Cảnh báo rủi ro hardlink trong cache node_modules

- **Bối cảnh**: Worktree dùng hardlink tới cache để tiết kiệm ổ đĩa. Worker sửa trực tiếp một file trong `node_modules` sẽ sửa luôn inode trong cache và ảnh hưởng các worktree khác.
- **Quyết định**: Chỉ dùng cache cho dependency đã chuẩn bị; khi lockfile đổi hoặc kiểm tra native thất bại thì cài riêng trong worktree. Lệnh `agenthub clean --dedupe --verify` (hoặc một bước verify tương đương trong tương lai) cần được dùng để phát hiện cache bị thay đổi và cảnh báo trước khi tái sử dụng.
- **Hệ quả**: Hardlink không bảo vệ cache khỏi thao tác ghi của worker; việc kiểm tra integrity/verify là trách nhiệm của quy trình dọn dẹp và chuẩn bị dependency.

## DEC-001: Bổ sung endpoint GET/PUT /api/config cho cấu hình hệ thống và chuỗi model mặc định

- **Bối cảnh**: Theo đề bài `docs/tasks/a2-web.md` (mục 4 - Cài đặt) và `docs/PLAN.md` (mục 3.5, 3.9), trang Cài đặt trên Web dashboard cần xem và chỉnh sửa chuỗi model mặc định (hard / easy) và cấu hình liên quan (như timeout). Hợp đồng API ban đầu tại mục 3.7 chưa có endpoint cấu hình.
- **Quyết định**: Bổ sung endpoint vào API contract cho task `a1-api-mcp` và `a2-web`:
  - `GET /api/config`: Trả về cấu hình hiện tại từ `~/.agenthub/config.json`:
    ```json
    {
      "modelChains": {
        "hard": ["claude-opus-4-6-thinking", "codex:gpt-5.6-luna", "gemini-3.8-flash-high"],
        "easy": ["gemini-3.8-flash-medium", "codex:gpt-5.6-luna"]
      },
      "runTimeoutHours": 3
    }
    ```
  - `PUT /api/config`: Cập nhật cấu hình và lưu vào `config.json`. Payload có cùng cấu trúc với `GET /api/config`.
- **Hệ quả**: Backend `a1-api-mcp` sẽ triển khai 2 endpoint này tương thích với schema trên. Frontend `a2-web` dùng endpoint này cho trang Cài đặt và mock tương ứng trong MSW.

## DEC-002: Nâng cấp ThemeContext sang 3 chế độ (dark, light, system) và try/catch localStorage

- **Bối cảnh**: Theo đề bài `docs/tasks/t-ui-dark.md`, người dùng yêu cầu mặc định dark theme, lựa chọn theme lưu trong `localStorage` (bọc try/catch), và công tắc trên header có 3 chế độ: Tối / Sáng / Theo hệ thống. Lần đầu mở thì dùng Tối.
- **Quyết định**: Nâng cấp `web/src/context/ThemeContext.tsx` và `web/src/components/Layout.tsx`:
  - `ThemeMode` hỗ trợ: `'dark' | 'light' | 'system'`.
  - Mặc định khi chưa có dữ liệu lưu trữ là `'dark'`.
  - Mọi thao tác đọc/ghi `localStorage` được bọc try/catch an toàn.
  - Chế độ `'system'` tự động lắng nghe sự kiện `matchMedia('(prefers-color-scheme: dark)')` để chuyển đổi giao diện động.
  - Công tắc trên header và menu mobile hiển thị 3 tùy chọn (Tối / Sáng / Hệ thống).
- **Hệ quả**: Giao diện khởi động mặc định ở dark theme không bị nháy sáng, an toàn trong mọi môi trường trình duyệt.

## DEC-005: Dùng dagre cho bố cục đồ thị tự động trong TaskDag (c-dag-view)

- **Bối cảnh**: Theo đề bài `c-dag-view`, component `TaskDag` cần vẽ sơ đồ quan hệ phụ thuộc giữa các task dạng đồ thị có hướng (DAG), bố cục tự động từ trái sang phải (`LR`), hỗ trợ zoom/kéo và hiển thị đường găng. Đề bài cho phép chọn giữa `dagre` hoặc `elkjs` và yêu cầu ghi lý do vào tài liệu nếu thêm thư viện.
- **Quyết định**: Bổ sung thư viện `dagre` (và `@types/dagre` trong `devDependencies`) vào `web/package.json`.
- **Lý do chọn dagre thay vì elkjs**:
  1. `dagre` là thư viện JavaScript thuần, nhẹ (~300KB), chạy đồng bộ và tương thích tốt với Vite/React mà không cần cấu hình thêm Web Worker hoặc nạp file nhị phân WASM như `elkjs`.
  2. Hỗ trợ thuật toán Sugiyama chuẩn cho đồ thị có hướng (DAG), hỗ trợ tùy chọn `rankdir: 'LR'` hoàn hảo cho sơ đồ luồng tiến trình từ trái sang phải.
  3. Cung cấp tọa độ tâm `(x, y)` cho từng nút và các điểm bẻ góc `points` cho từng cạnh, giúp render SVG vector sắc nét, dễ dàng điều khiển pan/zoom và tùy biến CSS.
- **Hệ quả**: Bổ sung `dagre` vào dependencies của ứng dụng web, đảm bảo render sơ đồ DAG nhanh chóng, mượt mà và không phát sinh lỗi nạp async trong môi trường kiểm thử Vitest/jsdom.


