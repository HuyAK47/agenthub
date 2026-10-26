# Dữ liệu tạm và cách hub tự dọn

AgentHub chỉ tạo thư mục tạm có prefix `agenthub-`. Khi daemon khởi động và sau mỗi 6 giờ, hub xóa các thư mục prefix này đã quá 24 giờ và thuộc user hiện tại; thư mục mới và prefix khác được giữ nguyên.

Khi task `done` hoặc `cancelled`, output tạm `${runId}.final.json` được xóa sau khi run kết thúc. Log chính `${runId}.log` vẫn được giữ để tra cứu.

Test dùng một thư mục tạm chung cho mỗi lượt chạy và global teardown xóa toàn bộ thư mục đó. Teardown cũng cảnh báo nếu sau lượt test còn tăng hơn 5 thư mục `agenthub-*`; đặt `AGENTHUB_TEST_TMP_FAIL=1` để biến cảnh báo thành lỗi.
