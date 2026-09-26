#!/usr/bin/env bash
set -euo pipefail

KIT_ROOT=$(cd "$(dirname "$0")" && pwd)
RUN_NAME=${RELINK_RUN_NAME:-$(date -u +%Y%m%dT%H%M%SZ)}
OUTPUT="$KIT_ROOT/build/$RUN_NAME"

if [[ -e "$OUTPUT" ]]; then
  echo "Choose a new RELINK_RUN_NAME; build directory already exists: $OUTPUT" >&2
  exit 1
fi

case "$(uname -m)" in
  arm64)
    PACKAGE_JSON_ARCH=arm64
    TARGET=aarch64-apple-darwin
    BUN_CXX_FLAGS='-Wno-error=dangling-assignment-gsl -Wno-error=character-conversion -Wno-error=dangling-assignment -Wno-error=dangling -D_LIBCPP_VERBOSE_ABORT_NOEXCEPT=noexcept'
    ;;
  x86_64)
    PACKAGE_JSON_ARCH=x64
    TARGET=x86_64-apple-darwin
    BUN_CXX_FLAGS='-Wno-error=dangling-assignment-gsl -Wno-error=character-conversion -Wno-error=dangling-assignment -Wno-error=dangling -D_LIBCPP_VERBOSE_ABORT_NOEXCEPT=noexcept -DHWY_DISABLED_TARGETS=472'
    ;;
  *)
    echo "Relinking requires macOS arm64 or x86_64." >&2
    exit 1
    ;;
esac

LLVM_BIN="$(brew --prefix llvm@22)/bin"
BOOTSTRAP_BUN=${RELINK_BOOTSTRAP_BUN:-$(command -v bun)}
if [[ "$("$LLVM_BIN/clang" --version | head -1)" != *"22.1.7"* ]]; then
  echo "The relink kit requires Homebrew LLVM 22.1.7." >&2
  exit 1
fi
if [[ ! -x "$BOOTSTRAP_BUN" ]]; then
  echo "Missing Bun bootstrap executable: $BOOTSTRAP_BUN" >&2
  exit 1
fi
if [[ "$("$BOOTSTRAP_BUN" --revision)" != "1.3.6+d530ed993" ]]; then
  echo "The bootstrap Bun must be revision 1.3.6+d530ed993." >&2
  exit 1
fi

mkdir -p "$OUTPUT/webkit"
export PATH="$LLVM_BIN:$PATH"
export CMAKE_C_COMPILER="$LLVM_BIN/clang"
export CMAKE_CXX_COMPILER="$LLVM_BIN/clang++"
export AR="$LLVM_BIN/llvm-ar"
export RANLIB="$LLVM_BIN/llvm-ranlib"
export RUNNER_TEMP="$OUTPUT/webkit"
export PACKAGE_JSON_ARCH
export CMAKE_OSX_DEPLOYMENT_TARGET=13.0

(
  export GITHUB_REPOSITORY=oven-sh/WebKit
  export GITHUB_SHA=1d0216219a3c52cb85195f48f19ba7d5db747ff7
  if [[ -n "${RELINK_WEBKIT_DEVELOPER_DIR:-}" ]]; then
    export DEVELOPER_DIR="$RELINK_WEBKIT_DEVELOPER_DIR"
  fi
  cd "$KIT_ROOT/WebKit"
  bash mac-release.bash
)

(
  export GITHUB_SHA=d530ed993d62be7c7f8f01a3d52627b6845dfd93
  if [[ -n "${RELINK_BUN_DEVELOPER_DIR:-}" ]]; then
    export DEVELOPER_DIR="$RELINK_BUN_DEVELOPER_DIR"
  fi
  cd "$KIT_ROOT/Bun"
  "$BOOTSTRAP_BUN" ./scripts/build.mjs \
    -GNinja \
    -DCMAKE_BUILD_TYPE=Release \
    -DENABLE_CANARY=OFF \
    -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 \
    -DREVISION=d530ed993d62be7c7f8f01a3d52627b6845dfd93 \
    "-DCMAKE_CXX_FLAGS=$BUN_CXX_FLAGS" \
    -DLLVM_VERSION=22.1.7 \
    "-DWEBKIT_PATH=$OUTPUT/webkit/bun-webkit" \
    -B "$OUTPUT/bun-build"
)

SOURCE_BUN="$OUTPUT/bun-build/bun"
"$SOURCE_BUN" build "$KIT_ROOT/OpenUsage/tools/cookie-helper/index.mjs" \
  --compile --minify --outfile="$OUTPUT/openusage-cookie-helper"
"$SOURCE_BUN" build "$KIT_ROOT/proof/probe-date.mjs" \
  --compile --outfile="$OUTPUT/probe-date-standalone"

PROBE_OUTPUT=$("$OUTPUT/probe-date-standalone")
if [[ -n "${RELINK_EXPECT_DATE_NOW:-}" && "$PROBE_OUTPUT" != "$RELINK_EXPECT_DATE_NOW" ]]; then
  echo "Modified JavaScriptCore was not observed in the standalone program: $PROBE_OUTPUT" >&2
  exit 1
fi
echo "Standalone Date.now(): $PROBE_OUTPUT"

printf '%s\n' '{"version":2,"operation":"ListProfiles","browser":"Chrome"}' \
  | "$OUTPUT/openusage-cookie-helper" \
  | python3 -c 'import json,sys; p=json.load(sys.stdin); assert p["version"] == 1 and p["operation"] == "ListProfiles" and p["ok"] is False and p["error"]["code"] == "UnsupportedVersion"'

echo "Relinked $TARGET Cookie Helper and passed its protocol smoke test."
shasum -a 256 "$SOURCE_BUN" "$OUTPUT/openusage-cookie-helper" "$OUTPUT/probe-date-standalone"
echo "Build outputs: $OUTPUT"
