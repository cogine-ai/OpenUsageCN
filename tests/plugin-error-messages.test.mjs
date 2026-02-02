import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const read = (relPath) => readFile(new URL(`../${relPath}`, import.meta.url), "utf8")

test("claude plugin throws actionable strings", async () => {
  const content = await read("plugins/claude/plugin.js")
  assert.ok(content.includes('throw "Not logged in. Run `claude` to authenticate."'))
  assert.ok(content.includes('throw "Token expired. Run `claude` to refresh."'))
})

test("codex plugin throws actionable strings", async () => {
  const content = await read("plugins/codex/plugin.js")
  assert.ok(content.includes('throw "Not logged in. Run `codex` to authenticate."'))
  assert.ok(content.includes('throw "Session expired. Run `codex` to log in again."'))
  assert.ok(content.includes('throw "Token revoked. Run `codex` to log in again."'))
})

test("cursor plugin throws actionable strings", async () => {
  const content = await read("plugins/cursor/plugin.js")
  assert.ok(content.includes('throw "Not logged in. Sign in via Cursor app."'))
  assert.ok(content.includes('throw "Token expired. Re-authenticate in Cursor."'))
})

test("mock plugin uses realistic error strings", async () => {
  const content = await read("plugins/mock/plugin.js")
  assert.ok(content.includes('throw "Not logged in. Run mockctl to authenticate."'))
  assert.ok(content.includes('Token expired. Run mockctl to refresh.'))
  assert.ok(content.includes('throw "Token revoked. Run mockctl to log in again."'))
})
