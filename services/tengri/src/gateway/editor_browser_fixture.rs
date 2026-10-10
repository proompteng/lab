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
            json!({"apiVersion":"runtime.proompteng.ai/v1alpha1","kind":"MicroVM","metadata":{"name":"editor-fixture","uid":"33333333-3333-4333-8333-333333333333","generation":1},"spec":{
                "reservationId":"55555555-5555-4555-8555-555555555555","policyVersion":1,"runtimeEpoch":"44444444-4444-4444-8444-444444444444","displayName":"Editor fixture","ownerHash":"a".repeat(64),"desiredState":"Running","image":"test","architecture":"amd64",
                "resources":{"cpuMillis":4000,"memoryMib":8192,"workspaceGib":32},"createdAt":"2026-09-08T00:00:00Z","idleDeadline":"2099-01-01T00:00:00Z",
                "slot":{"name":"editor-fixture","podUid":"editor-fixture","pvcName":"editor-fixture-home","pvcUid":"editor-fixture-home-incarnation","epoch":1}
            },"status":{"phase":"Ready","guestReady":true,"observedGeneration":1,"podIp":"127.0.0.1","podUid":"editor-fixture"}})
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
            Arc::new(crate::control::Database::shared_fixture().await),
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
        crate::identity::WorkloadIdentity::Fixture(8080),
        crate::authz::WorkspaceAuthorization::Fixture,
    )
    .unwrap();
    let issue_state = state.clone();
    let issue = get(move |Query(query): Query<HashMap<String, String>>| {
        let state = issue_state.clone();
        async move {
            let guest = GuestClient::for_agent(
                state.client.clone(),
                "tengri",
                "editor-fixture",
                &crate::identity::WorkloadIdentity::Fixture(8080),
            )
            .await
            .unwrap();
            guest.open_editor().await.unwrap();
            let ticket = state
                .tickets
                .issue_editor(
                    &fixture_principal(crate::ofz::proto::Action::EditorOpen),
                    "editor-fixture",
                    query.get("window").unwrap(),
                )
                .await
                .unwrap();
            axum::Json(
                json!({"id":ticket.id,"launchUrl":ticket.url,"expiresAt":ticket.expires_at,"previewOrigin":state.preview_origin.origin(&ticket.id)}),
            )
        }
    });
    let browser_state = state.clone();
    let browser = get(move || {
        let state = browser_state.clone();
        async move {
            let guest = GuestClient::for_agent(
                state.client.clone(),
                "tengri",
                "editor-fixture",
                &crate::identity::WorkloadIdentity::Fixture(8080),
            )
            .await
            .unwrap();
            guest.open_browser().await.unwrap();
            let ticket = state
                .tickets
                .issue_preview(
                    &fixture_principal(crate::ofz::proto::Action::BrowserControl),
                    "editor-fixture",
                    crate::guest::BROWSER_PORT,
                    "/",
                    "",
                )
                .await
                .unwrap();
            axum::Json(
                json!({"id":ticket.id,"launchUrl":ticket.url,"expiresAt":ticket.expires_at,"previewOrigin":state.preview_origin.origin(&ticket.id)}),
            )
        }
    });
    let files_state = state.clone();
    let files = get(move |Query(query): Query<HashMap<String, String>>| {
        let state = files_state.clone();
        async move {
            let guest = GuestClient::for_agent(
                state.client.clone(),
                "tengri",
                "editor-fixture",
                &crate::identity::WorkloadIdentity::Fixture(8080),
            )
            .await
            .unwrap();
            let files = guest.list_files(query.get("path").unwrap()).await.unwrap();
            axum::Json(json!({"path": files.path, "entries": files.entries}))
        }
    });
    let revoke_state = state.clone();
    let revoke = post(move |axum::Json(value): axum::Json<Value>| {
        let state = revoke_state.clone();
        async move {
            state
                .tickets
                .revoke_preview_lease(
                    &fixture_principal(crate::ofz::proto::Action::PreviewAccess),
                    "editor-fixture",
                    value["sessionId"].as_str().unwrap(),
                    value["revocationToken"].as_str().unwrap(),
                )
                .await
                .unwrap();
            StatusCode::NO_CONTENT
        }
    });
    let revoke_desktop_previews_state = state.clone();
    let revoke_desktop_previews = post(move || {
        let state = revoke_desktop_previews_state.clone();
        async move {
            state
                .tickets
                .revoke_desktop_previews(&fixture_principal(
                    crate::ofz::proto::Action::PreviewAccess,
                ))
                .await
                .unwrap();
            StatusCode::NO_CONTENT
        }
    });
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let control = control_router(state.clone())
        .route("/_test/editor", issue)
        .route("/_test/browser", browser)
        .route("/_test/files", files)
        .route("/_test/revoke", revoke)
        .route("/_test/revoke-desktop-previews", revoke_desktop_previews)
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

fn fixture_principal(action: crate::ofz::proto::Action) -> crate::auth::Principal {
    crate::auth::Principal::fixture(
        &"a".repeat(64),
        "33333333-3333-4333-8333-333333333333",
        action,
    )
}
