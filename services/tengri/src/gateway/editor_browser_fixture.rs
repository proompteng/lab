use super::*;
use axum::extract::Query;
use kube::client::Body as KubeBody;
use serde_json::{Value, json};

#[tokio::test]
#[ignore = "started by the real VS Code acceptance runner"]
async fn editor_browser_acceptance_fixture() {
    assert_eq!(
        std::env::var("TENGRI_EDITOR_BROWSER_FIXTURE").as_deref(),
        Ok("1")
    );
    let https = std::env::var("TENGRI_EDITOR_TEST_HTTPS").as_deref() == Ok("1");
    let service = tower::service_fn(|request: Request<KubeBody>| async move {
        let value = if request.uri().path().contains("/secrets/") {
            json!({"apiVersion":"v1","kind":"Secret","metadata":{"name":"editor-fixture-bootstrap"},"data":{"token":"ZWRpdG9yLWJyb3dzZXItZml4dHVyZQ=="}})
        } else {
            json!({"apiVersion":"runtime.proompteng.ai/v1alpha1","kind":"MicroVM","metadata":{"name":"editor-fixture","uid":"editor-fixture-incarnation","generation":1},"spec":{
                "displayName":"Editor fixture","ownerHash":"a".repeat(64),"desiredState":"Running","image":"test","architecture":"amd64",
                "resources":{"cpuMillis":2000,"memoryMib":4096,"workspaceGib":16},"createdAt":"2026-09-08T00:00:00Z","idleDeadline":"2099-01-01T00:00:00Z"
            },"status":{"phase":"Ready","guestReady":true,"observedGeneration":1,"podIp":"127.0.0.1"}})
        };
        Ok::<_, std::io::Error>(
            Response::builder()
                .header(header::CONTENT_TYPE, "application/json")
                .body(KubeBody::from(value.to_string().into_bytes()))
                .unwrap(),
        )
    });
    let client = Client::new(service, "tengri");
    let state = GatewayState::new(
        client.clone(),
        "tengri".to_owned(),
        TicketStore::new(
            (if https {
                "https://gateway.tengri.localhost:3443"
            } else {
                "http://localhost:33082"
            })
            .to_owned(),
            "editor-test-signing-secret-at-least-32-bytes".to_owned(),
        )
        .unwrap(),
        ActivityTracker::new(client, "tengri".to_owned()),
        PreviewOrigin::parse(
            (if https {
                "https://tengri-{session}.tengri.localhost:3443"
            } else {
                "http://tengri-{session}.tengri.localhost:33083"
            })
            .to_owned(),
            (if https {
                "https://desktop.tengri.localhost:3443"
            } else {
                "http://desktop.tengri.localhost:3143"
            })
            .to_owned(),
        )
        .unwrap(),
    )
    .unwrap();
    let issue_state = state.clone();
    let issue = get(move |Query(query): Query<HashMap<String, String>>| {
        let state = issue_state.clone();
        async move {
            let guest = GuestClient::for_agent(state.client.clone(), "tengri", "editor-fixture")
                .await
                .unwrap();
            guest.open_editor().await.unwrap();
            let ticket = state
                .tickets
                .issue_editor(
                    &"a".repeat(64),
                    "editor-fixture",
                    "editor-fixture-incarnation",
                    query.get("window").unwrap(),
                )
                .unwrap();
            axum::Json(
                json!({"id":ticket.id,"launchUrl":ticket.url,"expiresAt":ticket.expires_at,"previewOrigin":state.preview_origin.origin(&ticket.id)}),
            )
        }
    });
    let revoke_state = state.clone();
    let revoke = post(move |axum::Json(value): axum::Json<Value>| {
        let state = revoke_state.clone();
        async move {
            state
                .tickets
                .revoke_preview_lease(
                    &"a".repeat(64),
                    "editor-fixture",
                    value["sessionId"].as_str().unwrap(),
                    value["revocationToken"].as_str().unwrap(),
                )
                .unwrap();
            StatusCode::NO_CONTENT
        }
    });
    let revoke_editors_state = state.clone();
    let revoke_editors = post(move || {
        let state = revoke_editors_state.clone();
        async move {
            state.tickets.revoke_editors(&"a".repeat(64)).unwrap();
            StatusCode::NO_CONTENT
        }
    });
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let control = control_router(state.clone())
        .route("/_test/editor", issue)
        .route("/_test/revoke", revoke)
        .route("/_test/revoke-editors", revoke_editors)
        .route(
            "/_test/shutdown",
            post(move || {
                let tx = shutdown_tx.clone();
                async move {
                    let _ = tx.send(true);
                    StatusCode::NO_CONTENT
                }
            }),
        );
    let preview = preview_router(state);
    let control_listener = tokio::net::TcpListener::bind("127.0.0.1:33082")
        .await
        .unwrap();
    let preview_listener = tokio::net::TcpListener::bind("127.0.0.1:33083")
        .await
        .unwrap();
    let mut control_shutdown = shutdown_rx.clone();
    let mut preview_shutdown = shutdown_rx;
    eprintln!("Editor gateway fixture listening on 33082 / 33083");
    let (a, b) = tokio::join!(
        axum::serve(control_listener, control).with_graceful_shutdown(async move {
            let _ = control_shutdown.changed().await;
        }),
        axum::serve(preview_listener, preview).with_graceful_shutdown(async move {
            let _ = preview_shutdown.changed().await;
        })
    );
    a.unwrap();
    b.unwrap();
}
