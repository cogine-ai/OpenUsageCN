use super::PluginManifest;
use std::collections::HashSet;
use std::path::Path;

pub(super) fn read_bundle(
    plugin_dir: &Path,
    manifest: &PluginManifest,
) -> Result<String, Box<dyn std::error::Error>> {
    let root = plugin_dir.canonicalize()?;
    let mut paths = HashSet::new();
    let mut bundle = String::new();
    for name in manifest.supporting_scripts.iter().chain([&manifest.entry]) {
        if name.trim().is_empty() || Path::new(name).is_absolute() {
            return Err("plugin scripts must be non-empty relative paths".into());
        }
        let path = root.join(name).canonicalize()?;
        if !path.starts_with(&root) || !path.is_file() {
            return Err("plugin scripts must be files within the plugin directory".into());
        }
        if !paths.insert(path.clone()) {
            return Err("plugin script paths must not repeat".into());
        }
        bundle.push_str(&std::fs::read_to_string(path)?);
        bundle.push_str("\n;\n");
    }
    Ok(bundle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rquickjs::{Context, Runtime};

    fn fixture() -> (tempfile::TempDir, PluginManifest) {
        let root = tempfile::tempdir().unwrap();
        let manifest = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1, "id": "test", "name": "Test", "version": "1",
            "entry": "plugin.js", "supportingScripts": ["helper.js"],
            "icon": "icon.svg", "lines": []
        }))
        .unwrap();
        std::fs::write(
            root.path().join("helper.js"),
            "globalThis.answer = 40 // comment",
        )
        .unwrap();
        std::fs::write(root.path().join("plugin.js"), "globalThis.answer += 2").unwrap();
        (root, manifest)
    }

    #[test]
    fn declared_helpers_execute_before_entry_in_quickjs() {
        let (root, manifest) = fixture();
        let bundle = read_bundle(root.path(), &manifest).unwrap();
        let runtime = Runtime::new().unwrap();
        Context::full(&runtime).unwrap().with(|ctx| {
            ctx.eval::<(), _>(bundle.as_bytes()).unwrap();
            assert_eq!(ctx.eval::<i32, _>("answer").unwrap(), 42);
        });
    }

    #[test]
    fn entry_and_helpers_cannot_escape_or_repeat() {
        let (root, mut manifest) = fixture();
        for path in ["", "/etc/passwd", "../outside.js", "missing.js", "."] {
            manifest.supporting_scripts = vec![path.into()];
            assert!(read_bundle(root.path(), &manifest).is_err());
        }
        manifest.supporting_scripts = vec!["plugin.js".into()];
        assert!(read_bundle(root.path(), &manifest).is_err());
        manifest.supporting_scripts = vec!["helper.js".into(), "./helper.js".into()];
        assert!(read_bundle(root.path(), &manifest).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_grant_access_outside_the_plugin() {
        let (root, mut manifest) = fixture();
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("escape.js")).unwrap();
        manifest.supporting_scripts = vec!["escape.js".into()];
        assert!(read_bundle(root.path(), &manifest).is_err());
    }
}
