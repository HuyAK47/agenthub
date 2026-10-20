#!/bin/sh
set -e

# ==============================================================================
# AgentHub Installer (POSIX sh, Linux + macOS)
# ==============================================================================

AGENTHUB_DIR="${AGENTHUB_DIR:-$HOME/.agenthub-app}"
AGENTHUB_DATA_DIR="${AGENTHUB_HOME:-$HOME/.agenthub}"
AGENTHUB_REPO="${AGENTHUB_REPO:-https://github.com/ducanh19020217/agenthub.git}"
AGENTHUB_LINK_DIR="${AGENTHUB_LINK_DIR:-$HOME/.local/bin}"

# Helper: Prompt Yes/No
prompt_yes_no() {
  _question="$1"
  _default="$2" # y or n
  _ans=""
  if [ "$_default" = "y" ]; then
    _prompt="[Y/n]"
  else
    _prompt="[y/N]"
  fi

  if [ -t 0 ]; then
    printf "%s %s: " "$_question" "$_prompt"
    read -r _ans
  elif [ -e /dev/tty ]; then
    printf "%s %s: " "$_question" "$_prompt" >/dev/tty
    read -r _ans </dev/tty
  else
    if [ "$_default" = "y" ]; then
      return 0
    else
      return 1
    fi
  fi

  if [ -z "$_ans" ]; then
    if [ "$_default" = "y" ]; then
      return 0
    else
      return 1
    fi
  fi

  case "$_ans" in
    y*|Y*) return 0 ;;
    *) return 1 ;;
  esac
}

# Helper: Check if Node >= 22
node_is_v22_or_higher() {
  if ! command -v node >/dev/null 2>&1; then
    return 1
  fi
  _v="$(node -v 2>/dev/null | tr -d 'v')"
  _major="$(echo "$_v" | cut -d. -f1)"
  if [ -n "$_major" ] && [ "$_major" -ge 22 ] 2>/dev/null; then
    return 0
  fi
  return 1
}

# ------------------------------------------------------------------------------
# Argument Parsing
# ------------------------------------------------------------------------------
UNINSTALL=0
PURGE=0

for arg in "$@"; do
  case "$arg" in
    --uninstall)
      UNINSTALL=1
      ;;
    --purge)
      PURGE=1
      ;;
    --help|-h)
      echo "AgentHub Installer"
      echo ""
      echo "Cách dùng:"
      echo "  ./scripts/install.sh                      Cài đặt hoặc cập nhật AgentHub"
      echo "  ./scripts/install.sh --uninstall          Gỡ service, symlink và app (giữ dữ liệu)"
      echo "  ./scripts/install.sh --uninstall --purge  Gỡ cài đặt và xoá sạch dữ liệu (hỏi xác nhận)"
      echo ""
      echo "Biến môi trường:"
      echo "  AGENTHUB_DIR       Thư mục clone mã nguồn (mặc định: ~/.agenthub-app)"
      echo "  AGENTHUB_HOME      Thư mục lưu trữ dữ liệu (mặc định: ~/.agenthub)"
      echo "  AGENTHUB_REPO      URL git repository (mặc định: GitHub chính thức)"
      exit 0
      ;;
  esac
done

# ------------------------------------------------------------------------------
# Handle --uninstall
# ------------------------------------------------------------------------------
if [ "$UNINSTALL" = "1" ]; then
  echo "==> Đang gỡ bỏ AgentHub..."

  # 1. Gỡ service theo nền tảng
  OS="$(uname -s)"
  case "$OS" in
    Darwin*)
      UID_NUM="$(id -u)"
      PLIST_FILE="$HOME/Library/LaunchAgents/dev.agenthub.plist"
      if [ -f "$PLIST_FILE" ]; then
        launchctl bootout "gui/$UID_NUM/dev.agenthub" 2>/dev/null || launchctl bootout "gui/$UID_NUM" "$PLIST_FILE" 2>/dev/null || true
        rm -f "$PLIST_FILE"
        echo "✓ Đã gỡ LaunchAgent dev.agenthub"
      fi
      ;;
    Linux*)
      SERVICE_FILE="$HOME/.config/systemd/user/agenthub.service"
      if [ -f "$SERVICE_FILE" ] || command -v systemctl >/dev/null 2>&1; then
        systemctl --user stop agenthub 2>/dev/null || true
        systemctl --user disable agenthub 2>/dev/null || true
        rm -f "$SERVICE_FILE"
        systemctl --user daemon-reload 2>/dev/null || true
        echo "✓ Đã gỡ systemd user service agenthub"
      fi
      ;;
  esac

  # 2. Gỡ symlink
  LINK_FILE="$AGENTHUB_LINK_DIR/agenthub"
  if [ -L "$LINK_FILE" ] || [ -f "$LINK_FILE" ]; then
    rm -f "$LINK_FILE"
    echo "✓ Đã xoá symlink: $LINK_FILE"
  fi

  # 3. Gỡ thư mục mã nguồn app
  if [ -d "$AGENTHUB_DIR" ]; then
    rm -rf "$AGENTHUB_DIR"
    echo "✓ Đã xoá thư mục ứng dụng: $AGENTHUB_DIR"
  fi

  # 4. Xử lý dữ liệu ~/.agenthub
  if [ "$PURGE" = "1" ]; then
    echo "CẢNH BÁO: Bạn đã chọn cờ --purge."
    echo "Thao tác này sẽ xoá TOÀN BỘ dữ liệu cấu hình, task, và database tại: $AGENTHUB_DATA_DIR"
    if prompt_yes_no "Bạn có chắc chắn muốn xoá toàn bộ dữ liệu AgentHub không?" "n"; then
      rm -rf "$AGENTHUB_DATA_DIR"
      echo "✓ Đã xoá toàn bộ dữ liệu tại: $AGENTHUB_DATA_DIR"
    else
      echo "Đã huỷ xoá dữ liệu. Dữ liệu tại $AGENTHUB_DATA_DIR vẫn được giữ nguyên."
    fi
  else
    echo "Dữ liệu cấu hình và task tại $AGENTHUB_DATA_DIR được giữ nguyên."
    echo "Nếu muốn xoá toàn bộ dữ liệu, chạy lại lệnh với cờ --purge:"
    echo "  install.sh --uninstall --purge"
  fi

  echo "✓ Hoàn tất gỡ cài đặt AgentHub."
  exit 0
fi

# ------------------------------------------------------------------------------
# Normal Installation / Update Flow
# ------------------------------------------------------------------------------
OS="$(uname -s)"
case "$OS" in
  Linux*|Darwin*) ;;
  *)
    echo "Lỗi: Hệ điều hành $OS chưa được hỗ trợ trực tiếp." >&2
    echo "AgentHub hỗ trợ Linux và macOS (hoặc WSL2 trên Windows)." >&2
    exit 1
    ;;
esac

echo "========================================="
echo " Cài đặt AgentHub"
echo " Thư mục ứng dụng : $AGENTHUB_DIR"
echo " Thư mục dữ liệu  : $AGENTHUB_DATA_DIR"
echo "========================================="

# 1. Kiểm tra / cài đặt Node 22 qua nvm nếu thiếu
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  nvm use 22 >/dev/null 2>&1 || true
fi

if ! node_is_v22_or_higher; then
  echo ""
  echo "AgentHub yêu cầu Node.js >= 22."

  # Kiểm tra xem nvm có sẵn không
  if ! command -v nvm >/dev/null 2>&1; then
    if prompt_yes_no "Không tìm thấy nvm. Bạn có muốn cài đặt nvm để quản lý Node 22 không?" "y"; then
      echo "==> Đang cài đặt nvm..."
      curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | sh
      export NVM_DIR="$HOME/.nvm"
      # shellcheck source=/dev/null
      [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
    else
      echo "Lỗi: Vui lòng cài đặt Node.js >= 22 trước khi tiếp tục." >&2
      exit 1
    fi
  fi

  if prompt_yes_no "Cài đặt Node 22 qua nvm ngay bây giờ?" "y"; then
    echo "==> Đang cài đặt Node 22 qua nvm..."
    nvm install 22
    nvm use 22
  else
    echo "Lỗi: Cần Node 22 để tiếp tục." >&2
    exit 1
  fi

  if ! node_is_v22_or_higher; then
    echo "Lỗi: Không tìm thấy Node.js >= 22 sau khi cài đặt." >&2
    exit 1
  fi
fi

echo "✓ Sử dụng Node.js $(node -v) (npm $(npm -v))"

# 2. Clone hoặc cập nhật vào AGENTHUB_DIR
if [ ! -d "$AGENTHUB_DIR" ]; then
  echo "==> Đang clone mã nguồn vào $AGENTHUB_DIR..."
  git clone "$AGENTHUB_REPO" "$AGENTHUB_DIR"
elif [ -d "$AGENTHUB_DIR/.git" ]; then
  echo "==> Cập nhật mã nguồn tại $AGENTHUB_DIR..."
  (
    cd "$AGENTHUB_DIR"
    git fetch --tags origin 2>/dev/null || git fetch --tags 2>/dev/null || true
    _LATEST_TAG="$(git tag -l --sort=-v:refname 2>/dev/null | head -n 1)"
    if [ -n "$_LATEST_TAG" ]; then
      git checkout "$_LATEST_TAG" 2>/dev/null || true
    else
      git pull 2>/dev/null || true
    fi
  )
else
  echo "==> Sử dụng thư mục mã nguồn: $AGENTHUB_DIR"
fi

# 3. npm ci + build + build:web
echo "==> Cài đặt dependencies và build..."
(
  cd "$AGENTHUB_DIR"
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    export NVM_DIR="$HOME/.nvm"
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"
    nvm use 22 >/dev/null 2>&1 || true
  fi
  npm ci
  if [ -f "web/package.json" ]; then
    npm --prefix web ci
  fi
  npm run build
  npm run build:web
)

# 4. agenthub link
echo "==> Thiết lập symlink binary CLI..."
"$AGENTHUB_DIR/bin/agenthub" link

case ":$PATH:" in
  *:"$AGENTHUB_LINK_DIR":*) ;;
  *)
    echo "! Lưu ý: $AGENTHUB_LINK_DIR chưa nằm trong PATH."
    echo "  Hãy thêm dòng sau vào ~/.bashrc hoặc ~/.zshrc:"
    echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
    ;;
esac

# 5. agenthub install-service
echo "==> Cài đặt service chạy nền..."
"$AGENTHUB_DIR/bin/agenthub" install-service

# 6. in URL dashboard
echo ""
echo "==> Web Dashboard URL:"
"$AGENTHUB_DIR/bin/agenthub" open --no-browser
echo ""
echo "================================================="
echo "✓ Cài đặt AgentHub thành công!"
echo "  Để mở Web Dashboard : agenthub open"
echo "  Để kiểm tra hệ thống: agenthub doctor"
echo "  Để cập nhật sau này : agenthub update"
echo "================================================="
