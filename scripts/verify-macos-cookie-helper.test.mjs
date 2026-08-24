import assert from "node:assert/strict"
import test from "node:test"

import {
  inspectMachO,
  verifyExactJitEntitlements,
} from "./verify-macos-cookie-helper.mjs"

const CPU_TYPES = {
  "aarch64-apple-darwin": 0x0100000c,
  "x86_64-apple-darwin": 0x01000007,
}

function machOFixture(targetTriple, minimumVersion) {
  const buffer = Buffer.alloc(64)
  buffer.writeUInt32LE(0xfeedfacf, 0)
  buffer.writeUInt32LE(CPU_TYPES[targetTriple], 4)
  buffer.writeUInt32LE(2, 16)
  buffer.writeUInt32LE(32, 20)

  buffer.writeUInt32LE(0x19, 32)
  buffer.writeUInt32LE(8, 36)
  buffer.writeUInt32LE(0x32, 40)
  buffer.writeUInt32LE(24, 44)
  buffer.writeUInt32LE(1, 48)
  const [major, minor, patch] = minimumVersion.split(".").map(Number)
  buffer.writeUInt32LE((major << 16) | (minor << 8) | patch, 52)
  return buffer
}

test("Mach-O inspection binds each helper to its exact architecture and macOS 13", () => {
  assert.deepEqual(
    inspectMachO(machOFixture("aarch64-apple-darwin", "13.0.0")),
    { architecture: "arm64", minimumSystemVersion: "13.0.0" },
  )
  assert.deepEqual(
    inspectMachO(machOFixture("x86_64-apple-darwin", "13.0.0")),
    { architecture: "x86_64", minimumSystemVersion: "13.0.0" },
  )
})

test("Mach-O inspection rejects non-Mach-O and missing deployment metadata", () => {
  assert.throws(() => inspectMachO(Buffer.alloc(64)), /64-bit little-endian Mach-O/)
  const missingMinimum = machOFixture("aarch64-apple-darwin", "13.0.0")
  missingMinimum.writeUInt32LE(0x19, 40)
  assert.throws(() => inspectMachO(missingMinimum), /deployment target/)
})

test("packaged app and helper must have exactly the narrow JIT entitlement", () => {
  const exact = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
</dict></plist>`
  assert.doesNotThrow(() => verifyExactJitEntitlements(exact, "main app"))

  const broad = exact.replace(
    "</dict>",
    "<key>com.apple.security.cs.disable-library-validation</key><true/></dict>",
  )
  assert.throws(
    () => verifyExactJitEntitlements(broad, "main app"),
    /main app has unexpected entitlement com\.apple\.security\.cs\.disable-library-validation/,
  )
  assert.throws(
    () =>
      verifyExactJitEntitlements(
        exact.replace("<true/>", "<false/>"),
        "cookie helper",
      ),
    /cookie helper must enable com\.apple\.security\.cs\.allow-jit/,
  )
})
