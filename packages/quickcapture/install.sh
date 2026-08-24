#!/usr/bin/env bash
# Builds BottyQuick.app (the global quick-capture panel) and installs it to
# $BOTTY_DATA_DIR/BottyQuick.app (default ~/.botty), ad-hoc signed, then
# launches it. Mirrors the setup:notifier story (agent/src/tools/setup-notifier.ts).
#
#   npm run setup -w @botty/quickcapture     # build + install + launch
#   ./install.sh --no-launch                 # build + install only
#   ./install.sh --build-only /out/dir       # compile bundle to a dir, don't install
set -euo pipefail
cd "$(dirname "$0")"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "macOS only" >&2
  exit 1
fi

DATA_DIR="${BOTTY_DATA_DIR:-$HOME/.botty}"
APP_NAME="BottyQuick.app"
DEST="$DATA_DIR/$APP_NAME"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
APP="$STAGE/$APP_NAME"
mkdir -p "$APP/Contents/MacOS"

echo "compiling QuickCapture.swift…"
swiftc -O QuickCapture.swift -o "$APP/Contents/MacOS/BottyQuick"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>BottyQuick</string>
  <key>CFBundleIdentifier</key><string>io.maxolabs.botty.quickcapture</string>
  <key>CFBundleName</key><string>Botty Quick</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

codesign -f -s - "$APP"

if [[ "${1:-}" == "--build-only" ]]; then
  OUT="${2:?usage: install.sh --build-only <out-dir>}"
  mkdir -p "$OUT"
  rm -rf "$OUT/$APP_NAME"
  mv "$APP" "$OUT/$APP_NAME"
  echo "built $OUT/$APP_NAME (not installed)"
  exit 0
fi

# Replace any running instance (the binary is named BottyQuick; nothing else matches).
pkill -x BottyQuick 2>/dev/null || true
mkdir -p "$DATA_DIR"
rm -rf "$DEST"
mv "$APP" "$DEST"
echo "installed $DEST"

if [[ "${1:-}" != "--no-launch" ]]; then
  open "$DEST"
  echo "launched — look for the ✳ sparkles icon in the menu bar."
fi

cat <<'EOF'

Hotkeys:
  ⌥Space      works immediately (no permissions).
  ⌥⌥ (double) needs Accessibility: menu-bar icon → "Enable double-⌥ hotkey…",
              then allow "Botty Quick" in System Settings → Privacy & Security
              → Accessibility. (Re-grant after reinstalling — the ad-hoc
              signature changes on every build.)

Whatever you type is sent to botty chat (POST /api/chat/message on :4820) —
"remind me to…" becomes a task or a timed reminder via the usual chat tools.
EOF
