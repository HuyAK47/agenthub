import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getConfig, getSetupStatus, updateConfig } from '../../api/client';

export type TourStep = {
  id: string;
  route?: string;
  selector: string;
  title: string;
  content: string;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  /** Short hint shown when a target is temporarily unavailable. */
  note?: string;
};

export type TourDefinition = { id: string; steps: TourStep[] };

type TourContextValue = {
  active: TourDefinition | null;
  stepIndex: number;
  openTour: (id: string) => void;
  closeTour: (completed?: boolean) => void;
  next: () => void;
  previous: () => void;
  getPageTour: (pathname: string) => TourDefinition | null;
  suggestModalTour: (id: string) => void;
};

const fallbackKey = 'agenthub_tours_seen';

export const tourDefinitions: TourDefinition[] = [
  { id: 'intro', steps: [
    { id: 'overview', route: '/', selector: '[data-tour="overview"]', title: 'Tổng quan', content: 'Đây là trang nhìn nhanh sức khỏe AgentHub. Dùng khi cần biết worker, quota và tài nguyên máy trước khi giao việc. Bấm thẻ để mở phần chi tiết; số quota là phần còn lại đến giờ reset.', placement: 'bottom' },
    { id: 'connection', route: '/', selector: '[data-tour="connection-status"]', title: 'Kết nối', content: 'Đây là trạng thái kết nối thời gian thực với hub. Dùng để biết dữ liệu có đang cập nhật không. Khi mất kết nối, thao tác mới có thể chờ gửi lại; hãy kiểm tra hub trước khi bấm lại.', placement: 'bottom' },
    { id: 'resources', route: '/', selector: '[data-tour="resource-status"]', title: 'Tải máy và ổ đĩa', content: 'Đây là tải CPU, bộ nhớ và dung lượng trống. Dùng để tránh chạy quá nhiều worker trên máy yếu. Khi cảnh báo đỏ, task mới có thể bị giảm tốc hoặc chặn; dọn ổ đĩa trước khi tăng song song.', placement: 'bottom' },
    { id: 'brain', route: '/', selector: '[data-tour="brain"]', title: 'Bộ não', content: 'Bộ não là bộ điều phối, chia việc và theo dõi worker. Dùng khi muốn giao một mục tiêu lớn để hệ thống tự lập kế hoạch. Nó khác Trợ lý ở chỗ bộ não chạy quy trình task, còn Trợ lý trả lời hội thoại.', placement: 'bottom' },
    { id: 'assistant', route: '/chat', selector: '[data-tour="assistant-chat"]', title: 'Trợ lý', content: 'Trợ lý là cuộc trò chuyện nhanh để hỏi, khám phá và tạo task. Dùng khi chưa cần quy trình điều phối đầy đủ. Bấm gửi để nhận câu trả lời; nội dung chưa tự trở thành task nếu bạn không yêu cầu.', placement: 'right' },
    { id: 'projects', route: '/projects', selector: '[data-tour="projects"]', title: 'Project', content: 'Project là cấu hình một kho mã, nhánh và chính sách chạy. Dùng để AgentHub biết sửa đúng thư mục. Bấm một project để mở cài đặt; kiểm tra đường dẫn trước khi bật quyền toàn phần.', placement: 'right' },
    { id: 'tasks', route: '/tasks', selector: '[data-tour="tasks"]', title: 'Task', content: 'Task là một việc cụ thể được xếp hàng cho worker. Dùng để theo dõi trạng thái, log và kết quả. Bấm task để xem chi tiết; Huỷ có thể dừng lần chạy hiện tại.', placement: 'right' },
    { id: 'queue', route: '/tasks', selector: '[data-tour="task-filters"]', title: 'Hàng đợi', content: 'Đây là bộ lọc và các cột vòng đời task. Dùng để tìm việc đang chờ, đang chạy hoặc cần duyệt. Chọn trạng thái để thu hẹp danh sách; bộ lọc không xoá task.', placement: 'bottom' },
    { id: 'plans', route: '/plans', selector: '[data-tour="plans"]', title: 'Kế hoạch', content: 'Kế hoạch là danh sách bước do bộ não đề xuất trước khi chạy. Dùng để xem, sửa và duyệt phạm vi công việc. Bấm Duyệt để cho phép dispatch; hãy kiểm tra phụ thuộc trước.', placement: 'right' },
    { id: 'lifecycle', route: '/tasks', selector: '[data-tour="task-lifecycle"]', title: 'Vòng đời task', content: 'Task đi qua xếp hàng → chạy → kiểm tra → chờ duyệt → merge → deploy. Dùng chuỗi này để biết đang chờ ở đâu. Bấm chi tiết để xem lý do; không phải trạng thái nào cũng tự chuyển tiếp.', placement: 'top' },
    { id: 'profiles', route: '/profiles', selector: '[data-tour="profiles"]', title: 'Tài khoản', content: 'Tài khoản là kết nối tới nhà cung cấp model. Dùng nhiều tài khoản để phân bổ quota và dự phòng. Bấm Đăng nhập lại khi phiên hết hạn; không chia sẻ refresh token.', placement: 'right' },
    { id: 'settings', route: '/settings', selector: '[data-tour="settings"]', title: 'Cài đặt hệ thống', content: 'Cài đặt hệ thống điều khiển model, quyền, thông báo và giới hạn chạy. Dùng khi muốn đổi chính sách chung. Bấm Lưu để áp dụng; thay đổi có thể ảnh hưởng task mới.', placement: 'right' },
    { id: 'setup', route: '/setup', selector: '[data-tour="setup"]', title: 'Thiết lập', content: 'Thiết lập kiểm tra CLI, MCP và hồ sơ cần thiết. Dùng lần đầu hoặc sau khi đổi máy. Bấm kiểm tra/cài đặt để sửa mục thiếu; không cần chạy lại nếu mọi mục đều xanh.', placement: 'right' },
    { id: 'help', route: '/', selector: '[data-tour="help"]', title: 'Trợ giúp', content: 'Panel trợ giúp chứa mục lục các tour và bài ngắn theo trang. Dùng khi quên ý nghĩa một trường hoặc nút. Bấm ? để tìm kiếm và bắt đầu lại tour; nội dung có cả Việt và Anh.', placement: 'bottom' },
  ] },
];

const pageTours: Record<string, TourDefinition> = {
  '/': { id: 'page-dashboard', steps: [
    { id: 'overview', selector: '[data-tour="overview"]', title: 'Tổng quan', content: 'Đây là trang tóm tắt sức khỏe hub. Dùng trước khi giao việc để biết hệ thống sẵn sàng chưa. Bấm thẻ để đi tới chi tiết; dữ liệu cập nhật theo thời gian thực.', placement: 'bottom' },
    { id: 'resources', selector: '[data-tour="resource-status"]', title: 'Tài nguyên', content: 'Đây là tải máy và ổ đĩa. Dùng để quyết định có nên tăng số worker không. Bấm vào cảnh báo để xử lý; thiếu dung lượng có thể làm task thất bại.', placement: 'bottom' },
    { id: 'brain', selector: '[data-tour="brain"]', title: 'Bộ não', content: 'Đây là trạng thái bộ não và Trợ lý theo project. Dùng để biết ai đang điều phối hoặc trả lời. Bấm liên kết chat để xem phiên; quota model vẫn được tính.', placement: 'bottom' },
    { id: 'quotas', selector: '[data-tour="provider-quotas"]', title: 'Quota nhà cung cấp', content: 'Đây là quota theo họ model và thời điểm reset. Dùng phần trăm còn lại để chọn nhà cung cấp; giờ reset là lúc quota dự kiến trở lại. Tránh nhầm giờ địa phương khi lập kế hoạch.', placement: 'top' },
    { id: 'performance', selector: '[data-tour="performance"]', title: 'Hiệu năng', content: 'Đây là các số liệu chạy và thời gian xử lý. Dùng để phát hiện worker chậm hoặc hàng đợi tăng. Bấm task liên quan để xem log; số liệu không tự sửa cấu hình.', placement: 'top' },
    { id: 'checklist', selector: '[data-tour="checklist"]', title: 'Checklist', content: 'Checklist là các việc nên hoàn tất để dùng hub an toàn. Dùng khi mới cài hoặc onboarding thành viên. Bấm từng mục để đi tới nơi cấu hình; bỏ qua không xoá project.', placement: 'top' },
    { id: 'workers', selector: '[data-tour="workers"]', title: 'Worker đang chạy', content: 'Đây là các worker đang thực thi task. Dùng để theo dõi model, thời gian và tài nguyên. Bấm Tạm dừng khi cần giữ trạng thái; bấm Tiếp tục để chạy tiếp.', placement: 'top' },
  ] },
  '/projects': { id: 'page-projects', steps: [
    { id: 'projects', selector: '[data-tour="projects"]', title: 'Danh sách project', content: 'Đây là các kho mã đã đăng ký. Dùng để chọn phạm vi mà worker được phép sửa. Bấm project để mở cài đặt; kiểm tra đường dẫn và nhánh trước khi tạo task.', placement: 'bottom' },
    { id: 'register', selector: '[data-tour="project-register"]', title: 'Đăng ký dự án', content: 'Đây là nút thêm kho mã vào hub. Dùng khi bắt đầu với project mới. Bấm để nhập đường dẫn và nhánh mặc định; đường dẫn sai sẽ làm worker chạy nhầm nơi.', placement: 'bottom' },
    { id: 'project-card', selector: '[data-tour="project-card"]', title: 'Thẻ project', content: 'Thẻ này tóm tắt trạng thái, nhánh và giới hạn song song. Dùng để kiểm tra chính sách trước khi chạy. Bấm Cài đặt để sửa; thay đổi áp dụng cho task mới.', placement: 'top' },
    { id: 'brain-settings', selector: '[data-tour="project-brain-settings"]', title: 'Bộ não project', content: 'Đây là chế độ, quyền và ngân sách của bộ não theo project. Dùng khi project cần chính sách riêng. Bật full chỉ khi tin cậy repo; quyền rộng có rủi ro sửa hoặc chạy lệnh ngoài ý muốn.', placement: 'left' },
    { id: 'worktree', selector: '[data-tour="project-worktree"]', title: 'Worktree', content: 'Worktree là thư mục làm việc tách cho task. Dùng để nhiều task không ghi đè nhau. Bấm lựa chọn để đổi chiến lược; dọn worktree cũ trước khi thiếu ổ đĩa.', placement: 'left' },
    { id: 'references', selector: '[data-tour="project-references"]', title: 'Tham chiếu', content: 'Tham chiếu là tài liệu được đưa vào ngữ cảnh worker. Dùng để cung cấp quy ước hoặc API. Bấm thêm để chọn nguồn; nội dung nhạy cảm có thể bị gửi tới model.', placement: 'left' },
    { id: 'checks', selector: '[data-tour="project-checks"]', title: 'Kiểm tra và review', content: 'Checks là JSON mô tả lệnh kiểm tra sau khi worker sửa code, ví dụ {"command":"npm test"}. Dùng để chặn kết quả lỗi trước review. Bật khi repo có test ổn định; JSON sai sẽ không chạy được.', placement: 'left' },
  ] },
  '/settings': { id: 'page-settings', steps: [
    { id: 'settings', selector: '[data-tour="settings"]', title: 'Cài đặt chung', content: 'Đây là chính sách điều phối toàn hub. Dùng khi muốn đổi mặc định cho task mới. Bấm Lưu sau mỗi nhóm; hãy ghi lại giá trị cũ nếu cần hoàn tác.', placement: 'bottom' },
    { id: 'model-chain', selector: '[data-tour="model-chain"]', title: 'Chuỗi model', content: 'Chuỗi model là thứ tự thử từ khó đến dễ khi chạy task. Dùng để cân bằng chất lượng và quota. Bấm sắp xếp để đổi ưu tiên; model đầu tiên tốn quota trước.', placement: 'bottom' },
    { id: 'planning-approval', selector: '[data-tour="planning-approval"]', title: 'Duyệt kế hoạch', content: 'Đây là lựa chọn tự duyệt, duyệt thủ công hoặc bỏ qua kế hoạch. Dùng thủ công cho repo quan trọng; bấm lựa chọn để đổi luồng. Tự duyệt giảm kiểm soát phạm vi.', placement: 'bottom' },
    { id: 'brain-policy', selector: '[data-tour="brain-policy"]', title: 'Chính sách bộ não', content: 'Đây là chế độ, quyền, ngân sách và số lần chạy cùng lúc. Dùng để giới hạn chi phí và tác động. Bấm Lưu để áp dụng; tăng song song có thể làm máy quá tải.', placement: 'bottom' },
    { id: 'notifications', selector: '[data-tour="notifications"]', title: 'Thông báo', content: 'Đây là thông báo desktop, giờ yên tĩnh và bản tóm tắt. Dùng để không bỏ lỡ review nhưng tránh bị làm phiền. Bấm công tắc để bật; giờ yên tĩnh sẽ trì hoãn cảnh báo.', placement: 'top' },
    { id: 'telegram', selector: '[data-tour="telegram"]', title: 'Telegram', content: 'Đây là kết nối bot và chat Telegram. Dùng để nhận trạng thái ngoài trình duyệt. Bấm lưu token rồi gửi mã ghép nối; token bot là bí mật, không đưa vào log.', placement: 'top' },
    { id: 'accounts', selector: '[data-tour="multiple-accounts"]', title: 'Nhiều tài khoản', content: 'Đây là tùy chọn dùng nhiều tài khoản cùng nhà cung cấp. Dùng để chia quota hoặc dự phòng. Bật khi các hồ sơ thuộc tài khoản hợp lệ; quota trùng email vẫn dùng chung.', placement: 'top' },
    { id: 'updates', selector: '[data-tour="updates"]', title: 'Cập nhật', content: 'Đây là phiên bản và trạng thái cập nhật AgentHub. Dùng để biết có bản sửa lỗi mới. Bấm kiểm tra/cập nhật theo hướng dẫn; không khởi động lại hub thật trong lúc task đang chạy.', placement: 'top' },
  ] },
  '/setup': { id: 'page-setup', steps: [
    { id: 'setup', selector: '[data-tour="setup"]', title: 'Thiết lập', content: 'Đây là checklist cài đặt AgentHub. Dùng khi thiết lập máy hoặc sửa lỗi môi trường. Bấm kiểm tra từng dòng; chỉ cài mục thiếu.', placement: 'right' },
    { id: 'tools', selector: '[data-tour="setup-tools"]', title: 'Công cụ', content: 'Đây là các CLI worker cần có. Dùng để xác nhận lệnh có thể chạy. Bấm cài hoặc kiểm tra; phiên bản không tương thích có thể làm task thất bại.', placement: 'right' },
    { id: 'profiles', selector: '[data-tour="setup-profiles"]', title: 'Hồ sơ đăng nhập', content: 'Đây là trạng thái đăng nhập các nhà cung cấp. Dùng để biết model nào sẵn sàng. Bấm đăng nhập lại khi hết phiên; không nhập token vào chat.', placement: 'right' },
    { id: 'setup-result', selector: '[data-tour="setup-result"]', title: 'Kết quả kiểm tra', content: 'Đây là kết quả lệnh kiểm tra gần nhất. Dùng để đọc lỗi trước khi chạy task. Bấm xem chi tiết để biết nguyên nhân; lỗi cảnh báo không luôn chặn toàn hệ thống.', placement: 'right' },
    { id: 'help', selector: '[data-tour="help"]', title: 'Trợ giúp', content: 'Đây là nút mở panel trợ giúp. Dùng để tìm bài hướng dẫn hoặc bắt đầu lại tour. Bấm ? bất cứ lúc nào khi quên thao tác.', placement: 'bottom' },
  ] },
  '/profiles': { id: 'page-profiles', steps: [
    { id: 'profiles', selector: '[data-tour="profiles"]', title: 'Tài khoản', content: 'Đây là danh sách hồ sơ nhà cung cấp. Dùng để theo dõi đăng nhập và quota. Bấm một hồ sơ để đăng nhập lại hoặc chỉnh sửa; refresh token phải giữ kín.', placement: 'right' },
    { id: 'provider-quota', selector: '[data-tour="profile-quotas"]', title: 'Quota', content: 'Đây là phần trăm quota còn lại và giờ reset. Dùng để chọn hồ sơ phù hợp cho task. Bấm xem chi tiết để biết họ model; quota hết sẽ khiến worker chờ hoặc chuyển dự phòng.', placement: 'right' },
    { id: 'account-types', selector: '[data-tour="account-types"]', title: 'Loại tài khoản', content: 'Đây là tài khoản cá nhân, Team hoặc API. Dùng đúng loại để hiểu quyền và quota. Bấm thêm tài khoản để chọn nhà cung cấp; API key có thể tính phí riêng.', placement: 'right' },
    { id: 'add-account', selector: '[data-tour="add-account"]', title: 'Thêm tài khoản', content: 'Đây là nút mở luồng đăng nhập nhà cung cấp. Dùng khi cần thêm quota hoặc dự phòng. Bấm và chọn Terminal hoặc token; kiểm tra email để tránh trùng tài khoản.', placement: 'right' },
    { id: 'reauth', selector: '[data-tour="reauth"]', title: 'Đăng nhập lại', content: 'Đây là thao tác làm mới phiên đăng nhập. Dùng khi hồ sơ báo hết hạn. Bấm để mở Terminal; không xoá hồ sơ nếu chỉ cần gia hạn phiên.', placement: 'right' },
    { id: 'help', selector: '[data-tour="help"]', title: 'Trợ giúp', content: 'Đây là nút mở panel trợ giúp. Dùng để tìm bài về quota hoặc tài khoản. Bấm ? rồi chọn Bắt đầu lại tour này nếu muốn xem từ đầu.', placement: 'bottom' },
  ] },
  '/tasks': { id: 'page-tasks', steps: [
    { id: 'tasks', selector: '[data-tour="tasks"]', title: 'Task', content: 'Đây là bảng các task theo trạng thái. Dùng để theo dõi toàn bộ công việc. Bấm một thẻ để mở chi tiết; dữ liệu có thể thay đổi khi worker đang chạy.', placement: 'right' },
    { id: 'filters', selector: '[data-tour="task-filters"]', title: 'Bộ lọc', content: 'Đây là bộ lọc project, trạng thái và tìm kiếm. Dùng để tìm đúng task giữa danh sách lớn. Bấm chọn hoặc nhập từ khóa; lọc chỉ thay đổi cách hiển thị.', placement: 'bottom' },
    { id: 'views', selector: '[data-tour="task-views"]', title: 'Kanban và DAG', content: 'Đây là hai cách xem task: cột trạng thái và đồ thị phụ thuộc. Dùng Kanban để xử lý hàng ngày, DAG để hiểu thứ tự. Bấm tab để đổi chế độ; không thay đổi dữ liệu.', placement: 'bottom' },
    { id: 'lifecycle', selector: '[data-tour="task-lifecycle"]', title: 'Trạng thái', content: 'Đây là các bước xếp hàng, chạy, kiểm tra và review. Dùng để biết bước tiếp theo. Bấm thẻ để xem lý do chờ; không tự bỏ qua kiểm tra bắt buộc.', placement: 'top' },
    { id: 'actions', selector: '[data-tour="task-actions"]', title: 'Chạy lại, Huỷ, Tạm dừng', content: 'Đây là nhóm thao tác điều khiển task. Dùng Chạy lại khi lỗi tạm thời, Tạm dừng để giữ trạng thái, Huỷ để kết thúc. Bấm Huỷ là hành động khó hoàn tác; hãy xác nhận đúng task.', placement: 'top' },
    { id: 'columns', selector: '[data-tour="task-columns"]', title: 'Các cột', content: 'Các cột cho biết task đang chờ, chạy, review hay hoàn tất. Dùng để đọc tiến độ tổng thể. Bấm thẻ để xem log và diff; số lượng cột không phải số worker.', placement: 'top' },
    { id: 'help', selector: '[data-tour="help"]', title: 'Trợ giúp', content: 'Đây là nút mở panel trợ giúp của trang Task. Dùng để tra ý nghĩa cột và nút. Bấm ? để tìm kiếm hoặc chạy lại tour.', placement: 'bottom' },
  ] },
  '/tasks-detail': { id: 'page-task-detail', steps: [
    { id: 'tasks', selector: '[data-tour="tasks"]', title: 'Chi tiết task', content: 'Đây là nơi kiểm tra một task từ đầu đến cuối. Dùng trước khi duyệt hoặc trả về. Bấm các tab để đọc bằng chứng; duyệt khi log, diff và checks đều ổn.', placement: 'right' },
    { id: 'tabs', selector: '[data-tour="task-detail-tabs"]', title: 'Log, Diff, Kiểm tra, Review', content: 'Đây là các tab bằng chứng: Log là diễn biến, Diff là thay đổi, Kiểm tra là lệnh test, Review là quyết định. Dùng theo thứ tự này trước khi duyệt. Bấm tab để chuyển, không làm mất dữ liệu.', placement: 'bottom' },
    { id: 'run-actions', selector: '[data-tour="task-run-actions"]', title: 'Điều khiển lần chạy', content: 'Đây là các nút chạy lại, tạm dừng và huỷ. Dùng chạy lại cho lỗi tạm thời; tạm dừng để điều tra; huỷ khi không cần nữa. Huỷ có thể dừng worker ngay.', placement: 'bottom' },
    { id: 'review', selector: '[data-tour="task-review"]', title: 'Duyệt hoặc trả về', content: 'Đây là nơi duyệt kết quả hoặc yêu cầu sửa. Dùng Duyệt khi thay đổi đạt yêu cầu; Trả về khi cần feedback cụ thể. Bấm Duyệt có thể chuyển sang merge/deploy theo chính sách.', placement: 'bottom' },
    { id: 'capture', selector: '[data-tour="task-capture"]', title: 'Tạo task sửa từ log', content: 'Đây là nút tạo task mới từ một lỗi hoặc đoạn log. Dùng để giữ ngữ cảnh điều tra. Bấm và chỉnh mô tả trước khi gửi; task mới vẫn tiêu tốn quota.', placement: 'top' },
    { id: 'task-summary', selector: '[data-tour="task-summary"]', title: 'Tóm tắt task', content: 'Đây là project, model, nhánh và trạng thái của task. Dùng để xác nhận bạn đang xem đúng việc. Bấm liên kết project nếu cần đổi chính sách; không sửa nhầm nhánh tích hợp.', placement: 'top' },
    { id: 'help', selector: '[data-tour="help"]', title: 'Trợ giúp', content: 'Đây là nút mở bài hướng dẫn Chi tiết task. Dùng để tra tab hoặc quy trình review. Bấm ? để tìm kiếm và bắt đầu lại tour.', placement: 'bottom' },
  ] },
  '/chat': { id: 'page-chat', steps: [
    { id: 'chat', selector: '[data-tour="chat"]', title: 'Chat', content: 'Đây là nơi trao đổi trực tiếp với Trợ lý hoặc bộ não. Dùng Chat để hỏi nhanh, dùng bộ não để điều phối task. Bấm chọn phiên để tiếp tục ngữ cảnh.', placement: 'right' },
    { id: 'assistant', selector: '[data-tour="assistant-chat"]', title: 'Trợ lý và bộ não', content: 'Trợ lý trả lời hội thoại; bộ não lập kế hoạch và theo dõi worker. Dùng đúng chế độ cho mục tiêu. Bấm bộ chọn để đổi; đổi chế độ có thể đổi model và quota.', placement: 'bottom' },
    { id: 'composer', selector: '[data-tour="chat-composer"]', title: 'Ô nhập', content: 'Đây là ô viết tin nhắn. Dùng / để chọn lệnh và @ để chèn project, task hoặc tài liệu. Bấm Gửi để thực thi; kiểm tra nội dung trước khi yêu cầu quyền rộng.', placement: 'top' },
    { id: 'new-session', selector: '[data-tour="new-session"]', title: 'Phiên chat mới', content: 'Đây là nút tạo ngữ cảnh hội thoại mới. Dùng khi đổi project hoặc chủ đề. Bấm để chọn project và safe/full; full có thể chạy lệnh và sửa file.', placement: 'bottom' },
    { id: 'permissions', selector: '[data-tour="chat-permissions"]', title: 'Xin quyền', content: 'Thẻ xin quyền cho biết công cụ muốn làm gì. Cho phép chỉ chấp thuận lần này, Luôn cho phép lưu quy tắc, Từ chối chặn thao tác. Chọn Luôn cho phép chỉ với lệnh tin cậy.', placement: 'top' },
    { id: 'sessions', selector: '[data-tour="chat-sessions"]', title: 'Danh sách phiên', content: 'Đây là các phiên đã lưu. Dùng để quay lại ngữ cảnh cũ hoặc xoá phiên không còn cần. Bấm phiên để mở; xoá là hành động khó hoàn tác.', placement: 'right' },
    { id: 'help', selector: '[data-tour="help"]', title: 'Trợ giúp', content: 'Đây là nút mở hướng dẫn Chat. Dùng để tra /, @ và thẻ quyền. Bấm ? để tìm kiếm hoặc chạy lại tour.', placement: 'bottom' },
  ] },
  '/plans': { id: 'page-plans', steps: [
    { id: 'plans', selector: '[data-tour="plans"]', title: 'Kế hoạch', content: 'Đây là các kế hoạch bộ não đề xuất. Dùng để kiểm tra phạm vi trước khi dispatch. Bấm một kế hoạch để xem chi tiết; chưa duyệt thì worker chưa chạy.', placement: 'right' },
    { id: 'filters', selector: '[data-tour="plan-filters"]', title: 'Bộ lọc kế hoạch', content: 'Đây là bộ lọc project và trạng thái. Dùng để tìm kế hoạch nháp hoặc đang chạy. Bấm lựa chọn để lọc; không thay đổi kế hoạch.', placement: 'bottom' },
    { id: 'current', selector: '[data-tour="current-plan"]', title: 'Kế hoạch hiện tại', content: 'Đây là kế hoạch đang được chọn. Dùng để đọc phụ thuộc và thứ tự task. Bấm từng task để sửa; sửa phụ thuộc có thể thay đổi lịch chạy.', placement: 'bottom' },
    { id: 'add-task', selector: '[data-tour="add-task"]', title: 'Thêm task', content: 'Đây là nút thêm một task vào kế hoạch. Dùng khi kế hoạch thiếu bước. Bấm để nhập độ khó, model chain và phụ thuộc; phụ thuộc sai có thể tạo vòng lặp.', placement: 'top' },
    { id: 'approve-plan', selector: '[data-tour="approve-plan"]', title: 'Duyệt kế hoạch', content: 'Đây là nút cho phép kế hoạch được dispatch. Dùng sau khi kiểm tra task và phụ thuộc. Bấm Duyệt để chuyển vòng đời; hãy chắc project và model đúng.', placement: 'top' },
    { id: 'help', selector: '[data-tour="help"]', title: 'Trợ giúp', content: 'Đây là nút mở hướng dẫn Kế hoạch. Dùng để hiểu phụ thuộc và duyệt. Bấm ? để tìm kiếm hoặc chạy lại tour.', placement: 'bottom' },
  ] },
};

export const modalTourDefinitions: TourDefinition[] = [
  { id: 'modal-add-account', steps: [{ id: 'modal', selector: '[data-tour="modal-add-account"]', title: 'Thêm tài khoản', content: 'Đây là hộp thoại thêm hồ sơ nhà cung cấp. Dùng để thêm quota hoặc dự phòng. Bấm chọn nhà cung cấp rồi chọn Terminal hoặc Refresh Token; token là bí mật và không nên dán vào nơi khác.' }] },
  { id: 'modal-register-project', steps: [{ id: 'modal', selector: '[data-tour="modal-register-project"]', title: 'Đăng ký dự án', content: 'Đây là hộp thoại đăng ký project. Dùng để khai báo đường dẫn, nhánh mặc định và giới hạn song song. Bấm Nâng cao để mở chính sách; đường dẫn sai có thể làm worker sửa nhầm repo.' }] },
  { id: 'modal-create-task', steps: [{ id: 'modal', selector: '[data-tour="modal-create-task"]', title: 'Tạo task', content: 'Đây là hộp thoại tạo task. Dùng để mô tả mục tiêu, độ khó, chuỗi model và phụ thuộc. Bấm Tạo để xếp hàng; chọn model khó trước sẽ tốn quota hơn.' }] },
  { id: 'modal-new-session', steps: [{ id: 'modal', selector: '[data-tour="modal-new-session"]', title: 'Phiên chat mới', content: 'Đây là hộp thoại tạo phiên chat. Dùng để chọn project và chế độ safe/full. Bấm Tạo phiên để lưu ngữ cảnh; full cho phép tác động rộng hơn và cần thận trọng.' }] },
  { id: 'modal-full-permission', steps: [{ id: 'modal', selector: '[data-tour="modal-full-permission"]', title: 'Xác nhận toàn quyền', content: 'Đây là hộp thoại cảnh báo quyền full. Dùng khi bạn hiểu lệnh và thư mục worker sẽ chạm tới. Bấm Xác nhận chỉ khi cần; quyền này có thể sửa file hoặc chạy lệnh nguy hiểm.' }] },
  { id: 'modal-delete-project', steps: [{ id: 'modal', selector: '[data-tour="modal-delete-project"]', title: 'Xoá dự án', content: 'Đây là hộp thoại xác nhận xoá project. Dùng để bỏ cấu hình không còn cần. Bấm Xoá sẽ loại project khỏi hub; kiểm tra task và worktree trước vì thao tác có thể khó hoàn tác.' }] },
];

const noOpTourContext: TourContextValue = {
  active: null,
  stepIndex: 0,
  openTour: () => {},
  closeTour: () => {},
  next: () => {},
  previous: () => {},
  getPageTour: () => null,
  suggestModalTour: () => {},
};

const TourContext = createContext<TourContextValue>(noOpTourContext);

export const TourProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: config } = useQuery({ queryKey: ['config'], queryFn: getConfig, staleTime: 30_000 });
  const { data: setup } = useQuery({ queryKey: ['setup-status'], queryFn: getSetupStatus, staleTime: 10_000 });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);

  const seen = config?.ui?.tours || {};
  const getPageTour = useCallback((pathname: string) => {
    if (pathname.startsWith('/tasks/') && pathname !== '/tasks/new') return pageTours['/tasks-detail'];
    const key = Object.keys(pageTours).find((candidate) => candidate === pathname || (candidate !== '/' && pathname.startsWith(`${candidate}/`)));
    return key ? pageTours[key] : null;
  }, []);
  const active = useMemo(() => tourDefinitions.find((tour) => tour.id === activeId) || Object.values(pageTours).find((tour) => tour.id === activeId) || modalTourDefinitions.find((tour) => tour.id === activeId) || (activeId ? null : null), [activeId]);

  const markSeen = useCallback(async (id: string) => {
    try {
      const old = JSON.parse(localStorage.getItem(fallbackKey) || '{}');
      localStorage.setItem(fallbackKey, JSON.stringify({ ...old, [id]: true }));
      if (id.startsWith('modal-')) localStorage.setItem(`${fallbackKey}:${id}`, '1');
    } catch { /* storage is optional */ }
    try {
      await updateConfig({ ui: { tours: { ...seen, [id]: true } } });
      await queryClient.invalidateQueries({ queryKey: ['config'] });
    } catch {
    }
  }, [queryClient, seen]);

  const openTour = useCallback((id: string) => {
    const tour = tourDefinitions.find((item) => item.id === id) || Object.values(pageTours).find((item) => item.id === id) || modalTourDefinitions.find((item) => item.id === id);
    if (!tour) return;
    setActiveId(tour.id);
    setStepIndex(0);
    if (tour.steps[0]?.route && location.pathname !== tour.steps[0].route) navigate(tour.steps[0].route);
  }, [location.pathname, navigate]);

  const suggestModalTour = useCallback((id: string) => {
    let seenModal = false;
    try { seenModal = localStorage.getItem(`${fallbackKey}:${id}`) === '1'; } catch { /* optional storage */ }
    if (!seenModal) openTour(id);
  }, [openTour]);

  const closeTour = useCallback((completed = true) => {
    if (active) void markSeen(active.id);
    setActiveId(null);
    setStepIndex(0);
    void completed;
  }, [active, markSeen]);

  const next = useCallback(() => {
    if (!active) return;
    if (stepIndex >= active.steps.length - 1) { closeTour(true); return; }
    const nextIndex = stepIndex + 1;
    setStepIndex(nextIndex);
    const nextStep = active.steps[nextIndex];
    if (nextStep.route && location.pathname !== nextStep.route) navigate(nextStep.route);
  }, [active, closeTour, location.pathname, navigate, stepIndex]);

  const previous = useCallback(() => {
    if (!active || stepIndex === 0) return;
    const previousIndex = stepIndex - 1;
    setStepIndex(previousIndex);
    const previousStep = active.steps[previousIndex];
    if (previousStep.route && location.pathname !== previousStep.route) navigate(previousStep.route);
  }, [active, location.pathname, navigate, stepIndex]);

  useEffect(() => {
    if (!setup || activeId || !(setup.setupCompletedAt || setup.setupSkippedAt)) return;
    let localSeen: Record<string, boolean> = {};
    try { localSeen = JSON.parse(localStorage.getItem(fallbackKey) || '{}'); } catch { /* ignore */ }
    if (!seen.intro && !localSeen.intro) openTour('intro');
  }, [activeId, openTour, seen.intro, setup]);

  return <TourContext.Provider value={{ active, stepIndex, openTour, closeTour, next, previous, getPageTour, suggestModalTour }}>{children}</TourContext.Provider>;
};

export function useTour(): TourContextValue {
  return useContext(TourContext);
}
