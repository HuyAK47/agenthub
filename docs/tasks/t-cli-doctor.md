# Task: t-cli-doctor – Lệnh `agenthub doctor` (task nhỏ, khoảng 20 phút)

Nhánh: `t-cli-doctor`. **Phạm vi file: `src/cli.ts`, một file mới `src/doctor.ts`, và `test/doctor.test.ts`.**
Không sửa các phần khác.
Commit nhỏ. Lệnh có thể chạy lâu phải bọc `timeout`. **Không** gọi agy hay codex thật trong test. Khi xong tạo `docs/tasks/t-cli-doctor.DONE`.

## Yêu cầu
Lệnh `agenthub doctor` kiểm tra rồi in bảng ✓/✗ bằng tiếng Việt, kèm gợi ý sửa cho từng mục lỗi:
1. Node có phải bản ≥ 22 không, và đường dẫn tới node.
2. `git` có sẵn không, và version.
3. Có tìm thấy agy (`~/.gemini/bin/agy`) và Codex CLI (đường dẫn theo PLAN 2.2) không.
4. Daemon: `GET /health` trên cổng cấu hình (timeout 2 giây), đọc được token chưa, `GET /api/status` với token có trả 200 không.
5. Service systemd: `systemctl --user is-active agenthub` (không có systemd thì báo "bỏ qua").
6. MCP: chạy `claude mcp list` (timeout 10 giây) và tìm dòng `agenthub` (không có lệnh `claude` thì báo "bỏ qua").
7. Hồ sơ: số hồ sơ, hồ sơ chưa đăng nhập, các cặp trùng email, quota mark còn hiệu lực. Đọc qua service, **không đọc file token**.
8. Thư mục `~/.agenthub`: quyền 700; file `token`: quyền 600.

- Mỗi bước kiểm tra là một hàm riêng, nhận các phụ thuộc qua tham số (để test giả lập được).
- Có cờ `--json` để in kết quả dạng JSON.

## Nghiệm thu
- `npm run lint && npm run typecheck && npm test -- --run && npm run build` đều đạt.
- Có test cho từng bước kiểm tra (dùng phụ thuộc giả).
- Chạy `node dist/cli.js doctor` trên máy thật (chỉ đọc), dán kết quả vào file DONE.
