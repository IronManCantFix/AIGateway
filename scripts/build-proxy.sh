#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PROXY_DIR="$PROJECT_DIR/proxy"
OUT_DIR="$PROJECT_DIR/src-tauri/binaries"

mkdir -p "$OUT_DIR"

echo "Building proxy-server for all platforms..."

# macOS ARM
echo "  → bun-darwin-arm64"
cd "$PROXY_DIR" && bun build --compile --target=bun-darwin-arm64 proxy-server.js --outfile "$OUT_DIR/proxy-server-aarch64-apple-darwin"

# macOS Intel
echo "  → bun-darwin-x64"
cd "$PROXY_DIR" && bun build --compile --target=bun-darwin-x64 proxy-server.js --outfile "$OUT_DIR/proxy-server-x86_64-apple-darwin"

# Windows
echo "  → bun-windows-x64"
cd "$PROXY_DIR" && bun build --compile --target=bun-windows-x64 proxy-server.js --outfile "$OUT_DIR/proxy-server-x86_64-pc-windows-msvc.exe"

# Linux
echo "  → bun-linux-x64"
cd "$PROXY_DIR" && bun build --compile --target=bun-linux-x64 proxy-server.js --outfile "$OUT_DIR/proxy-server-x86_64-unknown-linux-gnu"

echo "Done! Binaries in $OUT_DIR"
ls -la "$OUT_DIR"
