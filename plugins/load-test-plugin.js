import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInThisContext } from "node:vm"

// Match the classic-script bundle evaluated by QuickJS, including helper ordering.
export function loadTestPlugin(id) {
  const directory = resolve("plugins", id)
  const manifest = JSON.parse(readFileSync(resolve(directory, "plugin.json"), "utf8"))
  const files = [...(manifest.supportingScripts ?? []), manifest.entry]
  delete globalThis.__openusage_plugin
  runInThisContext(files.map((file) => readFileSync(resolve(directory, file), "utf8")).join("\n;\n"), {
    filename: `${id}/plugin-bundle.js`,
  })
  return globalThis.__openusage_plugin
}
