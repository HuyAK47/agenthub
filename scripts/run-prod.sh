#!/usr/bin/env bash
# ==============================================================================
# Script đóng gói (Build) và vận hành Production cho AgentHub
# Dự án: AgentHub
# ==============================================================================

set -eo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -P "$SCRIPT_DIR/.." && pwd)"

# 1. Kích hoạt môi trường Node 22 từ NVM nếu có
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  nvm use 22 >/dev/null 2>&1 || true
fi

NODE_MAJOR=$(node -v 2>/dev/null | cut -d'.' -f1 | sed 's/v//' || echo "0")
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "❌ Lỗi: AgentHub yêu cầu Node.js >= 22 (Hiện tại: $(node -v 2>/dev/null || echo 'chưa cài đặt'))."
  exit 1
fi

cd "$ROOT_DIR"

MODE="${1:-service}"

show_help() {
  echo "Cách dùng: $0 [tùy_chọn]"
  echo ""
  echo "Tùy chọn:"
  echo "  (không truyền) / --service   Build và chạy nền qua Systemd User Service (Khuyến nghị Production)"
  echo "  -f, --foreground            Build và chạy Daemon trực tiếp ở tiền cảnh (Cho Docker/Debug)"
  echo "  -b, --build-only            Chỉ build mã nguồn (Backend & Frontend), không khởi chạy"
  echo "  -s, --status                Xem trạng thái dịch vụ Production hiện tại"
  echo "  --restart                   Khởi động lại dịch vụ Production"
  echo "  --stop                      Dừng dịch vụ Production"
  echo "  -h, --help                  Xem hướng dẫn này"
  echo ""
}

case "$MODE" in
  -h|--help)
    show_help
    exit 0
    ;;
  -s|--status)
    echo "=== Trạng thái Dịch vụ AgentHub Production ==="
    systemctl --user status agenthub --no-pager || true
    echo ""
    echo "=== Kiểm tra Health Endpoint ==="
    curl -s http://127.0.0.1:7700/health || echo "Daemon không phản hồi tại cổng 7700"
    echo ""
    exit 0
    ;;
  --restart)
    echo "🔄 Đang khởi động lại dịch vụ agenthub..."
    systemctl --user restart agenthub
    sleep 1
    systemctl --user status agenthub --no-pager
    exit 0
    ;;
  --stop)
    echo "🛑 Đang dừng dịch vụ agenthub..."
    systemctl --user stop agenthub
    echo "✓ Dịch vụ đã dừng."
    exit 0
    ;;
esac

echo "=========================================================="
echo "  📦 Bắt đầu Đóng gói (Build) Production - AgentHub"
echo "  Node: $(node -v) | NPM: $(npm -v)"
echo "=========================================================="

# 2. Cài đặt dependencies nếu thiếu
if [ ! -d "node_modules" ] || [ ! -d "web/node_modules" ]; then
  echo "📦 Cài đặt dependencies sạch..."
  [ ! -d "node_modules" ] && npm ci
  [ ! -d "web/node_modules" ] && npm --prefix web ci
fi

# 3. Biên dịch Backend và Frontend
echo "🔨 [1/2] Biên dịch TypeScript Backend (src/ -> dist/)..."
npm run build

echo "🔨 [2/2] Đóng gói giao diện Web (web/ -> dist/web/)..."
npm run build:web

# 4. Tạo symlink agenthub vào ~/.local/bin
echo "🔗 Cập nhật CLI symlink (~/.local/bin/agenthub)..."
node dist/cli.js link >/dev/null 2>&1 || true

echo "✓ Đã đóng gói xong bản build Production thành công!"

if [ "$MODE" = "-b" ] || [ "$MODE" = "--build-only" ]; then
  echo "🎉 Hoàn tất build! (Chế độ --build-only)."
  exit 0
fi

# 5. Khởi chạy Production
if [ "$MODE" = "-f" ] || [ "$MODE" = "--foreground" ]; then
  echo "=========================================================="
  echo "  🚀 Khởi chạy AgentHub Daemon ở chế độ Tiền cảnh (Foreground)"
  echo "=========================================================="
  exec node dist/cli.js daemon
else
  echo "=========================================================="
  echo "  🚀 Kích hoạt Dịch vụ Nền Production (Systemd User Service)"
  echo "=========================================================="
  
  # Cài đặt hoặc cập nhật service file
  node dist/cli.js install-service >/dev/null 2>&1 || true

  # Kích hoạt linger để service chạy 24/7 kể cả khi logout
  loginctl enable-linger "$USER" 2>/dev/null || true

  # Nạp lại và khởi động service
  systemctl --user daemon-reload
  systemctl --user restart agenthub
  sleep 1

  if systemctl --user is-active --quiet agenthub; then
    echo "  ✅ Dịch vụ AgentHub đang chạy nền thành công!"
    echo "  ► Kiểm tra trạng thái: systemctl --user status agenthub"
    echo "  ► Theo dõi log:         journalctl --user -u agenthub -f"
    echo ""
    TOKEN_FILE="$HOME/.agenthub/token"
    if [ -f "$TOKEN_FILE" ]; then
      TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null || true)
      echo "  ► Mở Web Dashboard:    http://127.0.0.1:7700/#token=$TOKEN"
    fi
    echo "  (Hoặc chạy lệnh 'agenthub open' để tự mở trình duyệt)"
  else
    echo "  ❌ Cảnh báo: Service chưa khởi động thành công. Xem log lỗi:"
    systemctl --user status agenthub --no-pager || true
    journalctl --user -u agenthub -n 15 --no-pager || true
  fi
  echo "=========================================================="
fi
