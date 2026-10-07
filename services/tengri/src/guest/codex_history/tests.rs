use futures::TryStreamExt;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

use crate::guest::rpc::{
    proto,
    test_server::{TestServer, TestService},
};
use reqwest::StatusCode;

use super::*;

struct Fixture {
    client: GuestClient,
    requests: Arc<Mutex<Vec<Value>>>,
    _server: TestServer,
}

async fn fixture(replies: Vec<(StatusCode, Value)>) -> Fixture {
    let replies = Arc::new(Mutex::new(VecDeque::from(replies)));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let recorded = requests.clone();
    let server = TestServer::start(TestService {
        codex_call: Some(Arc::new(move |request| {
            let request = request.into_inner();
            recorded.lock().unwrap().push(json!({"method": request.method, "params": serde_json::from_slice::<Value>(&request.params_json).unwrap()}));
            let (status, reply) = replies.lock().unwrap().pop_front().expect("unexpected Codex call");
            if status != StatusCode::OK {
                return Err(if status == StatusCode::NOT_FOUND { tonic::Status::not_found(reply.to_string()) } else { tonic::Status::unavailable(reply.to_string()) });
            }
            Ok(proto::CodexResult { result_json: serde_json::to_vec(&reply["result"]).unwrap(), event_sequence: reply["eventSequence"].as_u64().unwrap() })
        })), ..Default::default()
    }).await;
    Fixture {
        client: server.guest.clone(),
        requests,
        _server: server,
    }
}

fn reply(sequence: u64, result: Value) -> (StatusCode, Value) {
    (
        StatusCode::OK,
        json!({"eventSequence": sequence, "result": result}),
    )
}

fn resumed(mode: &str) -> Value {
    json!({"thread": {"id": "thread-one", "historyMode": mode, "turns": []}, "model": "fixture-model"})
}

fn page(data: Value, cursor: Value) -> Value {
    json!({"data": data, "nextCursor": cursor})
}

fn item(turn: &str, id: &str, text: &str) -> Value {
    json!({"turnId": turn, "item": {"id": id, "type": "agentMessage", "text": text}})
}

fn turn(id: &str, status: &str) -> Value {
    json!({"id": id, "items": [], "itemsView": "notLoaded", "status": status, "error": null})
}

#[tokio::test]
async fn loads_all_pages_and_preserves_each_items_snapshot_cursor() {
    let fixture = fixture(vec![
        reply(10, resumed("paginated")),
        reply(
            20,
            page(
                json!([item("turn-one", "item-one", "First page")]),
                json!("items-2"),
            ),
        ),
        reply(
            30,
            page(
                json!([item("turn-two", "item-two", "Second page")]),
                Value::Null,
            ),
        ),
        reply(
            32,
            page(json!([turn("turn-one", "completed")]), json!("turns-2")),
        ),
        reply(
            34,
            page(
                json!([
                    turn("turn-two", "inProgress"),
                    turn("turn-three", "inProgress")
                ]),
                Value::Null,
            ),
        ),
    ])
    .await;
    let mut history = fixture
        .client
        .resume_codex_thread(
            "thread-one",
            &CodexOptions::parse("gpt-6.1-sol".into(), "high".into()).unwrap(),
        )
        .await
        .unwrap();
    let pages = history.by_ref().try_collect::<Vec<_>>().await.unwrap();
    assert_eq!(pages.len(), 5);
    assert_eq!(pages[0].part, CodexHistoryPart::Thread);
    assert_eq!(pages[0].snapshot.event_sequence, 10);
    assert_eq!(pages[0].snapshot.result["model"], "fixture-model");
    assert_eq!(pages[1].part, CodexHistoryPart::Items);
    assert_eq!(pages[1].snapshot.event_sequence, 20);
    assert_eq!(
        pages[1].snapshot.result["data"][0]["item"]["text"],
        "First page"
    );
    assert_eq!(pages[2].snapshot.event_sequence, 30);
    assert_eq!(
        pages[2].snapshot.result["data"][0]["item"]["text"],
        "Second page"
    );
    assert_eq!(pages[4].part, CodexHistoryPart::Turns);
    assert_eq!(pages[4].snapshot.result["data"][1]["items"], json!([]));
    assert_eq!(pages[4].snapshot.result["data"][1]["status"], "inProgress");
    let requests = fixture.requests.lock().unwrap();
    assert_eq!(requests.len(), 5);
    assert_eq!(
        requests[0],
        json!({"method":"thread/resume", "params": {
            "threadId":"thread-one", "cwd":"/workspace", "runtimeWorkspaceRoots":["/workspace"],
            "approvalPolicy":"on-request", "sandbox":"danger-full-access", "excludeTurns":true,
            "model":"gpt-6.1-sol", "config":{"model_reasoning_effort":"high"}
        }})
    );
    assert_eq!(
        requests[1],
        json!({"method":"thread/items/list", "params": {
            "threadId":"thread-one", "cursor":null, "limit":100, "sortDirection":"asc"
        }})
    );
    assert_eq!(requests[2]["params"]["cursor"], "items-2");
    assert_eq!(
        requests[3],
        json!({"method":"thread/turns/list", "params": {
            "threadId":"thread-one", "cursor":null, "limit":100, "sortDirection":"asc", "itemsView":"notLoaded"
        }})
    );
    assert_eq!(requests[4]["params"]["cursor"], "turns-2");
}

#[tokio::test]
async fn legacy_threads_keep_the_atomic_full_snapshot_contract() {
    let mut legacy = resumed("legacy");
    legacy["thread"]["turns"] = json!([{"id":"legacy-turn", "status":"completed", "items":[
        {"id":"reconstructed-item", "type":"agentMessage", "text":"Persisted history"}
    ]}]);
    let fixture = fixture(vec![
        reply(10, resumed("legacy")),
        reply(20, legacy.clone()),
    ])
    .await;
    let mut history = fixture
        .client
        .resume_codex_thread("thread-one", &CodexOptions::default())
        .await
        .unwrap();
    let page = history.next().await.unwrap().unwrap();
    assert_eq!(page.part, CodexHistoryPart::Thread);
    assert_eq!(page.snapshot.result, legacy);
    assert_eq!(page.snapshot.event_sequence, 20);
    assert!(history.next().await.is_none());
    let requests = fixture.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0]["params"]["excludeTurns"], true);
    assert_eq!(requests[0]["params"]["model"], Value::Null);
    assert_eq!(requests[1]["method"], "thread/resume");
    assert_eq!(requests[1]["params"]["excludeTurns"], false);
    assert_eq!(requests[1]["params"]["model"], Value::Null);
}

#[tokio::test]
async fn rejects_broken_page_contracts_without_returning_partial_history() {
    for pages in [
        vec![reply(20, json!({"data":[]}))],
        vec![reply(20, page(json!([]), json!(42)))],
        vec![
            reply(20, page(json!([]), json!("again"))),
            reply(21, page(json!([]), json!("again"))),
        ],
        vec![
            reply(20, page(json!([]), json!("next"))),
            reply(19, page(json!([]), Value::Null)),
        ],
        vec![reply(
            20,
            page(
                json!([item("one", "duplicate", "a"), item("one", "duplicate", "b")]),
                Value::Null,
            ),
        )],
        vec![
            reply(
                20,
                page(json!([item("missing-turn", "one", "orphan")]), Value::Null),
            ),
            reply(21, page(json!([]), Value::Null)),
        ],
        vec![
            reply(20, page(json!([]), Value::Null)),
            reply(21, page(json!([turn("one", "unknown")]), Value::Null)),
        ],
        vec![
            reply(20, page(json!([]), Value::Null)),
            reply(
                21,
                page(
                    json!([turn("one", "completed"), turn("one", "completed")]),
                    Value::Null,
                ),
            ),
        ],
    ] {
        let mut replies = vec![reply(10, resumed("paginated"))];
        replies.extend(pages);
        let fixture = fixture(replies).await;
        assert!(
            fixture
                .client
                .resume_codex_thread("thread-one", &CodexOptions::default())
                .await
                .unwrap()
                .try_collect::<Vec<_>>()
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn propagates_upstream_failure_and_does_not_fall_back_to_deprecated_hydration() {
    let fixture = fixture(vec![
        reply(10, resumed("paginated")),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"error":"history storage unavailable"}),
        ),
    ])
    .await;
    assert!(matches!(
        fixture
            .client
            .resume_codex_thread("thread-one", &CodexOptions::default())
            .await
            .unwrap()
            .try_collect::<Vec<_>>()
            .await,
        Err(GuestError::Api {
            status: StatusCode::SERVICE_UNAVAILABLE,
            ..
        })
    ));
    assert_eq!(fixture.requests.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn restores_history_larger_than_one_message_when_each_page_is_bounded() {
    let text = "x".repeat(MAX_GUEST_JSON_BYTES / 2 + 1);
    let fixture = fixture(vec![
        reply(10, resumed("paginated")),
        reply(20, page(json!([item("one", "one", &text)]), json!("next"))),
        reply(21, page(json!([item("one", "two", &text)]), Value::Null)),
        reply(22, page(json!([turn("one", "completed")]), Value::Null)),
    ])
    .await;
    let pages = fixture
        .client
        .resume_codex_thread("thread-one", &CodexOptions::default())
        .await
        .unwrap()
        .try_collect::<Vec<_>>()
        .await
        .unwrap();
    assert_eq!(pages.len(), 4);
    assert!(pages.iter().all(
        |page| serde_json::to_vec(&page.snapshot.result).unwrap().len() <= MAX_GUEST_JSON_BYTES
    ));
    assert!(
        pages
            .iter()
            .map(|page| serde_json::to_vec(&page.snapshot.result).unwrap().len())
            .sum::<usize>()
            > MAX_GUEST_JSON_BYTES
    );
    assert_eq!(pages[1].snapshot.result["data"][0]["item"]["id"], "one");
    assert_eq!(pages[2].snapshot.result["data"][0]["item"]["id"], "two");
}

#[tokio::test]
async fn rejects_mismatched_thread_identity_and_unknown_history_mode() {
    for mut response in [resumed("paginated"), resumed("future-format")] {
        if response["thread"]["historyMode"] == "paginated" {
            response["thread"]["id"] = json!("another-thread");
        }
        let fixture = fixture(vec![reply(10, response)]).await;
        assert!(matches!(
            fixture
                .client
                .resume_codex_thread("thread-one", &CodexOptions::default())
                .await,
            Err(GuestError::InvalidCodexHistory(_))
        ));
        assert_eq!(fixture.requests.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn does_not_fetch_history_ahead_of_the_reader_and_stops_on_drop() {
    let fixture = fixture(vec![
        reply(10, resumed("paginated")),
        reply(20, page(json!([item("one", "one", "page")]), Value::Null)),
        reply(21, page(json!([turn("one", "completed")]), Value::Null)),
    ])
    .await;
    let mut history = fixture
        .client
        .resume_codex_thread("thread-one", &CodexOptions::default())
        .await
        .unwrap();
    assert_eq!(fixture.requests.lock().unwrap().len(), 1);
    assert_eq!(
        history.next().await.unwrap().unwrap().part,
        CodexHistoryPart::Thread
    );
    assert_eq!(fixture.requests.lock().unwrap().len(), 1);
    assert_eq!(
        history.next().await.unwrap().unwrap().part,
        CodexHistoryPart::Items
    );
    assert_eq!(fixture.requests.lock().unwrap().len(), 2);
    drop(history);
    tokio::task::yield_now().await;
    assert_eq!(fixture.requests.lock().unwrap().len(), 2);
}

#[test]
fn bounds_each_history_page_and_the_number_of_pages() {
    let mut budget = HistoryBudget::default();
    let response = CodexCallResult {
        result: json!({"text": "x".repeat(MAX_GUEST_JSON_BYTES)}),
        event_sequence: 1,
    };
    assert!(matches!(
        budget.include(&response),
        Err(GuestError::ResponseTooLarge(MAX_GUEST_JSON_BYTES))
    ));
    let mut budget = HistoryBudget::default();
    let response = CodexCallResult {
        result: json!({}),
        event_sequence: 1,
    };
    for _ in 0..MAX_HISTORY_PAGES {
        budget.include(&response).unwrap();
    }
    assert!(matches!(
        budget.include(&response),
        Err(GuestError::InvalidCodexHistory("too many history pages"))
    ));
}
