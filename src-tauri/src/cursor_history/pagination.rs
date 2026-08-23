use super::{HistoryError, ScriptedEvent, ScriptedPage};

const PAGE_SIZE: usize = 1_000;
const MAX_PAGES: usize = 200;

pub(super) fn collect_complete_events(
    mut pages: Vec<ScriptedPage>,
    requested_page_size: usize,
) -> Result<Vec<ScriptedEvent>, HistoryError> {
    if requested_page_size != PAGE_SIZE {
        return Err(HistoryError::UnexpectedPageSize {
            actual: requested_page_size,
        });
    }
    if pages.is_empty() {
        return Err(HistoryError::NoPages);
    }
    if pages.len() > MAX_PAGES {
        return Err(HistoryError::PageLimitExceeded {
            actual: pages.len(),
        });
    }
    for (index, page) in pages.iter().enumerate() {
        let expected = u16::try_from(index + 1).unwrap_or(u16::MAX);
        if page.page != expected {
            return Err(HistoryError::MissingPage {
                expected,
                actual: page.page,
            });
        }
        if page.events.len() > PAGE_SIZE {
            return Err(HistoryError::PageTooLarge {
                page: page.page,
                actual: page.events.len(),
            });
        }
    }

    let mut authoritative_total = None;
    for page in &pages {
        if let Some(actual) = page.total_usage_events_count {
            if authoritative_total.is_some_and(|expected| expected != actual) {
                return Err(HistoryError::TotalCountDrift {
                    expected: authoritative_total,
                    actual: Some(actual),
                    page: page.page,
                });
            }
            authoritative_total = Some(actual);
        }
    }

    for page in pages.iter().take(pages.len().saturating_sub(1)) {
        if page.events.len() < PAGE_SIZE {
            return Err(HistoryError::RowsAfterFinalPage { page: page.page });
        }
    }

    if let Some(last_page) = pages.last()
        && last_page.events.len() >= PAGE_SIZE
    {
        return Err(HistoryError::FinalPageNotShort {
            page: last_page.page,
        });
    }

    let actual = pages.iter().fold(0_u64, |count, page| {
        count + u64::try_from(page.events.len()).unwrap_or(u64::MAX)
    });
    let mut remove_prefix = vec![0_usize; pages.len()];

    if let Some(expected) = authoritative_total {
        if actual < expected {
            return Err(HistoryError::CountMismatch { expected, actual });
        }
        if actual > expected {
            let required = usize::try_from(actual - expected).unwrap_or(usize::MAX);
            let mut proven = 0_usize;
            for index in 1..pages.len() {
                let previous = &pages[index - 1].events;
                let current = &pages[index].events;
                let maximum = previous.len().min(current.len());
                let overlap = (1..=maximum)
                    .rev()
                    .find(|&length| previous[previous.len() - length..] == current[..length])
                    .unwrap_or(0);
                remove_prefix[index] = overlap;
                proven = proven.saturating_add(overlap);
            }
            if proven != required {
                return Err(HistoryError::CountMismatch { expected, actual });
            }
        }
    }

    let capacity = pages
        .iter()
        .map(|page| page.events.len())
        .sum::<usize>()
        .saturating_sub(remove_prefix.iter().sum());
    let mut complete = Vec::with_capacity(capacity);
    for (page, prefix) in pages.iter_mut().zip(remove_prefix) {
        complete.extend(page.events.drain(prefix..));
    }
    Ok(complete)
}
