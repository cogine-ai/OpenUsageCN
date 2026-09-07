use super::{CompleteHistory, HistoryError, export};
use crate::{CursorHistoryErrorView, CursorHistoryState};

#[tauri::command]
pub(crate) fn list_cursor_history_snapshots(
    provider_id: String,
    account_id: String,
    history: tauri::State<'_, CursorHistoryState>,
) -> Result<Vec<CompleteHistory>, CursorHistoryErrorView> {
    if provider_id != "cursor" {
        return Err(history_error(HistoryError::UnsupportedProvider, false));
    }
    history
        .store
        .list(&provider_id, &account_id)
        .map_err(|error| history_error(error, false))
}

#[tauri::command]
pub(crate) fn export_cursor_history_csv(
    provider_id: String,
    account_id: String,
    snapshot: export::SnapshotKey,
    history: tauri::State<'_, CursorHistoryState>,
) -> Result<String, CursorHistoryErrorView> {
    let destination =
        dirs::download_dir().ok_or_else(|| history_error(HistoryError::StorageWrite, true))?;
    export::export_stored_snapshot(
        &history.store,
        &provider_id,
        &account_id,
        &snapshot,
        &destination,
    )
    .map(|path| path.to_string_lossy().into_owned())
    .map_err(|error| history_error(error, true))
}

fn history_error(error: HistoryError, exporting: bool) -> CursorHistoryErrorView {
    let correlation_id = uuid::Uuid::new_v4().to_string();
    log::error!(
        "cursor stored history operation failed: exporting={}, reason={:?}, correlation_id={}",
        exporting,
        error,
        correlation_id
    );
    CursorHistoryErrorView {
        code: if exporting {
            "historyExportFailed"
        } else {
            "historyStorageFailed"
        }
        .to_string(),
        message: if exporting {
            "Unable to export the stored window. Check your Downloads folder access and try again."
        } else {
            "Unable to read recorded Cursor windows. Your saved history has been kept."
        }
        .to_string(),
        correlation_id: Some(correlation_id),
    }
}
