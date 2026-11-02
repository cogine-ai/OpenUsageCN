use std::io::ErrorKind;
use std::path::Path;

const UNREADABLE_METADATA: &str =
    "File metadata could not be inspected. Check file access and try again.";

/// Only a confirmed missing path permits a caller to select a different data source.
pub(super) fn exists_strict(path: &Path) -> Result<bool, &'static str> {
    match std::fs::metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => {
            log::error!(
                "strict filesystem metadata check failed: kind={:?}",
                error.kind()
            );
            Err(UNREADABLE_METADATA)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinguishes_missing_paths_from_unreadable_metadata() {
        let root =
            std::env::temp_dir().join(format!("openusage-metadata-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let file = root.join("regular-file");
        std::fs::write(&file, b"synthetic").unwrap();
        assert_eq!(exists_strict(&file), Ok(true));
        assert_eq!(exists_strict(&root.join("missing")), Ok(false));
        // NUL is invalid on both Windows and Unix, even under an administrator/root account.
        // A regular-file parent is unsuitable here: Windows reports that case as NotFound.
        let inaccessible = file.join("private-storage-path\0");
        assert!(std::fs::metadata(&inaccessible).is_err());
        let error = exists_strict(&inaccessible).unwrap_err();
        assert_eq!(error, UNREADABLE_METADATA);
        assert!(!error.contains("private-storage-path"));
        // The legacy API intentionally keeps its previous lossy behavior.
        assert!(!inaccessible.exists());
        std::fs::remove_file(file).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn javascript_receives_fixed_error_without_the_local_path() {
        let runtime = rquickjs::Runtime::new().unwrap();
        let context = rquickjs::Context::full(&runtime).unwrap();
        let root =
            std::env::temp_dir().join(format!("openusage-metadata-js-{}", uuid::Uuid::new_v4()));
        std::fs::write(&root, b"synthetic").unwrap();
        context.with(|ctx| {
            let host = rquickjs::Object::new(ctx.clone()).unwrap();
            super::super::inject_fs(&ctx, &host).unwrap();
            ctx.globals().set("host", host).unwrap();
            ctx.globals().set("privatePath", root.join("private-storage-path\0").to_str().unwrap()).unwrap();
            let error: String = ctx.eval("try { host.fs.existsStrict(privatePath); 'no error' } catch (error) { String(error) }").unwrap();
            assert!(error.contains(UNREADABLE_METADATA));
            assert!(!error.contains("private-storage-path"));
        });
        std::fs::remove_file(root).unwrap();
    }
}
