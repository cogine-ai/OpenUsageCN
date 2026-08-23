import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { resolveCookieHelperBuild } from "./build-cookie-helper.mjs"

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

test("cookie helper build maps only the two reviewed macOS targets", () => {
  const arm = resolveCookieHelperBuild(repositoryRoot, "aarch64-apple-darwin")
  const intel = resolveCookieHelperBuild(repositoryRoot, "x86_64-apple-darwin")
  let unsupportedError
  try {
    resolveCookieHelperBuild(repositoryRoot, "x86_64-unknown-linux-gnu")
  } catch (error) {
    unsupportedError = error.message
  }

  assert.deepEqual(
    {
      arm,
      intel,
      unsupportedError,
    },
    {
      arm: {
        targetTriple: "aarch64-apple-darwin",
        bunTarget: "bun-darwin-arm64",
        entry: path.join(repositoryRoot, "tools", "cookie-helper", "index.mjs"),
        output: path.join(
          repositoryRoot,
          "src-tauri",
          "binaries",
          "openusage-cookie-helper-aarch64-apple-darwin",
        ),
      },
      intel: {
        targetTriple: "x86_64-apple-darwin",
        bunTarget: "bun-darwin-x64",
        entry: path.join(repositoryRoot, "tools", "cookie-helper", "index.mjs"),
        output: path.join(
          repositoryRoot,
          "src-tauri",
          "binaries",
          "openusage-cookie-helper-x86_64-apple-darwin",
        ),
      },
      unsupportedError: "Unsupported cookie helper target: x86_64-unknown-linux-gnu",
    },
  )
})

test("cookie helper build command rejects an unreviewed target", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./build-cookie-helper.mjs", import.meta.url)), "linux-x64"],
    { encoding: "utf8" },
  )

  assert.deepEqual(
    { status: result.status, stdout: result.stdout, stderr: result.stderr },
    {
      status: 1,
      stdout: "",
      stderr: "Unsupported cookie helper target: linux-x64\n",
    },
  )
})
