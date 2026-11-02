use std::{collections::HashSet, pin::Pin, time::Duration};

use async_stream::try_stream;
use futures::{Stream, StreamExt};
use serde_json::{Value, json};
use tokio::time::{Instant, timeout_at};

use super::{CodexCallResult, CodexOptions, GuestClient, GuestError, MAX_GUEST_JSON_BYTES};

#[cfg(test)]
mod tests;

const PAGE_SIZE: usize = 100;
const MAX_HISTORY_PAGES: usize = 256;
const MAX_HISTORY_BYTES: usize = 64 << 20;
const HISTORY_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Debug, PartialEq)]
pub enum CodexHistoryPart {
    Thread,
    Items,
    Turns,
}

pub struct CodexHistoryPage {
    pub part: CodexHistoryPart,
    pub snapshot: CodexCallResult,
}

type HistoryStream = Pin<Box<dyn Stream<Item = Result<CodexHistoryPage, GuestError>> + Send>>;

#[derive(Default)]
struct HistoryBudget {
    pages: usize,
    bytes: usize,
    sequence: u64,
}

impl HistoryBudget {
    fn include(&mut self, response: &CodexCallResult) -> Result<(), GuestError> {
        self.pages += 1;
        if self.pages > MAX_HISTORY_PAGES {
            return Err(GuestError::InvalidCodexHistory("too many history pages"));
        }
        let bytes = serde_json::to_vec(&response.result)?.len();
        if bytes > MAX_GUEST_JSON_BYTES {
            return Err(GuestError::ResponseTooLarge(MAX_GUEST_JSON_BYTES));
        }
        self.bytes += bytes;
        if self.bytes > MAX_HISTORY_BYTES {
            return Err(GuestError::ResponseTooLarge(MAX_HISTORY_BYTES));
        }
        if response.event_sequence < self.sequence {
            return Err(GuestError::InvalidCodexHistory(
                "event sequence moved backwards",
            ));
        }
        self.sequence = response.event_sequence;
        Ok(())
    }
}

impl GuestClient {
    pub async fn resume_codex_thread(
        &self,
        thread_id: &str,
        options: &CodexOptions,
    ) -> Result<HistoryStream, GuestError> {
        let deadline = Instant::now() + HISTORY_TIMEOUT;
        let params = json!({
            "threadId": thread_id, "model": options.model, "config": options.thread_config(),
            "cwd": "/workspace", "runtimeWorkspaceRoots": ["/workspace"],
            "approvalPolicy": "on-request", "sandbox": "danger-full-access", "excludeTurns": true,
        });
        let mut snapshot = timeout_at(
            deadline,
            self.codex_call_with_sequence("thread/resume", params.clone()),
        )
        .await
        .map_err(|_| GuestError::CodexHistoryTimeout)??;
        let mut budget = HistoryBudget::default();
        budget.include(&snapshot)?;
        validate_thread(&snapshot.result, thread_id)?;
        let paginated = match snapshot
            .result
            .pointer("/thread/historyMode")
            .and_then(Value::as_str)
        {
            Some("paginated") => {
                if !snapshot
                    .result
                    .pointer("/thread/turns")
                    .and_then(Value::as_array)
                    .is_some_and(Vec::is_empty)
                {
                    return Err(GuestError::InvalidCodexHistory(
                        "unexpected hydrated thread",
                    ));
                }
                true
            }
            Some("legacy") => {
                let mut params = params;
                params["excludeTurns"] = json!(false);
                snapshot = timeout_at(
                    deadline,
                    self.codex_call_with_sequence("thread/resume", params),
                )
                .await
                .map_err(|_| GuestError::CodexHistoryTimeout)??;
                budget.include(&snapshot)?;
                validate_thread(&snapshot.result, thread_id)?;
                if snapshot
                    .result
                    .pointer("/thread/historyMode")
                    .and_then(Value::as_str)
                    != Some("legacy")
                    || !snapshot
                        .result
                        .pointer("/thread/turns")
                        .is_some_and(Value::is_array)
                {
                    return Err(GuestError::InvalidCodexHistory("invalid legacy snapshot"));
                }
                false
            }
            _ => return Err(GuestError::InvalidCodexHistory("unknown history mode")),
        };
        let guest = self.clone();
        let thread_id = thread_id.to_owned();
        let source: HistoryStream = Box::pin(try_stream! {
            yield CodexHistoryPage { part: CodexHistoryPart::Thread, snapshot };
            if paginated {
                let mut item_ids = HashSet::new();
                let mut referenced_turns = HashSet::new();
                let mut cursor = None;
                let mut seen_cursors = HashSet::new();
                loop {
                    let snapshot = guest.codex_call_with_sequence("thread/items/list", json!({
                        "threadId": thread_id, "cursor": cursor, "limit": PAGE_SIZE, "sortDirection": "asc",
                    })).await?;
                    for entry in history_page(&snapshot, &mut budget)? {
                        let turn_id = required_id(entry, "turnId")?;
                        let item = entry.get("item").filter(|item| item.is_object())
                            .ok_or(GuestError::InvalidCodexHistory("missing item"))?;
                        let item_id = required_id(item, "id")?;
                        if !item_ids.insert(item_id.to_owned()) {
                            Err(GuestError::InvalidCodexHistory("duplicate item"))?;
                        }
                        referenced_turns.insert(turn_id.to_owned());
                    }
                    cursor = next_cursor(&snapshot.result, &mut seen_cursors)?;
                    yield CodexHistoryPage { part: CodexHistoryPart::Items, snapshot };
                    if cursor.is_none() { break; }
                }
                let mut seen_turns = HashSet::new();
                seen_cursors.clear();
                loop {
                    let snapshot = guest.codex_call_with_sequence("thread/turns/list", json!({
                        "threadId": thread_id, "cursor": cursor, "limit": PAGE_SIZE,
                        "sortDirection": "asc", "itemsView": "notLoaded",
                    })).await?;
                    for turn in history_page(&snapshot, &mut budget)? {
                        let turn_id = required_id(turn, "id")?;
                        if !seen_turns.insert(turn_id.to_owned()) {
                            Err(GuestError::InvalidCodexHistory("duplicate turn"))?;
                        }
                        if !matches!(turn.get("status").and_then(Value::as_str),
                            Some("completed" | "interrupted" | "failed" | "inProgress")) {
                            Err(GuestError::InvalidCodexHistory("invalid turn status"))?;
                        }
                        if !turn.get("items").and_then(Value::as_array).is_some_and(Vec::is_empty)
                            || turn.get("itemsView").and_then(Value::as_str) != Some("notLoaded") {
                            Err(GuestError::InvalidCodexHistory("unexpected hydrated turn"))?;
                        }
                        referenced_turns.remove(turn_id);
                    }
                    cursor = next_cursor(&snapshot.result, &mut seen_cursors)?;
                    yield CodexHistoryPage { part: CodexHistoryPart::Turns, snapshot };
                    if cursor.is_none() { break; }
                }
                if !referenced_turns.is_empty() {
                    Err(GuestError::InvalidCodexHistory("item has no turn"))?;
                }
            }
        });
        Ok(Box::pin(try_stream! {
            tokio::pin!(source);
            while let Some(page) = timeout_at(deadline, source.next()).await
                .map_err(|_| GuestError::CodexHistoryTimeout)? {
                yield page?;
            }
        }))
    }
}

fn validate_thread(value: &Value, thread_id: &str) -> Result<(), GuestError> {
    if value.pointer("/thread/id").and_then(Value::as_str) != Some(thread_id) {
        return Err(GuestError::InvalidCodexHistory("thread identity mismatch"));
    }
    Ok(())
}

fn required_id<'a>(value: &'a Value, key: &str) -> Result<&'a str, GuestError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or(GuestError::InvalidCodexHistory("missing history identity"))
}

fn history_page<'a>(
    response: &'a CodexCallResult,
    budget: &mut HistoryBudget,
) -> Result<&'a [Value], GuestError> {
    budget.include(response)?;
    response
        .result
        .get("data")
        .and_then(Value::as_array)
        .filter(|data| data.len() <= PAGE_SIZE)
        .map(Vec::as_slice)
        .ok_or(GuestError::InvalidCodexHistory("invalid history page"))
}

fn next_cursor(page: &Value, seen: &mut HashSet<String>) -> Result<Option<String>, GuestError> {
    match page.get("nextCursor") {
        Some(Value::Null) => Ok(None),
        Some(Value::String(cursor)) if !cursor.is_empty() && seen.insert(cursor.clone()) => {
            Ok(Some(cursor.clone()))
        }
        _ => Err(GuestError::InvalidCodexHistory(
            "invalid or repeated history cursor",
        )),
    }
}
