#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PROXY_DIR="$PROJECT_DIR/proxy"
OUT_DIR="$PROJECT_DIR/src-tauri/binaries"

mkdir -p "$OUT_DIR"

# 用法：bash build-proxy.sh [all|current|mac|mac-arm|mac-intel|windows|linux]
TARGET="${1:-all}"

detect_current() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin)
      case "$arch" in
        arm64) echo "mac-arm" ;;
        x86_64) echo "mac-intel" ;;
      esac
      ;;
    Linux) echo "linux" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
  esac
}

CURRENT="$(detect_current)"

if [ "$TARGET" = "current" ]; then
  if [ -z "$CURRENT" ]; then
    echo "Cannot detect current platform (uname -s: $(uname -s), -m: $(uname -m))"
    exit 1
  fi
  TARGET="$CURRENT"
fi

TARGETS=()
case "$TARGET" in
  all)        TARGETS=(mac-arm mac-intel windows linux) ;;
  mac)        TARGETS=(mac-arm mac-intel) ;;
  mac-arm|mac-intel|windows|linux) TARGETS=("$TARGET") ;;
  *)
    echo "Unknown target: $TARGET"
    echo "Usage: $0 [all|current|mac|mac-arm|mac-intel|windows|linux]"
    exit 1
    ;;
esac

echo "Installing proxy dependencies..."
cd "$PROXY_DIR" && bun install

build_one() {
  local target="$1"
  case "$target" in
    mac-arm)
      echo "  → bun-darwin-arm64"
      bun build --compile --target=bun-darwin-arm64 proxy-server.js --outfile "$OUT_DIR/proxy-server-aarch64-apple-darwin"
      ;;
    mac-intel)
      echo "  → bun-darwin-x64"
      bun build --compile --target=bun-darwin-x64 proxy-server.js --outfile "$OUT_DIR/proxy-server-x86_64-apple-darwin"
      ;;
    windows)
      echo "  → bun-windows-x64"
      bun build --compile --target=bun-windows-x64 proxy-server.js --outfile "$OUT_DIR/proxy-server-x86_64-pc-windows-msvc.exe"
      ;;
    linux)
      echo "  → bun-linux-x64"
      bun build --compile --target=bun-linux-x64 proxy-server.js --outfile "$OUT_DIR/proxy-server-x86_64-unknown-linux-gnu"
      ;;
  esac
}

echo "Building proxy-server: ${TARGETS[*]}"
cd "$PROXY_DIR"
for t in "${TARGETS[@]}"; do
  build_one "$t"
done

# 为 Tauri dev 模式准备 bare "proxy-server"：复制当前主机平台对应的二进制
# 只有当目标列表里包含当前主机平台时才复制，避免在交叉编译场景下错误覆盖
if [ -n "$CURRENT" ] && printf '%s\n' "${TARGETS[@]}" | grep -qx "$CURRENT"; then
  case "$CURRENT" in
    mac-arm)   SRC="$OUT_DIR/proxy-server-aarch64-apple-darwin"; DEST="$OUT_DIR/proxy-server" ;;
    mac-intel) SRC="$OUT_DIR/proxy-server-x86_64-apple-darwin"; DEST="$OUT_DIR/proxy-server" ;;
    linux)     SRC="$OUT_DIR/proxy-server-x86_64-unknown-linux-gnu"; DEST="$OUT_DIR/proxy-server" ;;
    windows)   SRC="$OUT_DIR/proxy-server-x86_64-pc-windows-msvc.exe"; DEST="$OUT_DIR/proxy-server.exe" ;;
  esac
  if [ -f "$SRC" ]; then
    cp "$SRC" "$DEST"
    echo "  → copied $(basename "$SRC") to $(basename "$DEST") for Tauri dev"
  fi
fi

echo "Done! Binaries in $OUT_DIR"
ls -la "$OUT_DIR"
