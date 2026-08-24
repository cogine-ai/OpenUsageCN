import { executeRequest } from "./protocol.mjs"
import { createCookieRuntime } from "./runtime.mjs"

const MAX_INPUT_BYTES = 64 * 1024
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024

await main()

async function main() {
  if (process.argv.length > 2) {
    writeResponse(
      failure("Unknown", "UnexpectedArguments", "This helper accepts requests only on stdin."),
    )
    return
  }

  const input = await readInput()
  if (!input.ok) {
    writeResponse(failure("Unknown", input.code, input.message))
    return
  }

  let request
  try {
    request = JSON.parse(input.value)
  } catch {
    writeResponse(
      failure("Unknown", "InvalidJson", "The browser helper request is not valid JSON."),
    )
    return
  }

  try {
    writeResponse(await executeRequest(request, createCookieRuntime()))
  } catch {
    writeResponse(
      failure("Unknown", "InternalError", "The browser helper could not complete the request."),
    )
  }
}

async function readInput() {
  const chunks = []
  let totalBytes = 0
  for await (const chunk of process.stdin) {
    totalBytes += chunk.byteLength
    if (totalBytes > MAX_INPUT_BYTES) {
      return {
        ok: false,
        code: "RequestTooLarge",
        message: "The browser helper request is too large.",
      }
    }
    chunks.push(chunk)
  }
  return { ok: true, value: Buffer.concat(chunks).toString("utf8") }
}

function writeResponse(response) {
  let serialized = JSON.stringify(response)
  if (Buffer.byteLength(serialized, "utf8") > MAX_OUTPUT_BYTES) {
    serialized = JSON.stringify(
      failure("ReadCookies", "OutputTooLarge", "The browser helper response is too large."),
    )
  }
  process.stdout.write(`${serialized}\n`)
}

function failure(operation, code, message) {
  return {
    version: 1,
    operation,
    ok: false,
    error: { code, message },
  }
}
