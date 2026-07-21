import assert from "node:assert/strict"
import test from "node:test"

import { isUpdaterArchive } from "./verify-updater-signature.mjs"

test("recognizes macOS and Windows updater archives", () => {
  assert.equal(isUpdaterArchive("OpenUsageCN.app.tar.gz"), true)
  assert.equal(isUpdaterArchive("OpenUsageCN_0.6.35_x64-setup.nsis.zip"), true)
})

test("does not treat installers or signatures as updater archives", () => {
  assert.equal(isUpdaterArchive("OpenUsageCN_0.6.35_x64-setup.exe"), false)
  assert.equal(isUpdaterArchive("OpenUsageCN.app.tar.gz.sig"), false)
  assert.equal(isUpdaterArchive("OpenUsageCN_0.6.35_x64-setup.nsis.zip.sig"), false)
})
