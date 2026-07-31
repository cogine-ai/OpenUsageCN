import assert from "node:assert/strict"
import test from "node:test"

import { isUpdaterArchive } from "./verify-updater-signature.mjs"

test("recognizes macOS and Windows updater archives", () => {
  assert.equal(isUpdaterArchive("OpenUsageCN.app.tar.gz"), true)
  assert.equal(isUpdaterArchive("OpenUsageCN_0.6.36_x64-setup.exe"), true)
})

test("does not treat unrelated executables or signatures as updater archives", () => {
  assert.equal(isUpdaterArchive("OpenUsageCN.exe"), false)
  assert.equal(isUpdaterArchive("OpenUsageCN.app.tar.gz.sig"), false)
  assert.equal(isUpdaterArchive("OpenUsageCN_0.6.36_x64-setup.exe.sig"), false)
})

test("rejects legacy nsis zip updater archives", () => {
  assert.equal(isUpdaterArchive("OpenUsageCN_0.6.36_x64.nsis.zip"), false)
})
