use std::io::ErrorKind;
use std::path::Path;

const UNREADABLE_METADATA: &str =
    "File metadata could not be inspected. Check file access and try again.";

/// Only a missing path beneath a readable directory permits selecting a different source.
pub(super) fn exists_strict(path: &Path) -> Result<bool, &'static str> {
    match std::fs::metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            confirm_missing_parent(path, |parent| {
                std::fs::metadata(parent).map(|value| value.is_dir())
            })
        }
        Err(error) => metadata_error(error.kind()),
    }
}

fn metadata_error(kind: ErrorKind) -> Result<bool, &'static str> {
    log::error!("strict filesystem metadata check failed: kind={kind:?}");
    Err(UNREADABLE_METADATA)
}

// Windows can classify file/child as NotFound. Inspect ancestors before trusting that result.
fn confirm_missing_parent(
    path: &Path,
    mut is_directory: impl FnMut(&Path) -> std::io::Result<bool>,
) -> Result<bool, &'static str> {
    for parent in path.ancestors().skip(1) {
        let parent = if parent.as_os_str().is_empty() {
            Path::new(".")
        } else {
            parent
        };
        match is_directory(parent) {
            Ok(true) => return Ok(false),
            Ok(false) => return metadata_error(ErrorKind::NotADirectory),
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => return metadata_error(error.kind()),
        }
    }
    metadata_error(ErrorKind::NotFound)
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
    fn ordinary_file_ancestors_never_count_as_a_missing_database() {
        let root =
            std::env::temp_dir().join(format!("openusage-file-parent-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let file = root.join("regular-file");
        std::fs::write(&file, b"synthetic").unwrap();
        for path in [file.join("database"), file.join("nested/deeper/database")] {
            assert_eq!(exists_strict(&path), Err(UNREADABLE_METADATA));
            // Exercise Windows' NotFound normalization on every platform, including missing intermediates.
            let result = confirm_missing_parent(&path, |parent| {
                std::fs::metadata(parent)
                    .map(|value| value.is_dir())
                    .map_err(|error| {
                        if error.kind() == ErrorKind::NotADirectory {
                            std::io::Error::from(ErrorKind::NotFound)
                        } else {
                            error
                        }
                    })
            });
            assert_eq!(result, Err(UNREADABLE_METADATA));
        }
        let missing = root.join("missing/nested/database");
        assert_eq!(exists_strict(&missing), Ok(false));
        assert_eq!(
            confirm_missing_parent(&missing, |parent| std::fs::metadata(parent)
                .map(|value| value.is_dir())),
            Ok(false)
        );
        std::fs::remove_file(file).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn missing_path_with_unreadable_ancestor_does_not_allow_fallback() {
        let path = Path::new("private-storage-path/database");
        let error = confirm_missing_parent(path, |_| {
            Err(std::io::Error::from(ErrorKind::PermissionDenied))
        });
        assert_eq!(error, Err(UNREADABLE_METADATA));
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
