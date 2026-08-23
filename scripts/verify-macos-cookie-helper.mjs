import { spawnSync } from "node:child_process"
import { constants } from "node:fs"
import { access, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const MACHO_64_LITTLE_ENDIAN = 0xfeedfacf
const LC_VERSION_MIN_MACOSX = 0x24
const LC_BUILD_VERSION = 0x32
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"
const TARGETS = {
  "aarch64-apple-darwin": { architecture: "arm64", cpuType: 0x0100000c },
  "x86_64-apple-darwin": { architecture: "x86_64", cpuType: 0x01000007 },
}
const EXPECTED_MINIMUM = "13.0.0"
const REQUIRED_JIT_ENTITLEMENT = "com.apple.security.cs.allow-jit"
const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function checkedTarget(targetTriple) {
  const target = TARGETS[targetTriple]
  if (!target) {
    throw new Error(`Unsupported cookie helper target: ${targetTriple ?? "missing"}`)
  }
  return target
}

function packedVersion(value) {
  return `${value >>> 16}.${(value >>> 8) & 0xff}.${value & 0xff}`
}

export function inspectMachO(buffer) {
  if (buffer.length < 32 || buffer.readUInt32LE(0) !== MACHO_64_LITTLE_ENDIAN) {
    throw new Error("Cookie helper must be a thin 64-bit little-endian Mach-O executable.")
  }
  const cpuType = buffer.readUInt32LE(4)
  const target = Object.values(TARGETS).find((entry) => entry.cpuType === cpuType)
  if (!target) {
    throw new Error(`Cookie helper has an unsupported Mach-O CPU type: 0x${cpuType.toString(16)}.`)
  }

  const commandCount = buffer.readUInt32LE(16)
  const commandBytes = buffer.readUInt32LE(20)
  const commandsEnd = 32 + commandBytes
  if (commandsEnd > buffer.length) {
    throw new Error("Cookie helper has truncated Mach-O load commands.")
  }
  let offset = 32
  let minimumSystemVersion
  for (let index = 0; index < commandCount; index += 1) {
    if (offset + 8 > commandsEnd) {
      throw new Error("Cookie helper has malformed Mach-O load commands.")
    }
    const command = buffer.readUInt32LE(offset)
    const size = buffer.readUInt32LE(offset + 4)
    if (size < 8 || offset + size > commandsEnd) {
      throw new Error("Cookie helper has malformed Mach-O load commands.")
    }
    if (command === LC_BUILD_VERSION && size >= 16) {
      minimumSystemVersion = packedVersion(buffer.readUInt32LE(offset + 12))
    } else if (command === LC_VERSION_MIN_MACOSX && size >= 12) {
      minimumSystemVersion = packedVersion(buffer.readUInt32LE(offset + 8))
    }
    offset += size
  }
  if (!minimumSystemVersion) {
    throw new Error("Cookie helper is missing a macOS deployment target load command.")
  }
  return { architecture: target.architecture, minimumSystemVersion }
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    ...options,
  })
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim()
    throw new Error(`${path.basename(command)} failed${detail ? `: ${detail}` : "."}`)
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`
}

async function verifyHelperFile(helperPath, targetTriple, signed) {
  const expected = checkedTarget(targetTriple)
  const metadata = await stat(helperPath).catch(() => null)
  if (!metadata?.isFile()) {
    throw new Error(`Missing cookie helper: ${helperPath}`)
  }
  if ((metadata.mode & 0o111) === 0) {
    throw new Error(`Cookie helper is not executable: ${helperPath}`)
  }
  const inspection = inspectMachO(await readFile(helperPath))
  if (inspection.architecture !== expected.architecture) {
    throw new Error(
      `Cookie helper architecture ${inspection.architecture} does not match ${targetTriple}.`,
    )
  }
  if (inspection.minimumSystemVersion !== EXPECTED_MINIMUM) {
    throw new Error(
      `Cookie helper minimum macOS ${inspection.minimumSystemVersion} does not match ${EXPECTED_MINIMUM}.`,
    )
  }
  if (process.arch !== (expected.architecture === "arm64" ? "arm64" : "x64")) {
    throw new Error(`Cookie helper smoke test requires a native ${expected.architecture} runner.`)
  }
  if (signed) {
    run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", helperPath])
  }
  const smoke = spawnSync(helperPath, [], {
    input: '{"version":2,"operation":"ListProfiles","browser":"Chrome"}\n',
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 128 * 1024,
    env: { PATH: SYSTEM_PATH, TMPDIR: os.tmpdir() },
  })
  if (smoke.error || smoke.status !== 0) {
    throw new Error(`Cookie helper protocol smoke failed for ${targetTriple}.`)
  }
  let response
  try {
    response = JSON.parse(smoke.stdout)
  } catch {
    throw new Error("Cookie helper protocol smoke returned invalid JSON.")
  }
  if (
    response.version !== 1 ||
    response.operation !== "ListProfiles" ||
    response.ok !== false ||
    response.error?.code !== "UnsupportedVersion"
  ) {
    throw new Error("Cookie helper protocol smoke returned an unexpected response.")
  }
  return inspection
}

export async function verifyBuiltHelper(targetTriple, root = repositoryRoot) {
  checkedTarget(targetTriple)
  const helperPath = path.join(
    root,
    "src-tauri",
    "binaries",
    `openusage-cookie-helper-${targetTriple}`,
  )
  const inspection = await verifyHelperFile(helperPath, targetTriple, false)
  process.stdout.write(
    `Verified ${path.relative(root, helperPath)} (${inspection.architecture}, macOS ${inspection.minimumSystemVersion}).\n`,
  )
}

async function findOne(directory, suffix) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const matches = entries.filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
  if (matches.length !== 1) {
    throw new Error(`Expected one ${suffix} under ${directory}, found ${matches.length}.`)
  }
  return path.join(directory, matches[0].name)
}

async function findFile(directory, filename) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      const nested = await findFile(entryPath, filename)
      if (nested) return nested
    } else if (entry.name === filename) {
      return entryPath
    }
  }
  return null
}

function signingDetails(targetPath) {
  const output = run("/usr/bin/codesign", ["-d", "--verbose=4", targetPath])
  const teamIdentifier = output.match(/^TeamIdentifier=(.+)$/m)?.[1]
  if (!teamIdentifier || teamIdentifier === "not set") {
    throw new Error(`Missing Developer ID team identifier on ${targetPath}.`)
  }
  if (!/^Authority=Developer ID Application:/m.test(output)) {
    throw new Error(`Missing Developer ID Application authority on ${targetPath}.`)
  }
  return { teamIdentifier }
}

export function verifyExactJitEntitlements(output, label) {
  const keys = [...output.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1])
  const unexpected = keys.find((key) => key !== REQUIRED_JIT_ENTITLEMENT)
  if (unexpected) {
    throw new Error(`${label} has unexpected entitlement ${unexpected}.`)
  }
  if (keys.length !== 1) {
    throw new Error(`${label} must have exactly the narrow JIT entitlement.`)
  }
  const requiredEnabled = new RegExp(
    `<key>${REQUIRED_JIT_ENTITLEMENT.replaceAll(".", "\\.")}</key>\\s*<true\\s*/>`,
  )
  if (!requiredEnabled.test(output)) {
    throw new Error(`${label} must enable ${REQUIRED_JIT_ENTITLEMENT}.`)
  }
}

function verifyMinimalJitEntitlements(targetPath, label) {
  const output = run("/usr/bin/codesign", [
    "-d",
    "--entitlements",
    "-",
    "--xml",
    targetPath,
  ])
  verifyExactJitEntitlements(output, label)
}

export async function verifyPackagedHelper(targetTriple, root = repositoryRoot) {
  checkedTarget(targetTriple)
  const bundleDirectory = path.join(
    root,
    "src-tauri",
    "target",
    targetTriple,
    "release",
    "bundle",
    "macos",
  )
  const archive = await findOne(bundleDirectory, ".app.tar.gz")
  const extractionRoot = await mkdtemp(path.join(os.tmpdir(), "openusage-package-verify-"))
  try {
    run("/usr/bin/tar", ["-xzf", archive, "-C", extractionRoot])
    const appName = (await readdir(extractionRoot)).find((name) => name.endsWith(".app"))
    if (!appName) throw new Error("Updater archive does not contain an app bundle.")
    const appPath = path.join(extractionRoot, appName)
    const helperPath = path.join(appPath, "Contents", "MacOS", "openusage-cookie-helper")
    const appExecutable = run("/usr/bin/plutil", [
      "-extract",
      "CFBundleExecutable",
      "raw",
      "-o",
      "-",
      path.join(appPath, "Contents", "Info.plist"),
    ]).trim()
    const appExecutablePath = path.join(appPath, "Contents", "MacOS", appExecutable)
    await verifyHelperFile(helperPath, targetTriple, true)
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath])
    const helperSigning = signingDetails(helperPath)
    const appSigning = signingDetails(appPath)
    if (helperSigning.teamIdentifier !== appSigning.teamIdentifier) {
      throw new Error("Cookie helper and app bundle are signed by different teams.")
    }
    verifyMinimalJitEntitlements(helperPath, "Packaged cookie helper")
    verifyMinimalJitEntitlements(appExecutablePath, "Packaged app executable")
    const minimum = run("/usr/bin/plutil", [
      "-extract",
      "LSMinimumSystemVersion",
      "raw",
      "-o",
      "-",
      path.join(appPath, "Contents", "Info.plist"),
    ]).trim()
    if (minimum !== "13.0") {
      throw new Error(`Packaged app minimum macOS ${minimum} does not match 13.0.`)
    }
    const noticesPath = await findFile(appPath, "THIRD_PARTY_NOTICES.md")
    if (!noticesPath) throw new Error("Packaged app is missing THIRD_PARTY_NOTICES.md.")
    const notices = await readFile(noticesPath, "utf8")
    if (!notices.includes("@steipete/sweet-cookie 0.4.1") || !notices.includes("Bun 1.3.6")) {
      throw new Error("Packaged third-party notices are incomplete for the cookie helper.")
    }
    run("/usr/bin/xcrun", ["stapler", "validate", appPath])
    run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", appPath])
    await access(helperPath, constants.X_OK)
    process.stdout.write(`Verified signed and notarized ${path.basename(archive)}.\n`)
  } finally {
    await rm(extractionRoot, { recursive: true, force: true })
  }
}

async function main() {
  const [mode, targetTriple] = process.argv.slice(2)
  if (mode === "build") {
    await verifyBuiltHelper(targetTriple)
    return
  }
  if (mode === "package") {
    await verifyPackagedHelper(targetTriple)
    return
  }
  throw new Error("Expected build or package verification mode.")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
