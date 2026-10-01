#!/bin/sh
# Packages the built executable into a minimal .app bundle.
#
# Running the raw SwiftPM executable directly (`swift run` / the binary in
# .build/) has no CFBundleIdentifier, which AppKit logs as "missing main
# bundle identifier" — NSStatusItem registration with Control Center can
# silently fail to render an icon without one. Wrapping it in a real .app
# bundle fixes that.
set -e

cd "$(dirname "$0")"

# Build with the full Xcode toolchain when the active developer directory is
# CommandLineTools: a CommandLineTools build linked against an older SDK
# produced a Settings window whose text fields rendered empty. An explicit
# DEVELOPER_DIR from the caller always wins.
if [ -z "$DEVELOPER_DIR" ] && xcode-select -p 2>/dev/null | grep -q CommandLineTools \
  && [ -d /Applications/Xcode.app/Contents/Developer ]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
  echo "Using Xcode toolchain: $DEVELOPER_DIR"
fi

CONFIGURATION="${1:-release}"

swift build -c "$CONFIGURATION"
BIN_PATH=$(swift build -c "$CONFIGURATION" --show-bin-path)/WorkTrackerTracker

APP_DIR="dist/WorkTrackerTracker.app"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"

cp "$BIN_PATH" "$APP_DIR/Contents/MacOS/WorkTrackerTracker"
cp Info.plist "$APP_DIR/Contents/Info.plist"

echo "Built $APP_DIR"
echo "Run with: open $APP_DIR"
