import { spawnSync } from "node:child_process"
import { chmod, mkdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const REVIEWED_BUN_VERSION = "1.3.6"
const REVIEWED_SWEET_COOKIE_VERSION = "0.4.1"
const REVIEWED_SWEET_COOKIE_INTEGRITY =
  "sha512-6cuWTGeblwzMw4/3uMzBEmgH1B+crCkJJlmTVu4vzbhG2NhAH8sMWv57fQ8JZY0nqW2ldM0/c2JM0UeQQFyJ3g=="

const BUN_TARGETS = {
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
}

export function resolveCookieHelperBuild(repositoryRoot, targetTriple) {
  const bunTarget = BUN_TARGETS[targetTriple]
  if (!bunTarget) {
    throw new Error(`Unsupported cookie helper target: ${targetTriple}`)
  }
  return {
    targetTriple,
    bunTarget,
    entry: path.join(repositoryRoot, "tools", "cookie-helper", "index.mjs"),
    output: path.join(
      repositoryRoot,
      "src-tauri",
      "binaries",
      `openusage-cookie-helper-${targetTriple}`,
    ),
  }
}

async function main() {
  const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const argumentsAfterScript = process.argv.slice(2)
  if (argumentsAfterScript.length > 1) {
    throw new Error("Expected one cookie helper target triple.")
  }
  const targetTriple = argumentsAfterScript[0] ?? process.env.TAURI_ENV_TARGET_TRIPLE
  if (!targetTriple) {
    throw new Error("Missing cookie helper target triple.")
  }

  const configuration = resolveCookieHelperBuild(repositoryRoot, targetTriple)
  await verifyBuildInputs(repositoryRoot)
  await mkdir(path.dirname(configuration.output), { recursive: true })
  const build = spawnSync(
    "bun",
    [
      "build",
      configuration.entry,
      "--compile",
      "--minify",
      `--target=${configuration.bunTarget}`,
      `--outfile=${configuration.output}`,
    ],
    { cwd: repositoryRoot, stdio: "inherit" },
  )
  if (build.error) {
    throw build.error
  }
  if (build.status !== 0) {
    throw new Error(`Bun failed to build the cookie helper for ${targetTriple}.`)
  }
  await chmod(configuration.output, 0o755)
  const outputMetadata = await stat(configuration.output)
  process.stdout.write(
    `Built ${path.relative(repositoryRoot, configuration.output)} (${outputMetadata.size} bytes).\n`,
  )
}

async function verifyBuildInputs(repositoryRoot) {
  const version = spawnSync("bun", ["--version"], { encoding: "utf8" })
  if (version.error) {
    throw version.error
  }
  if (version.status !== 0 || version.stdout.trim() !== REVIEWED_BUN_VERSION) {
    throw new Error(`Cookie helper builds require Bun ${REVIEWED_BUN_VERSION}.`)
  }

  const packageJson = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  )
  if (packageJson.packageManager !== `bun@${REVIEWED_BUN_VERSION}`) {
    throw new Error(`package.json must pin bun@${REVIEWED_BUN_VERSION}.`)
  }
  if (
    packageJson.devDependencies?.["@steipete/sweet-cookie"] !==
    REVIEWED_SWEET_COOKIE_VERSION
  ) {
    throw new Error(
      `package.json must pin @steipete/sweet-cookie@${REVIEWED_SWEET_COOKIE_VERSION}.`,
    )
  }

  const lockfile = await readFile(path.join(repositoryRoot, "bun.lock"), "utf8")
  if (
    !lockfile.includes(
      `"@steipete/sweet-cookie": ["@steipete/sweet-cookie@${REVIEWED_SWEET_COOKIE_VERSION}"`,
    ) ||
    !lockfile.includes(REVIEWED_SWEET_COOKIE_INTEGRITY)
  ) {
    throw new Error("bun.lock does not contain the reviewed sweet-cookie package and integrity.")
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
