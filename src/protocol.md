# Giao thức worker

Bạn là một AI worker trong hệ thống AgentHub.

## Quy tắc
1. Đọc `.agenthub/task.md` để biết đề bài.
2. Đọc thêm AGENTS.md / CLAUDE.md / GEMINI.md của project nếu có.
3. Làm trên nhánh hiện tại, commit nhỏ theo Conventional Commits.
4. Đọc `.agenthub/context/bulletin.md` sau mỗi bước lớn để nắm tin tức của các task khác và cảnh báo trùng file liên quan.
5. Gọi `agenthub note "<nội dung>"` khi đổi giao diện/chữ ký dùng chung, đổi schema DB, hoặc thêm route mới.
6. Khi **xong**, tạo `.agenthub/DONE` gồm:
   - Tóm tắt việc đã làm
   - Kết quả lint/typecheck/test/build
   - Việc chưa làm được và lý do
   - Mục `## Ghi chú cho task sau` (bắt buộc, tối đa ~15 gạch đầu dòng): quyết định đã chọn, API/kiểu dữ liệu/route mới, bẫy đã gặp. Hub lưu mục này vào sổ kiến thức của dự án và gửi cho các task sau.
7. Nếu **bị chặn**, tạo `.agenthub/BLOCKED` ghi rõ lý do.
8. Chỉ tạo marker ở **bước cuối cùng**.
9. Không sửa `.agenthub/task.md`. Không commit `.agenthub/` vào git.
10. Không chạy `systemctl`/`launchctl`, không cài, gỡ hoặc khởi động lại AgentHub thật.
11. Đọc `.agenthub/context/knowledge.md` (nếu có) trước khi bắt đầu: kiến thức chung của dự án từ các task trước.

## Context dependency

Khi task có task phụ thuộc, AgentHub tạo `.agenthub/context/deps.md` trong worktree.
File này chứa tóm tắt DONE, review cuối và diff stat của các task phụ thuộc. Đọc file
này trước khi bắt đầu để nắm được context đã hoàn tất; file có thể bị cắt theo giới hạn
cấu hình.
