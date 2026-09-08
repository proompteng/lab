use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

use axum::{Json, Router, http::StatusCode, routing::post};

use super::*;

struct Fixture {
    client: GuestClient,
    requests: Arc<Mutex<Vec<Value>>>,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn fixture(replies: Vec<(StatusCode, Value)>) -> Fixture {
    let replies = Arc::new(Mutex::new(VecDeque::from(replies)));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let recorded = requests.clone();
    let router = Router::new().route(
        "/v1/codex/call",
        post(move |Json(request): Json<Value>| {
            recorded.lock().unwrap().push(request);
            let reply = replies
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected Codex call");
            async move { (reply.0, Json(reply.1)) }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    Fixture {
        client: GuestClient {
            http: reqwest::Client::new(),
            base_url: format!("http://{address}"),
            token: "fixture-token".into(),
        },
        requests,
        server,
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
    let snapshot = fixture
        .client
        .resume_codex_thread("thread-one")
        .await
        .unwrap();
    assert_eq!(snapshot.event_sequence, 10);
    assert_eq!(
        snapshot.item_event_sequences,
        HashMap::from([("item-one".into(), 20), ("item-two".into(), 30)])
    );
    assert_eq!(
        snapshot.result["thread"]["turns"][0]["items"][0]["text"],
        "First page"
    );
    assert_eq!(
        snapshot.result["thread"]["turns"][1]["items"][0]["text"],
        "Second page"
    );
    assert_eq!(snapshot.result["thread"]["turns"][2]["items"], json!([]));
    assert_eq!(
        snapshot.result["thread"]["turns"][2]["status"],
        "inProgress"
    );
    assert_eq!(snapshot.result["model"], "fixture-model");
    let requests = fixture.requests.lock().unwrap();
    assert_eq!(requests.len(), 5);
    assert_eq!(
        requests[0],
        json!({"method":"thread/resume", "params": {
            "threadId":"thread-one", "cwd":"/workspace", "runtimeWorkspaceRoots":["/workspace"],
            "approvalPolicy":"on-request", "sandbox":"danger-full-access", "excludeTurns":true
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
    let snapshot = fixture
        .client
        .resume_codex_thread("thread-one")
        .await
        .unwrap();
    assert_eq!(snapshot.result, legacy);
    assert_eq!(snapshot.event_sequence, 20);
    assert!(snapshot.item_event_sequences.is_empty());
    let requests = fixture.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0]["params"]["excludeTurns"], true);
    assert_eq!(requests[1]["method"], "thread/resume");
    assert_eq!(requests[1]["params"]["excludeTurns"], false);
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
                .resume_codex_thread("thread-one")
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
        fixture.client.resume_codex_thread("thread-one").await,
        Err(GuestError::Api {
            status: StatusCode::SERVICE_UNAVAILABLE,
            ..
        })
    ));
    assert_eq!(fixture.requests.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn bounds_total_history_even_when_individual_pages_are_within_limits() {
    let text = "x".repeat(MAX_GUEST_JSON_BYTES / 2 + 1);
    let fixture = fixture(vec![
        reply(10, resumed("paginated")),
        reply(20, page(json!([item("one", "one", &text)]), json!("next"))),
        reply(21, page(json!([item("one", "two", &text)]), Value::Null)),
    ])
    .await;
    assert!(matches!(
        fixture.client.resume_codex_thread("thread-one").await,
        Err(GuestError::ResponseTooLarge(MAX_GUEST_JSON_BYTES))
    ));
}

#[tokio::test]
async fn rejects_mismatched_thread_identity_and_unknown_history_mode() {
    for mut response in [resumed("paginated"), resumed("future-format")] {
        if response["thread"]["historyMode"] == "paginated" {
            response["thread"]["id"] = json!("another-thread");
        }
        let fixture = fixture(vec![reply(10, response)]).await;
        assert!(matches!(
            fixture.client.resume_codex_thread("thread-one").await,
            Err(GuestError::InvalidCodexHistory(_))
        ));
        assert_eq!(fixture.requests.lock().unwrap().len(), 1);
    }
}
