#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RN_CLI="$ROOT_DIR/node_modules/.bin/react-native"

if [ ! -x "$RN_CLI" ]; then
  echo "react-native CLI not found at $RN_CLI"
  exit 1
fi

if ! command -v adb >/dev/null 2>&1; then
  exec "$RN_CLI" run-android "$@"
fi

DEVICE_ID="${ANDROID_SERIAL:-}"
if [ -z "$DEVICE_ID" ]; then
  DEVICE_ID="$(adb devices | awk 'NR > 1 && $2 == "device" { print $1; exit }')"
fi

if [ -z "$DEVICE_ID" ]; then
  exec "$RN_CLI" run-android "$@"
fi

echo "Waiting for Android device $DEVICE_ID to finish booting..."
adb -s "$DEVICE_ID" wait-for-device >/dev/null

BOOT_COMPLETED=""
SDK_LEVEL=""
for _ in $(seq 1 60); do
  BOOT_COMPLETED="$(adb -s "$DEVICE_ID" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')"
  SDK_LEVEL="$(adb -s "$DEVICE_ID" shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r')"

  if [ "$BOOT_COMPLETED" = "1" ] && [ -n "$SDK_LEVEL" ]; then
    break
  fi

  sleep 2
done

if [ "$BOOT_COMPLETED" != "1" ] || [ -z "$SDK_LEVEL" ]; then
  echo "Android device $DEVICE_ID did not become responsive in time."
  exit 1
fi

exec "$RN_CLI" run-android --deviceId "$DEVICE_ID" "$@"
