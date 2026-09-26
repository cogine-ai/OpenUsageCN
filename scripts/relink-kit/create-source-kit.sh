#!/usr/bin/env bash
set -euo pipefail
export COPYFILE_DISABLE=1

if [[ $# -ne 5 ]]; then
  echo "Usage: $0 BUN_SOURCE WEBKIT_SOURCE TINYCC_SOURCE RELEASE_CHECKOUT OUTPUT_TAR_GZ" >&2
  exit 1
fi

BUN_SOURCE=$(cd "$1" && pwd)
WEBKIT_SOURCE=$(cd "$2" && pwd)
TINYCC_SOURCE=$(cd "$3" && pwd)
RELEASE_CHECKOUT=$(cd "$4" && pwd)
OUTPUT_TAR_GZ=$5
STAGING="${OUTPUT_TAR_GZ%.tar.gz}.staging"
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

if [[ "$OUTPUT_TAR_GZ" == "$STAGING" || -e "$OUTPUT_TAR_GZ" || -e "$STAGING" ]]; then
  echo "Use a new .tar.gz output path and an unused staging path." >&2
  exit 1
fi

check_commit() {
  if [[ "$(git -C "$1" rev-parse HEAD)" != "$2" ]]; then
    echo "Source checkout has an unexpected commit: $1" >&2
    exit 1
  fi
}
check_commit "$BUN_SOURCE" d530ed993d62be7c7f8f01a3d52627b6845dfd93
check_commit "$WEBKIT_SOURCE" 1d0216219a3c52cb85195f48f19ba7d5db747ff7
if [[ "$(cat "$TINYCC_SOURCE/.ref")" != "29985a3b59898861442fa3b43f663fc1af2591d7" ]]; then
  echo "TinyCC source checkout has an unexpected revision." >&2
  exit 1
fi
if [[ "$(shasum -a 256 "$SCRIPT_DIR/modified-jsc.patch" | cut -d ' ' -f 1)" != \
  "c483d8f7d0fb1eba7eb1e06833ca533e9849dcfea0eb69b1f792b4ce04c26136" ]]; then
  echo "The test patch is not the reviewed JavaScriptCore Date.now() change." >&2
  exit 1
fi
WEBKIT_STATUS=$(git -C "$WEBKIT_SOURCE" status --short)
if [[ -n "$WEBKIT_STATUS" && "$WEBKIT_STATUS" != \
  " M Source/JavaScriptCore/runtime/DateConstructor.cpp" ]]; then
  echo "The WebKit checkout contains unexpected changes." >&2
  exit 1
fi
if [[ "$(shasum -a 256 "$SCRIPT_DIR/../../LICENSES/JavaScriptCore-LGPL-2.0.txt" | cut -d ' ' -f 1)" != \
  "$(git -C "$WEBKIT_SOURCE" show HEAD:Source/JavaScriptCore/COPYING.LIB | shasum -a 256 | cut -d ' ' -f 1)" ]]; then
  echo "WebKit source license does not match the bundled license." >&2
  exit 1
fi

mkdir -p "$STAGING/kit/Bun/vendor" "$STAGING/kit/WebKit" \
  "$STAGING/kit/OpenUsage/node_modules/@steipete" "$STAGING/kit/proof"

git -C "$BUN_SOURCE" archive --format=tar -o "$STAGING/bun.tar" HEAD
tar -xf "$STAGING/bun.tar" -C "$STAGING/kit/Bun"
trash "$STAGING/bun.tar"
git -C "$STAGING/kit/Bun" init -q
git -C "$STAGING/kit/Bun" fetch --quiet --no-tags --depth=1 \
  "file://$BUN_SOURCE" d530ed993d62be7c7f8f01a3d52627b6845dfd93
git -C "$STAGING/kit/Bun" update-ref refs/heads/relink FETCH_HEAD
git -C "$STAGING/kit/Bun" symbolic-ref HEAD refs/heads/relink
git -C "$STAGING/kit/Bun" reset --mixed -q HEAD
trash "$STAGING/kit/Bun/.git/FETCH_HEAD" "$STAGING/kit/Bun/.git/ORIG_HEAD" \
  "$STAGING/kit/Bun/.git/logs" \
  "$STAGING/kit/Bun/.git/hooks" "$STAGING/kit/Bun/.git/description" \
  "$STAGING/kit/Bun/.git/info"
git -C "$STAGING/kit/Bun" apply "$SCRIPT_DIR/bun-use-bundled-vendor.patch"
# This sparse WebKit checkout uses a partial clone. Copy present tracked files
# only; git archive would fetch omitted blobs and cp -R would include local caches.
git -C "$WEBKIT_SOURCE" ls-files -z \
  | python3 -c '
import os
import sys
root = os.fsencode(sys.argv[1])
for path in sys.stdin.buffer.read().split(b"\0"):
    if path and os.path.lexists(os.path.join(root, path)):
        sys.stdout.buffer.write(path + b"\0")
' "$WEBKIT_SOURCE" > "$STAGING/webkit-files.list"
tar -C "$WEBKIT_SOURCE" --null -T "$STAGING/webkit-files.list" \
  -cf "$STAGING/webkit.tar"
tar -xf "$STAGING/webkit.tar" -C "$STAGING/kit/WebKit"
trash "$STAGING/webkit-files.list" "$STAGING/webkit.tar"
git -C "$WEBKIT_SOURCE" show HEAD:Source/JavaScriptCore/runtime/DateConstructor.cpp \
  > "$STAGING/kit/WebKit/Source/JavaScriptCore/runtime/DateConstructor.cpp"

# Bun tracks vendor revisions in CMake. Include the exact checked-out sources
# used by the relink proof. The kit's CMake patch keeps these sources in place
# when building, including after recipients edit them. Zig is a platform-specific
# compiler that Bun fetches for the recipient's architecture when built.
for vendor_dir in "$BUN_SOURCE"/vendor/*; do
  case "${vendor_dir##*/}" in
    WebKit|zig) continue ;;
    *) cp -R "$vendor_dir" "$STAGING/kit/Bun/vendor/" ;;
  esac
done
cp -R "$TINYCC_SOURCE" "$STAGING/kit/TinyCC"
cp "$RELEASE_CHECKOUT/package.json" "$RELEASE_CHECKOUT/bun.lock" "$STAGING/kit/OpenUsage/"
mkdir -p "$STAGING/kit/OpenUsage/tools/cookie-helper"
cp "$RELEASE_CHECKOUT"/tools/cookie-helper/*.mjs "$STAGING/kit/OpenUsage/tools/cookie-helper/"
cp -R "$RELEASE_CHECKOUT/node_modules/@steipete/sweet-cookie" \
  "$STAGING/kit/OpenUsage/node_modules/@steipete/"
cp "$SCRIPT_DIR/README.md" "$STAGING/kit/README.md"
cp "$SCRIPT_DIR/relink.sh" "$STAGING/kit/relink.sh"
cp "$SCRIPT_DIR/probe-date.mjs" "$STAGING/kit/proof/probe-date.mjs"
cp "$SCRIPT_DIR/../../LICENSES/JavaScriptCore-LGPL-2.0.txt" \
  "$STAGING/kit/JavaScriptCore-LGPL-2.0.txt"
cp "$SCRIPT_DIR/../../LICENSES/TinyCC-LGPL-2.1.txt" \
  "$STAGING/kit/TinyCC-LGPL-2.1.txt"
cp "$SCRIPT_DIR/modified-jsc.patch" "$STAGING/kit/proof/modified-jsc.patch"
cp "$SCRIPT_DIR/bun-use-bundled-vendor.patch" "$STAGING/kit/proof/bun-use-bundled-vendor.patch"

tar -czf "$OUTPUT_TAR_GZ" -C "$STAGING" kit
echo "Source kit: $OUTPUT_TAR_GZ"
shasum -a 256 "$OUTPUT_TAR_GZ"
