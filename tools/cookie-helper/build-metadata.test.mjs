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
      ciRunsTests: ci.includes("bun run test:cookie-helper"),
      publishBuildsTarget: publish.includes(
        "bun run build:cookie-helper -- ${{ matrix.target }}",
      ),
      publishTargets: [
        publish.includes("target: aarch64-apple-darwin"),
        publish.includes("target: x86_64-apple-darwin"),
      ],
      ignoresGeneratedBinaries: gitignore.includes(
        "src-tauri/binaries/openusage-cookie-helper-*",
      ),
      includesMitNotice:
        notices.includes("@steipete/sweet-cookie 0.4.1") &&
        notices.includes("Copyright (c) 2025 Peter Steinberger") &&
        notices.includes("THE SOFTWARE IS PROVIDED \"AS IS\""),
    },
    {
      dependency: "0.4.1",
      packageManager: "bun@1.3.6",
      lockVersion: true,
      lockIntegrity: true,
      workflowVersions: ["1.3.6", "1.3.6", "1.3.6", "1.3.6"],
      testScript:
        "bun test tools/cookie-helper/*.test.mjs scripts/build-cookie-helper.test.mjs",
      buildScript: "bun scripts/build-cookie-helper.mjs",
      ciRunsTests: true,
      publishBuildsTarget: true,
      publishTargets: [true, true],
      ignoresGeneratedBinaries: true,
      includesMitNotice: true,
    },
  )
})
