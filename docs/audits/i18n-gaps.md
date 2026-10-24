# Báo cáo Audit Đa Ngôn Ngữ (i18n Gaps) và Khắc Phục

## 1. Phạm vi kiểm tra (Scope & Methodology)

Đã tiến hành rà soát toàn diện hệ thống đa ngôn ngữ (VI và EN) trên toàn bộ ứng dụng web dashboard và giao diện tích hợp:
- **Trang & Thành phần**: Dashboard, Tasks (Kanban & List), Plans (Drafts & Batches), Profiles (Account Management & Login Wizard), Projects (List, Creation & Settings Drawer), Settings (Fallback Chain & Savings Configuration), Chat (Session List, History & Modals), Task Detail (Runs, Checks, Review, Capture), Setup (Environment & MCP Guide), Savings (Worker Tokens & Delegations), Departments.
- **Hộp thoại / Thông báo / Giao diện tương tác**: Modals (Xác nhận xoá, Sửa task, New session, Token login, Login wizard), Toasts, Tooltips, Tour hướng dẫn người dùng, Browser notifications (`notifications.ts`), Relative time & Date formatting (`lib/time.ts`).
- **Thông báo lỗi từ Backend / API**: Thông báo lỗi trả về từ daemon/service bằng tiếng Việt (cả mã lỗi và chuỗi văn bản động).

## 2. Phát hiện & Các điểm đã khắc phục

### 2.1. Dịch thông báo lỗi Backend/API theo Locale của người dùng
- **Tiện ích dịch lỗi API (`web/src/utils/apiError.ts`)**:
  - Hỗ trợ tra cứu theo mã lỗi chuẩn (`cycle_detected`, `conflict`, `not_found`, `forbidden`, `unauthorized`, `rate_limited`, `confirmation_required`, `invalid_logo`, `provider_policy`, v.v.).
  - Xây dựng từ điển ánh xạ Regex cho hơn 50 mẫu lỗi tiếng Việt do backend sinh ra (`Task "..." không tồn tại`, `Không thể xóa hồ sơ "..." đang chạy task`, `Nhánh mặc định "..." không tồn tại`, `Đường dẫn repo phải là đường dẫn tuyệt đối`, `Thư mục không phải là git repository`, v.v.) sang tiếng Anh tương ứng với nội suy tham số động chính xác.
- **Tích hợp phía Client (`web/src/api/client.ts`)**:
  - Bổ sung header `Accept-Language: activeLocale` vào mọi request qua `apiFetch`.
  - Bắt lỗi HTTP và giải mã payload lỗi (`error` và `message`), tự động dịch sang ngôn ngữ đang hoạt động thông qua `translateApiErrorMessage`, đồng thời đính kèm `code` và `rawMessage` để giữ đầy đủ ngữ cảnh kỹ thuật.
  - Xử lý tương tự cho lỗi export session trong `web/src/api/chat.ts`.

### 2.2. Khắc phục chuỗi hiển thị hard-coded & Khóa thiếu
- **ProfilesPage (`web/src/pages/ProfilesPage.tsx`)**:
  - Bản dịch và nút kiểm tra profile SSE (`profiles.checkSuccess`, `profiles.checkFailed`, `profiles.openLoginFailed`).
  - Hỗ trợ nhận diện thông báo import token cả tiếng Việt và tiếng Anh (`Cho phép nhiều tài khoản` / `Allow multiple accounts`).
  - Localized nhãn Email, Refresh token (`profiles.email`, `profiles.refreshToken`).
  - Hộp thoại xoá hồ sơ: hướng dẫn nhập xác nhận (`profiles.confirmDeletePrompt`), checkbox dọn dữ liệu (`profiles.deletePurgeData`), nút huỷ và xoá (`common.cancel`, `profiles.deleteProfile`).
  - Hướng dẫn đăng nhập (`LoginWizard`): tiêu đề theo nhà cung cấp (`profiles.loginGuideTitle`) và 4 bước (`stepGoogleOAuth`, `stepDeviceAuth`, `stepSendLogin`, `stepOpenLink`, `stepCopyCode`, `stepPasteCode`).
- **DashboardPage (`web/src/pages/DashboardPage.tsx`)**:
  - Thẻ hiệu năng: `dashboard.perfTitle`, `dashboard.perfSubtitle`, `dashboard.perfNoSamples`, `dashboard.perfChartLabel`.
  - Thẻ đĩa cứng: `dashboard.diskSpaceSummary` ({free} / {total} GB trống · ngưỡng {threshold} GB).
  - Tóm tắt worktree & chế độ brain: `dashboard.worktreesCount`, `dashboard.brainSessionMode`.
  - Thẻ Quota: `dashboard.quotaTitle`, `dashboard.profilesCount`, `dashboard.tokensToday`.
  - Khối Claude Failover: `dashboard.failoverOn`, `dashboard.failoverOff`, `dashboard.failoverUsing`, `dashboard.failoverUsingProfile`, `dashboard.failoverUsingApiKey`, `dashboard.failoverWaitingReset`, `dashboard.failoverReason`, `dashboard.failoverEvidence`, `dashboard.failoverTurningOff`, `dashboard.failoverTurnOff`.
  - Bảng tiến trình mồ côi: dịch tiêu đề bảng (PID, Command, Memory, Elapsed, Project, Actions).
  - Định dạng thời gian tương đối trong luồng sự kiện theo locale hoạt động.
- **SavingsPage (`web/src/pages/SavingsPage.tsx`)**:
  - Số lượng task: `savings.taskCount` ({count} task / {count} tasks).
  - Tiêu đề bảng: `extra.task`, `extra.model`, `savings.workerTokens`.
- **ProjectsPage & Settings Drawer (`web/src/pages/ProjectsPage.tsx`, `web/src/components/ProjectSettingsDrawer.tsx`)**:
  - Nhãn nút tab kiến thức: `projects.knowledge`.
  - Đơn vị lượt chạy: `projects.unitTurns`.
  - Đề xuất autocheck: tiêu đề và mô tả task tự động tạo (`projects.suggestChecksTaskTitle`, `projects.suggestChecksTaskBody`).
  - Xử lý match lỗi lưu settings cho cả tiếng Anh và tiếng Việt (`branch`/`nhánh`, `duplicate`/`trùng`, `permission`/`quyền`).
- **TaskDetailPage (`web/src/pages/TaskDetailPage.tsx`)**:
  - Tiêu đề capture lỗi từ check: fallback `common.error`.
  - Nhãn `taskDetail.reviewChain`.
  - Trạng thái chưa cấu hình merge: `taskDetail.mergeNotConfigured`, `taskDetail.mergeEnableHint`.
  - Nhãn slug modal capture: `createTask.slug`.
- **SettingsPage (`web/src/pages/SettingsPage.tsx`)**:
  - Bản dịch các tùy chọn trong fallback chain select dropdown (`extra.fallbackProfile`, `extra.fallbackModel`, `extra.fallbackApiKey`, `extra.fallbackEngine`, `extra.fallbackWait`).
- **ProjectWizard (`web/src/components/ProjectWizard.tsx`, `web/src/components/wizard/StepContext.tsx`)**:
  - Thông báo tóm tắt thất bại: `projects.wizardSummaryFailed`.
  - Nhãn checkbox context: `projects.wizardSelectContextItem`.
- **Chat (`web/src/components/chat/MessageItem.tsx`, `SessionList.tsx`, `NewSessionModal.tsx`)**:
  - Nhãn profile Claude: `extra.claudeProfile`.
  - Nút thử lại tin nhắn: `extra.retry`.
  - Trạng thái rỗng: `extra.noMatchingChats`, `extra.noArchivedChats`.
  - Lỗi xuất Markdown: `extra.exportMarkdownError`.
  - Thời gian tin nhắn tương đối: truyền `locale` vào `formatRelativeTime`.
- **Components chung**:
  - `CollapsibleList.tsx`: dùng `common.showMoreCount`, `common.collapse`.
  - `Modal.tsx`: dùng `common.dialog` cho fallback `aria-label`.

### 2.3. Định dạng Ngày/Giờ/Số và Thông báo Trình duyệt
- **Thời gian tương đối (`web/src/lib/time.ts`)**:
  - Nâng cấp `formatTimeAgo` nhận tham số `locale: TimeLocale = 'vi'`. Khi `locale === 'en'`, xuất chuỗi ngắn gọn chuẩn (`15s ago`, `2m ago`, `3h ago`, `4d ago`), đồng thời giữ nguyên định dạng tiếng Việt khi `locale === 'vi'`.
  - Hàm `parseApiTime` được bổ sung kiểm tra phòng vệ, trả về `NaN` an toàn khi gặp chuỗi thời gian không hợp lệ để các component xử lý fallback đúng quy định.
- **Thông báo trình duyệt (`web/src/notifications.ts`)**:
  - Hàm `browserNotificationBody` nhận tham số `locale: 'vi' | 'en' = 'vi'`.
  - Dịch toàn bộ thông báo sự kiện (task hoàn thành, task chờ duyệt, sự cố, yêu cầu duyệt, cảnh báo đĩa cứng, quota cạn, failover Claude, xác thực lại hồ sơ, trạng thái CI) sang tiếng Anh và tiếng Việt tương ứng.

### 2.4. Đồng bộ Khóa và Tham số Nội suy (Parity)
- Tất cả các khóa mới bổ sung đều được khai báo đồng thời ở cả `web/src/locales/vi.ts` và `web/src/locales/en.ts`.
- 100% tham số nội suy `{param}` giữa `vi` và `en` hoàn toàn trùng khớp.

## 3. Kết quả Kiểm thử Tự động (Automated Test Verification)

Mở rộng bộ test `web/src/test/i18nAudit.test.tsx` (tổng cộng 21 test case, toàn bộ passed):
1. **Key Parity**: Xác thực tập khóa của `vi` và `en` giống nhau 100% (0 khóa thiếu).
2. **Placeholder Parity**: Xác thực mọi token placeholder `{token}` giữa `vi` và `en` trùng khớp tuyệt đối.
3. **Source Code Scanner**: Quét toàn bộ mã nguồn `web/src` (ngoại trừ từ điển `locales/vi.ts`, từ điển lỗi `apiError.ts`, mocks và test files), đảm bảo không còn chuỗi tiếng Việt hard-code nào trong JSX hay mã giao diện.
4. **Multi-page Render Tests**: Render 12 trang và ngữ cảnh trong chế độ tiếng Anh (`locale="en"`), xác nhận hoàn toàn không chứa ký tự tiếng Việt có dấu:
   - ProfilesPage
   - TaskDetailPage
   - TasksPage
   - ProjectsPage
   - CreateTaskPage
   - SettingsPage
   - ChatPage
   - PlansPage (danh sách)
   - PlansPage (với batch hoạt động)
   - DashboardPage
   - SavingsPage
   - SetupPage
5. **Backend Error Translation Tests**: Kiểm tra dịch chính xác thông báo lỗi cố định, thông báo lỗi có tham số động, và mã lỗi chuẩn.
6. **Time & Relative Format Tests**: Kiểm tra `formatTimeAgo` hoạt động đúng cho cả hai locale `vi` và `en`.
7. **Browser Notification Tests**: Kiểm tra `browserNotificationBody` tạo đúng nội dung thông báo cho cả hai locale.

### Kết quả chạy lệnh kiểm tra:
- `npm run lint`: **PASS** (0 lỗi)
- `npm run typecheck`: **PASS** (0 lỗi)
- `npm run test:web`: **PASS** (52/52 test files, 364/364 tests passed)
- `npm run build:web`: **PASS** (Biên dịch TypeScript và Vite hoàn tất sạch sẽ)
- Backend tests: Toàn bộ các test suite backend hoàn thành không có lỗi assertion.

## 4. Khoảng trống còn lại & Lưu ý kiến trúc (Remaining Considerations)

1. **Dữ liệu do người dùng tạo (User-generated Content)**: Tiêu đề task, nội dung prompt, tên nhánh git, mô tả commit do người dùng nhập hoặc do AI sinh ra được hiển thị nguyên bản theo ngôn ngữ gốc.
2. **Định danh kỹ thuật (Technical Identifiers)**: Tên mô hình AI (`sonnet`, `gemini-3.8-flash`), tên engine (`agy`, `codex`, `claude`), mã exit code, cờ lệnh terminal được giữ nguyên bản ngữ cảnh kỹ thuật.
3. **Mã lỗi Backend mở rộng trong tương lai**: Khi bổ sung các service backend mới trả về lỗi dạng chuỗi tự do, nên bổ sung mã lỗi chuẩn (`code`) trong payload JSON để tiện cho việc ánh xạ dịch tự động ở phía client.
