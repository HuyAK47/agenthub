# Audit theme và i18n

## Phạm vi

Đã rà soát dashboard React trong `web/src`, bao gồm Layout, các trang Dashboard/Tasks/Plans/Profiles/Projects/Settings/Chat/Task detail, DAG, terminal đăng nhập, modal, toast và bộ locale `vi`/`en`.

## Phát hiện và đã sửa

- Theme đã có lựa chọn `dark`, `light`, `system`, lưu trong `localStorage`, theo dõi `prefers-color-scheme` và script trong `index.html` để áp dụng class trước khi React khởi chạy. Bổ sung token cho overlay, terminal và log để tránh nhấp nháy/đổi màu sai khi đổi theme.
- Thay màu cố định ở terminal, live log, modal overlay, Plans badge/status, Claude session badge, Settings form và một số trạng thái bằng CSS token semantic.
- Chuỗi UI hard-code ở skip link, BrainCard, chat session list/tool step, project knowledge (áp lại vào bố cục mới), Settings, Profiles modal, Dashboard orphan process, Task detail liên kết task và Chat model aria-label đã chuyển sang i18n.
- Nhãn Plans trong layout sidebar dùng `common.plans` theo đúng locale; PlansPage chỉ đổi màu badge trạng thái sang token semantic, tích hợp với cấu hình duyệt kế hoạch từ integration (12/12 test plansPage đạt).
- `vi` và `en` tiếp tục có cùng tập khóa. Test `i18nAudit.test.tsx` đã có kiểm tra parity khóa và render các trang in English không còn dấu tiếng Việt.

## Còn lại / lý do

- Một số palette biểu đồ Savings, Daily Usage và màu progress vẫn là màu dữ liệu cố định (xanh/lục/tím/amber), chưa chuyển hết sang semantic token trong lượt này vì cần rà lại ý nghĩa từng series và tương phản WCAG ở cả hai theme.
- Một số chuỗi API/user-provided và placeholder mang tính ví dụ kỹ thuật (model, JSON, shell command) được giữ nguyên; đây không phải nội dung giao diện cần dịch.
- Test vẫn phát ra cảnh báo đã có từ trước về React Router, `act(...)` và jsdom thiếu canvas cho xterm; không dùng agent/agy thật.
