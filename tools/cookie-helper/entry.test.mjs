import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"

test("helper rejects malformed JSON without writing secrets or paths to stderr", async () => {
  const result = await runHelper(
    '{"cookie":"session=super-secret","profile":"/Users/alice/Private/Profile 2"',
  )

  assert.deepEqual(result, {
    code: 0,
    stderr: "",
    response: {
      version: 1,
      operation: "Unknown",
      ok: false,
      error: {
        code: "InvalidJson",
        message: "The browser helper request is not valid JSON.",
      },
    },
  })
})

test("helper does not expose command-line cookie or profile parsing", async () => {
  const result = await runHelper("", [
    "--cookie=session=super-secret",
    "--profile=/Users/alice/Private/Profile 2",
  ])

  assert.deepEqual(result, {
    code: 0,
    stderr: "",
    response: {
      version: 1,
      operation: "Unknown",
      ok: false,
      error: {
        code: "UnexpectedArguments",
        message: "This helper accepts requests only on stdin.",
      },
    },
  })
})

async function runHelper(input, args = []) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./index.mjs", import.meta.url)), ...args],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  )
  child.stdin.end(input)
  const stdout = readStream(child.stdout)
  const stderr = readStream(child.stderr)
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  })
  const stdoutText = await stdout
  return {
    code,
    stderr: await stderr,
    response: JSON.parse(stdoutText),
  }
}

async function readStream(stream) {
  let value = ""
  for await (const chunk of stream) {
    value += chunk
  }
  return value
}
