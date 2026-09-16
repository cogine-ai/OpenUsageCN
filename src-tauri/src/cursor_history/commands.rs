use super::{HistoryError, export};
use crate::{CursorHistoryErrorView, CursorHistoryState};

#[tauri::command]
pub(crate) fn export_cursor_history_csv(
    provider_id: String,
    account_id: String,
    snapshot: export::SnapshotKey,
    history: tauri::State<'_, CursorHistoryState>,
) -> Result<String, CursorHistoryErrorView> {
    let destination =
        dirs::download_dir().ok_or_else(|| history_error(HistoryError::StorageWrite))?;
    export::export_stored_snapshot(
        &history.store,
        &provider_id,
        &account_id,
        &snapshot,
        &destination,
    )
    .map(|path| path.to_string_lossy().into_owned())
    .map_err(|error| history_error(error))
}

fn history_error(error: HistoryError) -> CursorHistoryErrorView {
    let correlation_id = uuid::Uuid::new_v4().to_string();
    log::error!(
        "cursor cache export failed: reason={:?}, correlation_id={}",
        error,
        correlation_id
    );
    CursorHistoryErrorView {
        code: "historyExportFailed".to_string(),
        message: "Unable to export this result. It may have refreshed; try again and check your Downloads folder access.".to_string(),
        correlation_id: Some(correlation_id),
    }
}
