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

CONFIGURATION="${1:-release}"
BIN_PATH=".build/$(swift build -c "$CONFIGURATION" --show-bin-path 2>/dev/null | tail -1)/WorkTrackerTracker"
BIN_PATH=$(swift build -c "$CONFIGURATION" --show-bin-path)/WorkTrackerTracker

swift build -c "$CONFIGURATION"

APP_DIR="dist/WorkTrackerTracker.app"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"

cp "$BIN_PATH" "$APP_DIR/Contents/MacOS/WorkTrackerTracker"
cp Info.plist "$APP_DIR/Contents/Info.plist"

echo "Built $APP_DIR"
echo "Run with: open $APP_DIR"
