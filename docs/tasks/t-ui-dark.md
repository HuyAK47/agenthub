# Task: t-ui-dark – Dark theme cho dashboard (task nhỏ, khoảng 30 phút)

Nhánh: `t-ui-dark`. **Phạm vi file: chỉ `web/src/pages/`, `web/src/components/`, `web/src/index.css`, `web/index.html` và `web/public/`.**
**KHÔNG sửa** `web/src/api/`, `web/src/types/` và `src/`: các task khác đang làm song song ở đó.
Commit nhỏ. Lệnh có thể chạy lâu phải bọc `timeout`. Khi xong tạo `docs/tasks/t-ui-dark.DONE`.

## Yêu cầu (người dùng muốn giao diện tối)
1. **Mặc định là dark theme.** Lựa chọn theme lưu trong `localStorage` (bọc try/catch). Công tắc trên header có 3 chế độ: Tối / Sáng / Theo hệ thống. Lần đầu mở thì dùng **Tối**.
2. **Bảng màu dark** trông chuyên nghiệp, kiểu Linear/Vercel:
   - nền khoảng `#0b0d12`;
   - bề mặt (card) khoảng `#12151c`, viền khoảng `#1f2430`;
   - chữ chính khoảng `#e6e8ee`, chữ phụ khoảng `#8b93a7`.

   Định nghĩa thành biến CSS (token), dùng chung cho mọi trang. Không hardcode màu trong từng component.
3. Màu trạng thái (`queued`, `running`, `review`, `done`, `blocked`, `failed`, `waiting_quota`) phải dễ đọc trên nền tối, nhất quán ở badge, Kanban và các ô thống kê.
4. Terminal xterm (log và đăng nhập) dùng theme tối khớp với tông chung.
5. **Bỏ chữ nghiêng toàn cục.** Ảnh chụp cho thấy toàn bộ chữ đang in nghiêng, nhiều khả năng do CSS gốc. Dùng font sans hệ thống (`Inter` nếu có, nếu không thì `system-ui`). Font mono cho log/terminal.
6. Sửa lỗi 404 của `/vite.svg`: thêm favicon riêng (SVG đơn giản) vào `web/public/`.
7. Bảng "Worker đang chạy" ở trang Tổng quan: nếu item có trường `title` thì hiển thị `title`, còn không thì hiển thị `taskId`. Backend sắp bổ sung trường `title` và `projectId`.

## Nghiệm thu
- `npm run lint && npm run build:web && npm run test:web -- --run` đều đạt. Cập nhật snapshot/test nếu cần.
- Trong file DONE, mô tả bảng màu đã chọn và danh sách file đã sửa.
