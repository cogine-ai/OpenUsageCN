import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const root = new URL("../../", import.meta.url)

test("cookie helper build metadata pins the reviewed dependency and Bun compiler", async () => {
  const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"))
  const lockfile = await readFile(new URL("bun.lock", root), "utf8")
  const ci = await readFile(new URL(".github/workflows/ci.yml", root), "utf8")
  const publish = await readFile(new URL(".github/workflows/publish.yml", root), "utf8")
  const gitignore = await readFile(new URL(".gitignore", root), "utf8")
  const tauriConfig = JSON.parse(
    await readFile(new URL("src-tauri/tauri.conf.json", root), "utf8"),
  )
  const entitlements = await readFile(
    new URL("src-tauri/Entitlements.plist", root),
    "utf8",
  ).catch(() => "")
  const notices = await readFile(new URL("THIRD_PARTY_NOTICES.md", root), "utf8").catch(
    () => "",
  )

  assert.deepEqual(
    {
      dependency: packageJson.devDependencies?.["@steipete/sweet-cookie"],
      packageManager: packageJson.packageManager,
      lockVersion: lockfile.includes(
        '"@steipete/sweet-cookie": ["@steipete/sweet-cookie@0.4.1"',
      ),
      lockIntegrity: lockfile.includes(
        "sha512-6cuWTGeblwzMw4/3uMzBEmgH1B+crCkJJlmTVu4vzbhG2NhAH8sMWv57fQ8JZY0nqW2ldM0/c2JM0UeQQFyJ3g==",
      ),
      workflowVersions: [...ci.matchAll(/bun-version:\s*["']?([^"'\s]+)/g), ...publish.matchAll(/bun-version:\s*["']?([^"'\s]+)/g)].map(
        (match) => match[1],
      ),
      testScript: packageJson.scripts?.["test:cookie-helper"],
      buildScript: packageJson.scripts?.["build:cookie-helper"],
      verifyBuildScript: packageJson.scripts?.["verify:cookie-helper-build"],
      verifyPackageScript: packageJson.scripts?.["verify:cookie-helper-package"],
      ciRunsTests: ci.includes("bun run test:cookie-helper"),
      ciBuildsAndRunsBothArchitectures:
        ci.includes("runs-on: ${{ matrix.platform }}") &&
        ci.includes("platform: macos-15") &&
        ci.includes("platform: macos-15-intel") &&
        ci.includes("bun run verify:cookie-helper-build -- ${{ matrix.target }}"),
      publishBuildsTarget: publish.includes(
        "bun run build:cookie-helper -- ${{ matrix.target }}",
      ),
      publishVerifiesSignedPackage: publish.includes(
        "bun run verify:cookie-helper-package -- ${{ matrix.target }}",
      ),
      publishTargets: [
        publish.includes("target: aarch64-apple-darwin"),
        publish.includes("target: x86_64-apple-darwin"),
      ],
      minimumSystemVersion: tauriConfig.bundle?.macOS?.minimumSystemVersion,
      entitlementPath: tauriConfig.bundle?.macOS?.entitlements,
      entitlementKeys: [
        ...entitlements.matchAll(/<key>(com\.apple\.security\.cs\.[^<]+)<\/key>/g),
      ].map((match) => match[1]),
      ignoresGeneratedBinaries: gitignore.includes(
        "src-tauri/binaries/openusage-cookie-helper-*",
      ),
      includesMitNotice:
        notices.includes("@steipete/sweet-cookie 0.4.1") &&
        notices.includes("Copyright (c) 2025 Peter Steinberger") &&
        notices.includes("THE SOFTWARE IS PROVIDED \"AS IS\""),
      documentsBunRuntimeLicense:
        notices.includes("Bun 1.3.6") &&
        notices.includes("d530ed993d62be7c7f8f01a3d52627b6845dfd93") &&
        notices.includes("JavaScriptCore") &&
        notices.includes("GNU Library General Public License, version 2"),
    },
    {
      dependency: "0.4.1",
      packageManager: "bun@1.3.6",
      lockVersion: true,
      lockIntegrity: true,
      workflowVersions: ["1.3.6", "1.3.6", "1.3.6", "1.3.6", "1.3.6"],
      testScript:
        "bun test tools/cookie-helper/*.test.mjs scripts/*cookie-helper*.test.mjs",
      buildScript: "bun scripts/build-cookie-helper.mjs",
      verifyBuildScript: "bun scripts/verify-macos-cookie-helper.mjs build",
      verifyPackageScript: "bun scripts/verify-macos-cookie-helper.mjs package",
      ciRunsTests: true,
      ciBuildsAndRunsBothArchitectures: true,
      publishBuildsTarget: true,
      publishVerifiesSignedPackage: true,
      publishTargets: [true, true],
      minimumSystemVersion: "13.0",
      entitlementPath: "./Entitlements.plist",
      entitlementKeys: ["com.apple.security.cs.allow-jit"],
      ignoresGeneratedBinaries: true,
      includesMitNotice: true,
      documentsBunRuntimeLicense: true,
    },
  )
})
