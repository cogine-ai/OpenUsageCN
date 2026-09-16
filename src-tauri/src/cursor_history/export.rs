use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use super::{CompleteHistory, HistoryError, HistoryStore, ListCostCoverage, MeteredCoverage};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnapshotKey {
    pub from_ms: i64,
    pub to_ms: i64,
    pub fetched_at_ms: i64,
}

pub(super) fn export_stored_snapshot(
    store: &HistoryStore,
    provider_id: &str,
    account_id: &str,
    key: &SnapshotKey,
    destination: &Path,
) -> Result<PathBuf, HistoryError> {
    if provider_id != "cursor" {
        return Err(HistoryError::UnsupportedProvider);
    }
    let snapshot = store
        .load(provider_id, account_id)?
        .filter(|history| {
            history.coverage.from_ms == key.from_ms
                && history.coverage.to_ms == key.to_ms
                && history.coverage.fetched_at_ms == key.fetched_at_ms
        })
        .ok_or(HistoryError::StorageRead)?;
    let csv = history_csv(&snapshot)?;
    // Neither account labels nor provider model names can control the destination path.
    let filename = format!(
        "cursor-history-{}-{}.csv",
        OffsetDateTime::now_utc().unix_timestamp_nanos(),
        uuid::Uuid::new_v4()
    );
    write_new_csv(destination, &filename, &csv)
}

pub(super) fn write_new_csv(
    destination: &Path,
    filename: &str,
    csv: &str,
) -> Result<PathBuf, HistoryError> {
    write_new_csv_with(destination, filename, |file| {
        file.write_all(csv.as_bytes()).and_then(|_| file.sync_all())
    })
}

fn write_new_csv_with(
    destination: &Path,
    filename: &str,
    write_and_sync: impl FnOnce(&mut File) -> std::io::Result<()>,
) -> Result<PathBuf, HistoryError> {
    let path = destination.join(filename);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| HistoryError::StorageWrite)?;
    if let Err(error) = write_and_sync(&mut file) {
        log::warn!("cursor CSV write or sync failed: {error}");
        drop(file);
        if let Err(error) = std::fs::remove_file(&path) {
            log::warn!("cursor incomplete CSV cleanup failed: {error}");
        }
        return Err(HistoryError::StorageWrite);
    }
    Ok(path)
}

pub(super) fn history_csv(history: &CompleteHistory) -> Result<String, HistoryError> {
    let coverage = &history.coverage;
    let cycle = coverage.billing_cycle.as_ref();
    let common = vec![
        "https://cursor.com/api/dashboard/get-filtered-usage-events".to_string(),
        history.account_id.clone(),
        "Session-Visible Usage".to_string(),
        coverage.time_zone.clone(),
        cycle
            .map(|cycle| utc_time(cycle.start_ms))
            .transpose()?
            .unwrap_or_default(),
        cycle
            .map(|cycle| utc_time(cycle.end_ms))
            .transpose()?
            .unwrap_or_default(),
        utc_time(coverage.from_ms)?,
        utc_time(coverage.to_ms)?,
        utc_time(coverage.fetched_at_ms)?,
        coverage.complete.to_string(),
        "Current Result Only; Not An Invoice".to_string(),
    ];
    let mut csv = String::new();
    append_row(
        &mut csv,
        &[
            "Record Type",
            "Source",
            "Account ID",
            "Scope",
            "Time Zone",
            "Billing Cycle Start UTC",
            "Billing Cycle End UTC",
            "Coverage From UTC",
            "Coverage To UTC",
            "Fetched At UTC",
            "Pages Complete",
            "Coverage Meaning",
            "Local Date",
            "Model Name",
            "Input Tokens",
            "Output Tokens",
            "Cache Write Tokens",
            "Cache Read Tokens",
            "Requests",
            "Known List-Price Equivalent USD",
            "List-Price Coverage",
            "Metered Usage USD",
            "Metered Coverage",
        ]
        .map(str::to_string),
    );

    let mut summary = vec!["Window Summary".to_string()];
    summary.extend(common.clone());
    summary.extend(vec![String::new(); 9]);
    summary.push(
        history
            .totals
            .metered_charged_usd
            .map(|value| value.to_string())
            .unwrap_or_default(),
    );
    summary.push(
        match history.totals.metered_coverage {
            MeteredCoverage::Complete => "Complete",
            MeteredCoverage::Incomplete => "Incomplete",
        }
        .to_string(),
    );
    append_row(&mut csv, &summary);

    for bucket in &history.buckets {
        let mut row = vec!["Model Detail".to_string()];
        row.extend(common.clone());
        row.extend([
            bucket.local_date.clone(),
            bucket.model_name.clone(),
            bucket.input_tokens.to_string(),
            bucket.output_tokens.to_string(),
            bucket.cache_write_tokens.to_string(),
            bucket.cache_read_tokens.to_string(),
            bucket.request_count.to_string(),
            bucket
                .known_list_cost_usd
                .map(|value| value.to_string())
                .unwrap_or_default(),
            match bucket.list_cost_coverage {
                ListCostCoverage::Complete => "Complete",
                ListCostCoverage::Partial => "Partial",
                ListCostCoverage::Invalid => "Invalid",
            }
            .to_string(),
            String::new(),
            String::new(),
        ]);
        append_row(&mut csv, &row);
    }
    Ok(csv)
}

fn utc_time(milliseconds: i64) -> Result<String, HistoryError> {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(milliseconds) * 1_000_000)
        .map_err(|_| HistoryError::StorageInvalid)?
        .format(&Rfc3339)
        .map_err(|_| HistoryError::StorageInvalid)
}

fn append_row(csv: &mut String, cells: &[String]) {
    for (index, cell) in cells.iter().enumerate() {
        if index > 0 {
            csv.push(',');
        }
        csv.push('"');
        // A visible text prefix survives CSV re-saving better than quote-only escaping.
        if cell.starts_with(['\t', '\r', '\n'])
            || cell
                .trim_start()
                .starts_with(['=', '+', '-', '@', '＝', '＋', '－', '＠'])
        {
            csv.push_str("Text: ");
        }
        csv.push_str(&cell.replace('"', "\"\""));
        csv.push('"');
    }
    csv.push_str("\r\n");
}

#[cfg(test)]
mod write_tests {
    use super::*;

    #[test]
    fn failed_writes_and_syncs_do_not_leave_an_exported_csv() {
        let root =
            std::env::temp_dir().join(format!("openusage-failed-csv-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        for (filename, written) in [("write.csv", "partial"), ("sync.csv", "complete\r\n")] {
            let result = write_new_csv_with(&root, filename, |file| {
                file.write_all(written.as_bytes())?;
                Err(std::io::Error::other("injected export failure"))
            });
            assert_eq!(result, Err(HistoryError::StorageWrite));
            assert!(
                !root.join(filename).exists(),
                "failed export remains: {filename}"
            );
        }
    }
}
