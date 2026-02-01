const { cpSync, mkdirSync } = require("fs")
const { join } = require("path")

const root = __dirname
const plugins = ["cursor", "claude", "codex"]

for (const id of plugins) {
  const src = join(root, "plugins", id)
  const dst = join(root, "src-tauri", "resources", "bundled_plugins", id)
  mkdirSync(dst, { recursive: true })
  cpSync(join(src, "plugin.json"), join(dst, "plugin.json"))
  cpSync(join(src, "plugin.js"), join(dst, "plugin.js"))
}

console.log("Bundled plugins copied.")
