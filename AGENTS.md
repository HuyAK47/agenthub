# Hướng dẫn cho AI agent làm việc trong repo AgentHub

Repo này do AI worker (Antigravity / Codex) viết code. Claude Code giao việc và review.
Hai bên chỉ trao đổi qua file trong repo.

## Tài liệu bắt buộc đọc
- `docs/PLAN.md`: thiết kế đầy đủ. Mục 2 là **kiến thức hệ thống đã kiểm chứng**, phải tuân theo tuyệt đối.
- `docs/tasks/<task>.md`: đề bài của lượt việc hiện tại.

## Giao thức
1. Làm trên nhánh mà task chỉ định. Commit nhỏ, mỗi phần một commit, message theo Conventional Commits.
2. Khi **xong**, tạo `docs/tasks/<task>.DONE` gồm:
   - tóm tắt việc đã làm;
   - kết quả lint/typecheck/test/build, kèm số test;
   - việc chưa làm được và lý do;
   - danh sách commit.
3. Khi **bị chặn**, tạo `docs/tasks/<task>.BLOCKED` ghi rõ lý do rồi dừng lại.
4. Chỉ tạo `.DONE`/`.BLOCKED` ở **bước cuối cùng**, sau khi đã commit xong.
5. Không sửa `docs/PLAN.md` và các file task. Nếu cần làm khác kế hoạch, ghi vào `docs/DECISIONS.md`.

## Môi trường
- Mọi lệnh dùng Node đều chạy sau `source ~/.nvm/nvm.sh && nvm use 22`.
- Dùng npm.
- **Không** chạy agy/codex thật trong test.
- **Không** đọc, in hay giải mã file token hoặc keyring của agy/codex.
- **Không** động vào `~/.agy-homes/*` ngoài phạm vi đọc metadata mà đề bài cho phép. Test dùng thư mục tạm.
