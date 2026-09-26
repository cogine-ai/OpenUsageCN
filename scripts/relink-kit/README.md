# Cookie Helper Relink Kit

This kit accompanies one OpenUsageCN release containing the macOS Cookie Helper.
It contains the pinned Bun, WebKit, and TinyCC sources, the exact OpenUsage
Cookie Helper source and dependency, both LGPL license texts, and a build script.
The Bun source includes its pinned Git metadata. The included Bun CMake patch
uses the bundled dependency sources, so editing TinyCC in `Bun/vendor/tinycc/`
is reflected in the relinked Helper. Zig is downloaded for the target Mac.

Use an arm64 or x86_64 Mac with Xcode Command Line Tools, Homebrew LLVM 22.1.7
(`llvm@22`), CMake, Ninja, Python 3, rustup, and Bun 1.3.6 revision `d530ed993`.
Rustup installs the nightly toolchain pinned by Bun. The Bun and WebKit source revisions
are recorded in the release manifest. The script writes each run to a new
`build/` directory.

To modify JavaScriptCore and relink the Helper:

1. Edit the source under `WebKit/Source/JavaScriptCore/`.
2. Run `./relink.sh` from this directory.
3. Use the new `build/<run name>/openusage-cookie-helper` executable. The script
   runs its protocol smoke test and prints the new binary hashes.

To repeat the release's observable test in a fresh extraction of the kit, run:

```sh
cd WebKit
git apply ../proof/modified-jsc.patch
cd ..
RELINK_EXPECT_DATE_NOW=42424242 ./relink.sh
```

The patch changes `Date.now()` only for the test. The published application
does not contain this modification. On macOS 26 with Zig 0.15.2, the full Xcode
SDK may fail to link Zig's build runner. If the Command Line Tools SDK is
installed, set `RELINK_BUN_DEVELOPER_DIR=/Library/Developer/CommandLineTools`
for that run. The release proof records the toolchain actually used on each Mac.
On Intel, the script disables Highway's AVX-512 targets rejected by LLVM 22.
The x86_64 release proof
was cross-built on Apple Silicon and run under Rosetta; this script has not yet
been executed on a native Intel Mac.
