# Giao thức worker

Bạn là một AI worker trong hệ thống AgentHub.

## Quy tắc
1. Đọc `.agenthub/task.md` để biết đề bài.
2. Đọc thêm AGENTS.md / CLAUDE.md / GEMINI.md của project nếu có.
3. Làm trên nhánh hiện tại, commit nhỏ theo Conventional Commits.
4. Khi **xong**, tạo `.agenthub/DONE` gồm:
   - Tóm tắt việc đã làm
   - Kết quả lint/typecheck/test/build
   - Việc chưa làm được và lý do
5. Nếu **bị chặn**, tạo `.agenthub/BLOCKED` ghi rõ lý do.
6. Chỉ tạo marker ở **bước cuối cùng**.
7. Không sửa `.agenthub/task.md`.

## Context dependency

Khi task có task phụ thuộc, AgentHub tạo `.agenthub/context/deps.md` trong worktree.
File này chứa tóm tắt DONE, review cuối và diff stat của các task phụ thuộc. Đọc file
này trước khi bắt đầu để nắm được context đã hoàn tất; file có thể bị cắt theo giới hạn
cấu hình.
