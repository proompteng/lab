use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

use serde::Deserialize;
use serde_json::{Value, json};

use super::{CodexCallResult, GuestClient, GuestError, MAX_GUEST_JSON_BYTES};

#[cfg(test)]
mod tests;

const PAGE_SIZE: usize = 100;
const MAX_HISTORY_PAGES: usize = 256;
const HISTORY_TIMEOUT: Duration = Duration::from_secs(90);

pub struct CodexThreadSnapshot {
    pub result: Value,
    pub event_sequence: u64,
    pub item_event_sequences: HashMap<String, u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryPage {
    data: Vec<Value>,
    next_cursor: Value,
}

#[derive(Default)]
struct HistoryBudget {
    pages: usize,
    bytes: usize,
    sequence: u64,
}

impl HistoryBudget {
    fn include(&mut self, value: &Value) -> Result<(), GuestError> {
        self.pages += 1;
        self.bytes += serde_json::to_vec(value)?.len();
        if self.pages > MAX_HISTORY_PAGES || self.bytes > MAX_GUEST_JSON_BYTES {
            return Err(GuestError::ResponseTooLarge(MAX_GUEST_JSON_BYTES));
        }
        Ok(())
    }
}

impl GuestClient {
    pub async fn resume_codex_thread(
        &self,
        thread_id: &str,
    ) -> Result<CodexThreadSnapshot, GuestError> {
        tokio::time::timeout(HISTORY_TIMEOUT, self.load_codex_history(thread_id))
            .await
            .map_err(|_| GuestError::CodexHistoryTimeout)?
    }

    async fn load_codex_history(&self, thread_id: &str) -> Result<CodexThreadSnapshot, GuestError> {
        let params = json!({
            "threadId": thread_id,
            "cwd": "/workspace",
            "runtimeWorkspaceRoots": ["/workspace"],
            "approvalPolicy": "on-request",
            "sandbox": "danger-full-access",
            "excludeTurns": true,
        });
        let mut snapshot = self
            .codex_call_with_sequence("thread/resume", params.clone())
            .await?;
        if snapshot
            .result
            .pointer("/thread/id")
            .and_then(Value::as_str)
            != Some(thread_id)
        {
            return Err(GuestError::InvalidCodexHistory("thread identity mismatch"));
        }
        match snapshot
            .result
            .pointer("/thread/historyMode")
            .and_then(Value::as_str)
        {
            Some("paginated") => {}
            Some("legacy") => {
                let mut legacy_params = params;
                legacy_params["excludeTurns"] = json!(false);
                let legacy = self
                    .codex_call_with_sequence("thread/resume", legacy_params)
                    .await?;
                if legacy.result.pointer("/thread/id").and_then(Value::as_str) != Some(thread_id)
                    || legacy
                        .result
                        .pointer("/thread/historyMode")
                        .and_then(Value::as_str)
                        != Some("legacy")
                    || !legacy
                        .result
                        .pointer("/thread/turns")
                        .is_some_and(Value::is_array)
                    || legacy.event_sequence < snapshot.event_sequence
                {
                    return Err(GuestError::InvalidCodexHistory("invalid legacy snapshot"));
                }
                return Ok(CodexThreadSnapshot {
                    result: legacy.result,
                    event_sequence: legacy.event_sequence,
                    item_event_sequences: HashMap::new(),
                });
            }
            _ => return Err(GuestError::InvalidCodexHistory("unknown history mode")),
        }

        let mut budget = HistoryBudget {
            sequence: snapshot.event_sequence,
            ..Default::default()
        };
        budget.include(&snapshot.result)?;
        let mut items_by_turn: HashMap<String, Vec<Value>> = HashMap::new();
        let mut item_event_sequences = HashMap::new();
        let mut cursor = None;
        let mut seen_cursors = HashSet::new();
        loop {
            let response = self.codex_call_with_sequence("thread/items/list", json!({
                "threadId": thread_id, "cursor": cursor, "limit": PAGE_SIZE, "sortDirection": "asc",
            })).await?;
            let sequence = response.event_sequence;
            let page = history_page(response, &mut budget)?;
            for entry in page.data {
                let turn_id = required_id(&entry, "turnId")?.to_owned();
                let item = entry
                    .get("item")
                    .filter(|item| item.is_object())
                    .ok_or(GuestError::InvalidCodexHistory("missing item"))?;
                let item_id = required_id(item, "id")?.to_owned();
                if item_event_sequences.insert(item_id, sequence).is_some() {
                    return Err(GuestError::InvalidCodexHistory("duplicate item"));
                }
                items_by_turn.entry(turn_id).or_default().push(item.clone());
            }
            cursor = next_cursor(page.next_cursor, &mut seen_cursors)?;
            if cursor.is_none() {
                break;
            }
        }

        let mut turns = Vec::new();
        let mut seen_turns = HashSet::new();
        cursor = None;
        seen_cursors.clear();
        loop {
            let response = self
                .codex_call_with_sequence(
                    "thread/turns/list",
                    json!({
                        "threadId": thread_id, "cursor": cursor, "limit": PAGE_SIZE,
                        "sortDirection": "asc", "itemsView": "notLoaded",
                    }),
                )
                .await?;
            let page = history_page(response, &mut budget)?;
            for mut turn in page.data {
                let turn_id = required_id(&turn, "id")?.to_owned();
                if !seen_turns.insert(turn_id.clone()) {
                    return Err(GuestError::InvalidCodexHistory("duplicate turn"));
                }
                if !matches!(
                    turn.get("status").and_then(Value::as_str),
                    Some("completed" | "interrupted" | "failed" | "inProgress")
                ) {
                    return Err(GuestError::InvalidCodexHistory("invalid turn status"));
                }
                if !turn
                    .get("items")
                    .and_then(Value::as_array)
                    .is_some_and(Vec::is_empty)
                {
                    return Err(GuestError::InvalidCodexHistory("unexpected hydrated turn"));
                }
                turn["items"] = Value::Array(items_by_turn.remove(&turn_id).unwrap_or_default());
                turn["itemsView"] = json!("full");
                turns.push(turn);
            }
            cursor = next_cursor(page.next_cursor, &mut seen_cursors)?;
            if cursor.is_none() {
                break;
            }
        }
        if !items_by_turn.is_empty() {
            return Err(GuestError::InvalidCodexHistory("item has no turn"));
        }
        snapshot.result["thread"]["turns"] = Value::Array(turns);
        if serde_json::to_vec(&snapshot.result)?.len() > MAX_GUEST_JSON_BYTES {
            return Err(GuestError::ResponseTooLarge(MAX_GUEST_JSON_BYTES));
        }
        Ok(CodexThreadSnapshot {
            result: snapshot.result,
            event_sequence: snapshot.event_sequence,
            item_event_sequences,
        })
    }
}

fn required_id<'a>(value: &'a Value, key: &str) -> Result<&'a str, GuestError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or(GuestError::InvalidCodexHistory("missing history identity"))
}

fn history_page(
    response: CodexCallResult,
    budget: &mut HistoryBudget,
) -> Result<HistoryPage, GuestError> {
    if response.event_sequence < budget.sequence {
        return Err(GuestError::InvalidCodexHistory(
            "event sequence moved backwards",
        ));
    }
    budget.sequence = response.event_sequence;
    budget.include(&response.result)?;
    let page: HistoryPage = serde_json::from_value(response.result)?;
    if page.data.len() > PAGE_SIZE {
        return Err(GuestError::InvalidCodexHistory(
            "page exceeded requested size",
        ));
    }
    Ok(page)
}

fn next_cursor(value: Value, seen: &mut HashSet<String>) -> Result<Option<String>, GuestError> {
    match value {
        Value::Null => Ok(None),
        Value::String(cursor) if !cursor.is_empty() && seen.insert(cursor.clone()) => {
            Ok(Some(cursor))
        }
        _ => Err(GuestError::InvalidCodexHistory(
            "invalid or repeated history cursor",
        )),
    }
}
