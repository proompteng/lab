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
    let client = editor_fixture_client();
    let state = GatewayState::new(
        client.clone(),
        "tengri".to_owned(),
        TicketStore::new(
            (if https {
                "https://gateway.tengri.localhost:3443"
            } else {
                "http://localhost:18082"
            })
            .to_owned(),
            Arc::new(crate::control::Database::shared_fixture().await),
        )
        .unwrap(),
        ActivityTracker::new(client.clone(), "tengri".to_owned()),
        PreviewOrigin::parse(
            (if https {
                "https://tengri-{session}.tengri.localhost:3443"
            } else {
                "http://tengri-{session}.tengri.localhost:18083"
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
        crate::guest::GuestPool::new(
            client,
            "tengri",
            crate::identity::WorkloadIdentity::Fixture(8080),
        ),
        crate::guest::authorization::GuestAuthority::fixture(),
    )
    .unwrap();
    // Accelerate real cookie expiry only in this disposable, cfg(test) fixture.
    let mut state = state;
    state.tickets = state.tickets.with_preview_lifetime(60_000);
    let issue_state = state.clone();
    let issue = get(move |Query(query): Query<HashMap<String, String>>| {
        let state = issue_state.clone();
        async move {
            let guest = state
                .guests
                .for_agent(
                    "editor-fixture",
                    None,
                    crate::guest::authorization::GuestAuthority::fixture_authorization(),
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
    let browser = get(move |Query(query): Query<HashMap<String, String>>| {
        let state = browser_state.clone();
        async move {
            let guest = state
                .guests
                .for_agent(
                    "editor-fixture",
                    None,
                    crate::guest::authorization::GuestAuthority::fixture_authorization(),
                )
                .await
                .unwrap();
            guest.open_browser().await.unwrap();
            let ticket = state
                .tickets
                .issue_browser(
                    &fixture_principal(crate::ofz::proto::Action::BrowserControl),
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
    let files_state = state.clone();
    let files = get(move |Query(query): Query<HashMap<String, String>>| {
        let state = files_state.clone();
        async move {
            let guest = state
                .guests
                .for_agent(
                    "editor-fixture",
                    None,
                    crate::guest::authorization::GuestAuthority::fixture_authorization(),
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
    let control_listener = tokio::net::TcpListener::bind("127.0.0.1:18082")
        .await
        .unwrap();
    let preview_listener = tokio::net::TcpListener::bind("127.0.0.1:18083")
        .await
        .unwrap();
    let mut control_shutdown = shutdown_rx.clone();
    let mut preview_shutdown = shutdown_rx;
    eprintln!("Editor gateway fixture listening on 18082 / 18083");
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
    let mut principal = crate::auth::Principal::fixture(
        &"a".repeat(64),
        "11111111-1111-4111-8111-111111111111",
        action,
    );
    principal.context.runtime_epoch = "22222222-2222-4222-8222-222222222222".into();
    principal
}

fn editor_fixture_client() -> Client {
    let agent = Arc::new(std::sync::Mutex::new(
        json!({"apiVersion":"runtime.proompteng.ai/v1alpha1","kind":"MicroVM","metadata":{"name":"editor-fixture","uid":"11111111-1111-4111-8111-111111111111","generation":1,"resourceVersion":"1"},"spec":{
                "reservationId":"55555555-5555-4555-8555-555555555555","policyVersion":1,"runtimeEpoch":"22222222-2222-4222-8222-222222222222","displayName":"Editor fixture","ownerHash":"a".repeat(64),"desiredState":"Running","image":"test","architecture":"amd64",
                "resources":{"cpuMillis":4000,"memoryMib":8192,"workspaceGib":32},"createdAt":"2026-09-08T00:00:00Z","idleDeadline":"2099-01-01T00:00:00Z",
                "slot":{"name":"editor-fixture","podUid":"33333333-3333-4333-8333-333333333333","pvcName":"editor-fixture-home","pvcUid":"editor-fixture-home-incarnation","epoch":7}
            },"status":{"phase":"Ready","guestReady":true,"observedGeneration":1,"podIp":"127.0.0.1","podUid":"33333333-3333-4333-8333-333333333333"}}),
    ));
    let service = tower::service_fn(move |request: Request<KubeBody>| {
        let agent = agent.clone();
        async move {
            let mut status = StatusCode::OK;
            let value = if request.uri().path().contains("/secrets/") {
                json!({"apiVersion":"v1","kind":"Secret","metadata":{"name":"editor-fixture-bootstrap"},"data":{"token":"ZWRpdG9yLWJyb3dzZXItZml4dHVyZQ=="}})
            } else if request.method() == http::Method::PATCH {
                let patch: Value =
                    serde_json::from_slice(&request.into_body().collect_bytes().await.unwrap())
                        .unwrap();
                let mut current = agent.lock().unwrap();
                let metadata = &patch["metadata"];
                if ["uid", "resourceVersion"].iter().any(|key| {
                    metadata
                        .get(key)
                        .is_some_and(|value| value != &current["metadata"][key])
                }) {
                    status = StatusCode::CONFLICT;
                    json!({"apiVersion":"v1","kind":"Status","status":"Failure","reason":"Conflict","message":"fixture metadata changed","code":409})
                } else {
                    if let Some(annotations) = metadata["annotations"].as_object() {
                        if !current["metadata"]["annotations"].is_object() {
                            current["metadata"]["annotations"] = json!({});
                        }
                        for (key, value) in annotations {
                            if value.is_null() {
                                current["metadata"]["annotations"]
                                    .as_object_mut()
                                    .unwrap()
                                    .remove(key);
                            } else {
                                current["metadata"]["annotations"][key] = value.clone();
                            }
                        }
                    }
                    let version = current["metadata"]["resourceVersion"]
                        .as_str()
                        .unwrap()
                        .parse::<u64>()
                        .unwrap()
                        + 1;
                    current["metadata"]["resourceVersion"] = json!(version.to_string());
                    current.clone()
                }
            } else {
                assert_eq!(request.method(), http::Method::GET);
                assert!(request.uri().path().ends_with("/microvms/editor-fixture"));
                agent.lock().unwrap().clone()
            };
            Ok::<_, std::io::Error>(
                Response::builder()
                    .status(status)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(KubeBody::from(value.to_string().into_bytes()))
                    .unwrap(),
            )
        }
    });
    Client::new(service, "tengri")
}

#[tokio::test]
async fn editor_fixture_models_control_activity_and_idle_sleep_cas() {
    let client = editor_fixture_client();
    let api = kube::Api::<crate::crd::MicroVM>::namespaced(client.clone(), "tengri");
    let before = api.get("editor-fixture").await.unwrap();
    let tracker = ActivityTracker::new(client.clone(), "tengri".into());
    let claim = crate::slot::client::claim_for(&before).unwrap();
    tracker
        .admit_control(&claim)
        .await
        .expect("real preview control admission must work in the fixture");
    let current = api.get("editor-fixture").await.unwrap();
    assert_ne!(
        before.metadata.resource_version,
        current.metadata.resource_version
    );
    assert!(crate::activity::last_activity_at(&current).unwrap() > before.spec.created_at);
    assert!(
        crate::activity::claim_idle_sleep(client.clone(), "tengri", &before)
            .await
            .is_err(),
        "stale idle decisions must conflict with admitted control"
    );
    crate::activity::claim_idle_sleep(client, "tengri", &current)
        .await
        .unwrap();
    assert_eq!(
        tracker.admit_control(&claim).await.unwrap_err().code(),
        tonic::Code::FailedPrecondition
    );
}
