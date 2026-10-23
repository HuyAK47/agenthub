# Báo Cáo Rà Soát Trải Nghiệm Người Dùng (UX & Accessibility Audit)

**Thời gian thực hiện**: Tháng 10/2026  
**Phạm vi**: Ứng dụng web AgentHub (`web/src`)  
**Người thực hiện**: Antigravity Worker (theo nhiệm vụ `agenthub/a-ux-audit`)

---

## 1. Mục Tiêu & Phạm Vi Rà Soát

Đợt rà soát tập trung vào việc đánh giá toàn diện trải nghiệm người dùng (UX) và khả năng truy cập (a11y) trên giao diện web của AgentHub theo các tiêu chuẩn:
- **Trạng thái màn hình**: Tải dữ liệu (loading/spinner), trạng thái rỗng (empty state), trạng thái lỗi (error handling) có thông báo thân thiện và cơ chế thử lại (retry).
- **An toàn thao tác**: Xác nhận trước các hành động phá hủy hoặc không thể hoàn tác (xóa worktree, xóa project, hủy task, gỡ khóa quota).
- **Khả năng tiếp cận (Accessibility)**: Nhãn trợ năng (`aria-label`, `title`) cho nút bấm chỉ có icon, độ tương phản màu sắc, kích thước vùng bấm, hỗ trợ điều hướng bàn phím.
- **Quốc tế hóa (i18n)**: Đảm bảo hiển thị đầy đủ, chính xác, không sót chuỗi bản địa hóa (hardcoded strings) giữa tiếng Việt (`vi`) và tiếng Anh (`en`).

### Các Luồng Người Dùng Chính Đã Kiểm Tra:
1. **Thiết lập môi trường lần đầu (`SetupPage`)**: Kiểm tra Node, Git, các CLI engine (`claude`, `codex`, `agy`), MCP config, và dự án đầu tiên.
2. **Quản lý dự án (`ProjectsPage`)**: Đăng ký dự án, cấu hình nhánh, ngân sách token, ghi chú kiến thức (knowledge notes), checks & hooks.
3. **Quản lý Task & Đợt kế hoạch (`TasksPage`, `CreateTaskPage`, `PlansPage`)**: Tạo task lẻ, phụ thuộc DAG, phân bổ batch, theo dõi tiến độ tổng thể.
4. **Chi tiết Task & Quy trình Review (`TaskDetailPage`, `ReviewQueue`)**: Kiểm tra diff, log stream, duyệt hoặc yêu cầu sửa (changes requested), quản lý worktree git.
5. **Chat với Bộ não & Điều phối viên (`ChatPage`, `BrainCard`)**: Trò chuyện theo ngữ cảnh dự án, hiển thị công cụ (tool calls), trạng thái điều phối viên.
6. **Quản lý Tài khoản & Hồ sơ (`ProfilesPage`)**: Quản lý tài khoản agy/codex/claude, giám sát hạn mức quota 5 giờ, phiên bị giới hạn.
7. **Cài đặt & Tích hợp (`SettingsPage`, `TelegramCard`)**: Cấu hình thông báo Telegram, giờ yên lặng, ghép mã chat bot.

---

## 2. Bảng Tổng Hợp Phát Hiện Theo Mức Độ Nghiêm Trọng

| STT | Luồng / Vị Trí | Vấn Đề Phát Hiện | Mức Độ | Trạng Thái Trong Đợt Này |
|:---|:---|:---|:---:|:---:|
| 1 | `TaskDetailPage` | Xóa worktree git bằng 1 cú click, không có hộp thoại xác nhận | **Cao (High)** | **Đã sửa & có test** |
| 2 | `SetupPage` | Khi API kiểm tra môi trường lỗi mạng, trang bị treo spinner vĩnh viễn | **Trung bình (Medium)** | **Đã sửa & có test** |
| 3 | `ProjectsPage` | Lỗi tải danh sách dự án không có nút "Thử lại" | **Trung bình (Medium)** | **Đã sửa & có test** |
| 4 | `ProfilesPage` | Lỗi tải danh sách hồ sơ không có nút "Thử lại" | **Trung bình (Medium)** | **Đã sửa & có test** |
| 5 | Các trang điều hướng | Nút quay lại (`ArrowLeft`) trên Task Detail và Create Task thiếu `aria-label` | **Trung bình (Medium)** | **Đã sửa & có test** |
| 6 | `ProjectsPage` | Các nút icon (xóa project, xóa reference, ghim/xóa knowledge note) thiếu `aria-label` | **Trung bình (Medium)** | **Đã sửa** |
| 7 | `ChatPage` | Nút tạo phiên chat mới trên thanh tiêu đề thiếu `aria-label` | **Trung bình (Medium)** | **Đã sửa** |
| 8 | `CollapsibleList` & `TasksPage` | Nút phân trang `"Xem thêm ... (còn ...)"` và `"Thu gọn"` bị hardcode tiếng Việt | **Thấp (Low)** | **Đã sửa** |
| 9 | `BrainCard` | Nhãn trạng thái hoạt động của bộ não bị hardcode tiếng Việt | **Thấp (Low)** | **Đã sửa** |
| 10 | `Layout` | Mục sidebar Task bị hardcode chuỗi `'Task'` thay vì dùng khóa đa ngôn ngữ | **Thấp (Low)** | **Đã sửa** |
| 11 | `ProjectsPage` | Các nút và placeholder trong thẻ Knowledge Notes chưa được dịch sang tiếng Anh | **Thấp (Low)** | **Đã sửa** |
| 12 | Hệ thống Toast toàn cục | Một số hành động dùng `window.confirm`/alert, một số dùng query invalidate âm thầm | **Thấp (Low)** | *Để lại đề xuất* |
| 13 | Bàn phím nâng cao | Thiếu phím tắt truy cập nhanh (như `J`/`K` di chuyển task, `/` tìm kiếm) | **Thấp (Low)** | *Để lại đề xuất* |

---

## 3. Chi Tiết Các Lỗi Đã Khắc Phục Trong Đợt Này

### 3.1. An toàn dữ liệu & Thao tác nguy hiểm
- **Bảo vệ xóa worktree (`TaskDetailPage.tsx`)**:
  - *Vấn đề*: Worktree chứa mã nguồn và file untracked của lập trình viên hoặc worker. Trước đây nút "Xóa worktree" gọi trực tiếp mutation xóa ngay khi click.
  - *Giải pháp*: Bọc thao tác qua `window.confirm(t('taskDetail.confirmDeleteWorktree'))`. Nếu người dùng hủy, không có request nào được gửi.
  - *Test*: Đã bổ sung ca kiểm thử `17. Nút Xóa worktree yêu cầu xác nhận window.confirm trước khi gọi deleteWorktree`.

### 3.2. Cơ chế phục hồi khi gặp lỗi (Error Recovery & Retry)
- **Thiết lập môi trường (`SetupPage.tsx`)**:
  - *Vấn đề*: Khi `getSetupStatus` gặp lỗi mạng hoặc backend chưa sẵn sàng, trang rơi vào trạng thái chờ vô hạn với spinner.
  - *Giải pháp*: Bắt `isError || !data`, hiển thị icon cảnh báo, thông điệp lỗi rõ ràng và nút "Thử lại" gọi `refetch()`.
  - *Test*: Đã bổ sung ca kiểm thử `11. Trạng thái lỗi hiển thị thông báo và nút thử lại gọi refetch`.
- **Danh sách dự án (`ProjectsPage.tsx`)**:
  - *Vấn đề*: Lỗi tải dự án chỉ hiển thị một dòng thông báo nhỏ, người dùng phải F5 lại cả trang.
  - *Giải pháp*: Thêm nút "Thử lại" để làm mới bộ nhớ đệm `queryClient.invalidateQueries({ queryKey: ['projects'] })`.
  - *Test*: Đã bổ sung ca kiểm thử `14. Lỗi tải danh sách project hiển thị thông báo và nút thử lại`.
- **Hồ sơ tài khoản (`ProfilesPage.tsx`)**:
  - *Vấn đề*: Khi tải danh sách profiles thất bại, giao diện báo lỗi nhưng không cung cấp nút thao tác thử lại.
  - *Giải pháp*: Bổ sung nút "Thử lại" gọi trực tiếp `refetch()`.
  - *Test*: Đã bổ sung ca kiểm thử `14. displays error message and retry button when profiles fail to load`.

### 3.3. Khả năng truy cập (Accessibility & Screen Readers)
- **Nút điều hướng Back**:
  - Thêm `aria-label={t('common.back')}` và `title` trên cả `TaskDetailPage.tsx` và `CreateTaskPage.tsx`.
- **Các nút Icon trong `ProjectsPage.tsx`**:
  - Thêm `aria-label={t('projects.deleteProject')}` cho nút xóa dự án.
  - Thêm `aria-label={t('projects.removeReference')}` cho nút xóa reference file.
  - Thêm `aria-label={t('projects.pinKnowledge')}` / `unpinKnowledge` và `deleteKnowledge` cho các thẻ ghi chú kiến thức dự án.
- **Header Chat (`ChatPage.tsx`)**:
  - Thêm `aria-label={t('chat.newConversation')}` và `title` trên nút icon `Plus` mở hội thoại mới.

### 3.4. Quốc tế hóa & Tính nhất quán ngôn ngữ (i18n)
- Chuyển toàn bộ các chuỗi hardcode sang từ điển `vi.ts` và `en.ts`:
  - `common.back`, `common.showMoreRemaining`, `common.collapseBtn`.
  - `brainStateWaitingUser`, `brainStateWorking`, `brainStateInactive`.
  - `projects.knowledge`, `projects.addKnowledgePlaceholder`, `projects.addKnowledgeBtn`, `projects.deployingBtn`, `projects.redeployBtn`, `projects.deleteProject`, v.v.
  - Đồng bộ `Layout.tsx` với khóa `common.tasks`.
  - Toàn bộ 10 test kiểm toán ngữ nghĩa bản địa hóa trong `i18nAudit.test.tsx` đều đạt kết quả 100% đồng nhất giữa `vi` và `en`.

---

## 4. Các Vấn Đề Để Lại & Đề Xuất Cải Tiến Tương Lai

1. **Hệ thống Toast Notification tập trung**:
   - *Hiện trạng*: Một số hành động (như lưu cài đặt project, sao chép mã ghép đôi Telegram) chưa có phản hồi nổi (toast) rõ rệt mà chỉ đổi nhãn nút tạm thời.
   - *Đề xuất*: Xây dựng một context `ToastProvider` toàn cục (hoặc dùng thư viện nhẹ như `sonner`) để thông báo kết quả lưu thành công ở góc màn hình.
2. **Skeleton Screens cho tải ban đầu**:
   - *Hiện trạng*: Nhiều trang lớn đang sử dụng vòng xoay spinner (`animate-spin`) chiếm cả khối màn hình.
   - *Đề xuất*: Thay thế bằng các thẻ Skeleton mô phỏng hình dạng card/bảng thực tế để giảm độ giật hình ảnh khi dữ liệu tải xong (CLS - Cumulative Layout Shift).
3. **Phím tắt điều hướng nhanh (Keyboard Shortcuts)**:
   - *Đề xuất*: Bổ sung phím tắt toàn cục:
     - `?`: Mở bảng tra cứu phím tắt.
     - `g + d`: Về Dashboard.
     - `g + t`: Sang trang Tasks.
     - `c`: Mở form tạo task nhanh.
4. **Modal diff responsive trên di động**:
   - *Hiện trạng*: Trên màn hình điện thoại (<640px), bảng hiển thị diff git hai cột trong chi tiết task bị thu hẹp đáng kể.
   - *Đề xuất*: Cho phép chuyển đổi chế độ xem diff hợp nhất 1 cột (Unified diff view) trên thiết bị di động.

---

## 5. Kết Quả Kiểm Thử & Xác Minh Kỹ Thuật

- **Linter**: `npm run lint` — Hoàn toàn sạch, không có cảnh báo nào.
- **Typecheck**: `npm run typecheck` — 0 lỗi TypeScript trên cả server và web.
- **Kiểm thử Web (Vitest)**: `npm run test:web` — **50/50 test files pass, 353/353 tests pass**.
- **Đóng gói sản phẩm (Build Web)**: `npm run build:web` — Build production hoàn tất thành công trong 6.45 giây (built in 6.45s).
