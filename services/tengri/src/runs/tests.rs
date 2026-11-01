use super::*;
use chrono::Utc;
use http::{Request, Response};
use kube::{Client, ResourceExt, client::Body};
use std::{
    net::TcpListener,
    process::{Child, Command, Stdio},
};

#[test]
fn a_dead_generation_requires_confirmed_command_cleanup() {
    for value in [
        serde_json::json!({"generationAlive": false}),
        serde_json::json!({"generationAlive": false, "processesStopped": false}),
        serde_json::json!({"generationAlive": true, "processesStopped": true}),
        serde_json::json!({"generationAlive": false, "processesStopped": "true"}),
        serde_json::json!({"processesStopped": true}),
    ] {
        assert_eq!(observed_operation(&value, "accepted-turn"), None);
    }
    assert!(matches!(
        observed_operation(
            &serde_json::json!({"generationAlive":false,"processesStopped":true}),
            "accepted-turn"
        ),
        Some(State::Failed { turn_id, reason })
            if turn_id == "accepted-turn" && reason.contains("work may be incomplete")
    ));
    assert_eq!(
        observed_operation(
            &serde_json::json!({"terminalStatus":"interrupted"}),
            "accepted-turn"
        ),
        Some(State::Cancelled {
            turn_id: "accepted-turn".into()
        })
    );
}

#[tokio::test]
async fn durable_recovery_does_not_inherit_the_server_pause_budget() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let endpoint = run_endpoint(Arc::new(fixture())).build();
    let server = tokio::spawn(async move { HttpServer::new(endpoint).serve(listener).await });
    let response = reqwest::Client::builder()
        .http2_prior_knowledge()
        .build()
        .unwrap()
        .get(format!("http://{address}/discover"))
        .header("accept", "application/vnd.restate.endpointmanifest.v4+json")
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    let manifest: serde_json::Value = response.json().await.unwrap();
    let services = manifest["services"].as_array().unwrap();
    assert_eq!(services.len(), 3);
    for service in services {
        assert_eq!(service["retryPolicyMaxAttempts"], u64::MAX, "{service}");
    }
    server.abort();
}

fn fixture() -> ControlPlane {
    let (service, mut handle) = tower_test::mock::pair::<Request<Body>, Response<Body>>();
    tokio::spawn(async move {
        let mut agent = crate::grpc::tests::provisional_terminal_test_agent(Utc::now());
        agent.spec.desired_state = crate::crd::MicroVMDesiredState::Sleeping;
        agent.status = Some(crate::crd::MicroVMStatus {
            phase: crate::crd::MicroVMPhase::Sleeping,
            ..Default::default()
        });
        agent.metadata.resource_version = Some("1".into());
        let mut version = 1;
        while let Some((request, response)) = handle.next_request().await {
            if request.method() == http::Method::PATCH {
                let patch: serde_json::Value =
                    serde_json::from_slice(&request.into_body().collect_bytes().await.unwrap())
                        .unwrap();
                assert_eq!(patch["metadata"]["uid"], agent.uid().unwrap());
                assert_eq!(
                    patch["metadata"]["resourceVersion"],
                    agent.resource_version().unwrap()
                );
                let annotations = patch["metadata"]["annotations"]
                    .as_object()
                    .expect("only the run fence can mutate in this fixture");
                assert_eq!(annotations.len(), 1);
                let value = annotations
                    .get(crate::activity::ACTIVE_RUN_ANNOTATION)
                    .unwrap();
                if let Some(value) = value.as_str() {
                    agent
                        .annotations_mut()
                        .insert(crate::activity::ACTIVE_RUN_ANNOTATION.into(), value.into());
                } else {
                    assert!(value.is_null());
                    agent
                        .annotations_mut()
                        .remove(crate::activity::ACTIVE_RUN_ANNOTATION);
                }
                version += 1;
                agent.metadata.resource_version = Some(version.to_string());
            } else {
                assert_eq!(
                    request.method(),
                    http::Method::GET,
                    "the sleeping fixture cannot dispatch guest effects"
                );
            }
            response.send_response(
                Response::builder()
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&agent).unwrap()))
                    .unwrap(),
            );
        }
    });
    crate::grpc::tests::test_control_plane(Client::new(service, "tengri"))
}

fn input() -> Input {
    Input {
        id: Uuid::new_v4().to_string(),
        agent_id: "agent-current".into(),
        thread_id: "thread-fixture".into(),
        text: "fixture".into(),
        model: "fixture".into(),
        reasoning_effort: "low".into(),
        images: vec![],
    }
}

fn principal() -> Principal {
    let agent = crate::grpc::tests::provisional_terminal_test_agent(Utc::now());
    Principal::fixture(
        &agent.spec.owner_hash,
        &agent.uid().unwrap(),
        crate::ofz::proto::Action::CodexControl,
    )
}

#[tokio::test]
async fn status_reads_accept_delayed_authorized_responses() {
    let service = Arc::new(fixture());
    let router = axum::Router::new().route(
        "/restate/call/{service}/{key}/{handler}",
        axum::routing::post({
            let service = service.clone();
            move |axum::extract::Path((name, key, handler)): axum::extract::Path<(
                String,
                String,
                String,
            )>,
                  axum::Json(envelope): axum::Json<Envelope>| {
                let service = service.clone();
                async move {
                    let domain = if handler == "active" {
                        "active-query"
                    } else {
                        "query"
                    };
                    let query: Query = open(&service, domain, &envelope).await.unwrap();
                    let now = crate::ofz::now_ms().unwrap();
                    assert!(query.expires_at_ms > now && query.expires_at_ms <= now + 2000);
                    assert_eq!(query.owner_hash, principal().owner_hash);
                    assert_eq!(query.workspace_uid, principal().context.workspace_uid);
                    let value = if handler == "active" {
                        assert_eq!(name, "TengriWorkspaceRuns");
                        assert_eq!(key, query.workspace_uid);
                        serde_json::json!([])
                    } else {
                        assert_eq!(name, "TengriAgentRun");
                        assert_eq!(key, query.run_id);
                        serde_json::to_value(Snapshot {
                            run_id: key,
                            agent_id: "agent-current".into(),
                            thread_id: "thread-fixture".into(),
                            owner_hash: query.owner_hash,
                            workspace_uid: query.workspace_uid,
                            digest: "fixture".into(),
                            state: State::Succeeded {
                                turn_id: "turn-fixture".into(),
                            },
                        })
                        .unwrap()
                    };
                    tokio::time::sleep(Duration::from_millis(2200)).await;
                    ([("x-restate-id", "inv_delayed-read")], axum::Json(value))
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let output = tokio::time::timeout(
        Duration::from_secs(15),
        tokio::process::Command::new(std::env::current_exe().unwrap())
            .kill_on_drop(true)
            .args([
                "--exact",
                "runs::tests::delayed_status_read_child",
                "--ignored",
                "--nocapture",
            ])
            .env("TENGRI_RESTATE_INGRESS", format!("http://{address}"))
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    server.abort();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
#[ignore = "child process for the isolated status response deadline test"]
async fn delayed_status_read_child() {
    let service = fixture();
    assert!(active(&service, &principal()).await.unwrap().is_empty());
    let id = Uuid::new_v4().to_string();
    let snapshot = read(&service, &principal(), &id, None).await.unwrap();
    assert_eq!(snapshot.run_id, id);
    assert!(matches!(snapshot.state, State::Succeeded { .. }));
}

#[tokio::test]
async fn active_recovery_renews_expired_queries_and_retries_only_transient_failures() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let service = Arc::new(fixture());
    let active_calls = Arc::new(AtomicUsize::new(0));
    let status_calls = Arc::new(AtomicUsize::new(0));
    let router = axum::Router::new().route(
        "/restate/call/{service}/{key}/{handler}",
        axum::routing::post({
            let active_calls = active_calls.clone();
            let status_calls = status_calls.clone();
            move |axum::extract::Path((_, key, handler)): axum::extract::Path<(
                String,
                String,
                String,
            )>,
                  axum::Json(envelope): axum::Json<Envelope>| {
                let service = service.clone();
                let active_calls = active_calls.clone();
                let status_calls = status_calls.clone();
                async move {
                    let domain = if handler == "active" {
                        "active-query"
                    } else {
                        "query"
                    };
                    let query: Query = open(&service, domain, &envelope).await.unwrap();
                    let now = crate::ofz::now_ms().unwrap();
                    assert!(query.expires_at_ms > now && query.expires_at_ms <= now + 2000);
                    let (status, body) = if handler == "active" {
                        if active_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                            tokio::time::sleep(Duration::from_millis(2100)).await;
                            assert!(query.expires_at_ms < crate::ofz::now_ms().unwrap());
                            (
                                408,
                                serde_json::json!({"code":408,"message":"run query expired"}),
                            )
                        } else {
                            (
                                200,
                                serde_json::json!([
                                    Claim {
                                        workspace_uid: query.workspace_uid.clone(),
                                        owner_hash: query.owner_hash.clone(),
                                        thread_id: "thread-fixture".into(),
                                        run_id: "run-current".into()
                                    },
                                    Claim {
                                        workspace_uid: query.workspace_uid.clone(),
                                        owner_hash: "b".repeat(64),
                                        thread_id: "foreign-thread".into(),
                                        run_id: "foreign-run".into()
                                    }
                                ]),
                            )
                        }
                    } else if key == "run-current"
                        && status_calls.fetch_add(1, Ordering::SeqCst) == 0
                    {
                        (
                            503,
                            serde_json::json!({"code":503,"message":"temporarily unavailable"}),
                        )
                    } else if key == "run-current" {
                        (
                            200,
                            serde_json::to_value(Snapshot {
                                run_id: key,
                                agent_id: "agent-current".into(),
                                thread_id: "thread-fixture".into(),
                                owner_hash: query.owner_hash,
                                workspace_uid: query.workspace_uid,
                                digest: "fixture".into(),
                                state: State::Running {
                                    turn_id: "turn-current".into(),
                                },
                            })
                            .unwrap(),
                        )
                    } else {
                        let status: u16 = key.parse().unwrap();
                        (
                            status,
                            serde_json::json!({"code":status,"message":"denied"}),
                        )
                    };
                    (
                        http::StatusCode::from_u16(status).unwrap(),
                        [("x-restate-id", "inv_read-recovery")],
                        axum::Json(body),
                    )
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let output = tokio::time::timeout(
        Duration::from_secs(20),
        tokio::process::Command::new(std::env::current_exe().unwrap())
            .kill_on_drop(true)
            .args([
                "--exact",
                "runs::tests::recovering_status_read_child",
                "--ignored",
                "--nocapture",
            ])
            .env("TENGRI_RESTATE_INGRESS", format!("http://{address}"))
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    server.abort();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(active_calls.load(Ordering::SeqCst), 4);
    assert_eq!(status_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
#[ignore = "child process for isolated read recovery tests"]
async fn recovering_status_read_child() {
    let service = fixture();
    let mut snapshots = active(&service, &principal()).await.unwrap();
    assert_eq!(snapshots.len(), 1, "foreign runs must not poison recovery");
    let snapshot = snapshots.remove(0);
    assert!(
        thread_active(&service, &principal(), "foreign-thread")
            .await
            .unwrap(),
        "archiving still protects other principals' active conversations"
    );
    assert!(
        !thread_active(&service, &principal(), "missing-thread")
            .await
            .unwrap()
    );
    assert_eq!(
        snapshot.state,
        State::Running {
            turn_id: "turn-current".into()
        }
    );
    for (status, code) in [
        (401, tonic::Code::Unauthenticated),
        (403, tonic::Code::PermissionDenied),
        (404, tonic::Code::NotFound),
        (409, tonic::Code::AlreadyExists),
        (422, tonic::Code::FailedPrecondition),
    ] {
        assert_eq!(
            read(&service, &principal(), &status.to_string(), None)
                .await
                .unwrap_err()
                .code(),
            code
        );
    }
}

#[tokio::test(start_paused = true)]
async fn read_recovery_stops_at_its_total_budget_and_does_not_retry_invalid_responses() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let attempts = AtomicUsize::new(0);
    let started = tokio::time::Instant::now();
    let error = recover_status::<(), _, _>("status", || {
        attempts.fetch_add(1, Ordering::SeqCst);
        std::future::pending()
    })
    .await
    .unwrap_err();
    assert_eq!(error.code(), tonic::Code::Unavailable);
    assert_eq!(started.elapsed(), STATUS_RECOVERY_TIMEOUT);
    assert_eq!(attempts.load(Ordering::SeqCst), 3);

    let response = http::Response::builder()
        .status(200)
        .body(hyper::body::Bytes::from_static(b"invalid JSON"))
        .unwrap();
    let error = read_error(restate_sdk::ingress::ClientError::PayloadDecode {
        source: Box::new(std::io::Error::other("invalid JSON")),
        response: Box::new(response),
    });
    assert_eq!(error.code(), tonic::Code::Internal);
    let attempts = AtomicUsize::new(0);
    let denied = recover_status::<(), _, _>("status", || {
        attempts.fetch_add(1, Ordering::SeqCst);
        std::future::ready(Err(error.clone()))
    })
    .await
    .unwrap_err();
    assert_eq!(denied.code(), tonic::Code::Internal);
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn run_admission_is_bound_to_payload_and_domain() {
    let service = fixture();
    let mut envelope = seal(&service, "query", &input()).await.unwrap();
    assert!(
        open::<Input>(&service, "admission", &envelope)
            .await
            .is_err()
    );
    assert!(open::<Input>(&service, "query", &envelope).await.is_ok());
    envelope.payload.push(' ');
    assert!(open::<Input>(&service, "query", &envelope).await.is_err());
}

#[test]
fn history_requires_the_exact_accepted_turn_and_an_explicit_outcome() {
    let value = serde_json::json!({"thread":{"turns":[{"id":"other","status":"completed"},{"id":"accepted","status":"inProgress"}]}});
    assert!(matches!(
        observed_turn(&value, "missing"),
        State::NeedsReconciliation { .. }
    ));
    assert_eq!(
        observed_turn(&value, "accepted"),
        State::Running {
            turn_id: "accepted".into()
        }
    );
    assert_eq!(
        observed_turn(&value, "other"),
        State::Succeeded {
            turn_id: "other".into()
        }
    );
}

#[test]
fn interrupted_history_cannot_release_the_run_without_command_cleanup() {
    let value = serde_json::json!({"thread":{"turns":[{"id":"accepted","status":"interrupted"}]}});
    assert!(matches!(
        observed_turn(&value, "accepted"),
        State::Cancelling { turn_id: Some(id), .. } if id == "accepted"
    ));
}

#[test]
fn changed_input_changes_the_durable_identity_digest() {
    let first = input();
    let mut changed = first.clone();
    assert_eq!(
        input_digest(&first).unwrap(),
        input_digest(&changed).unwrap()
    );
    changed.text.push('!');
    assert_ne!(
        input_digest(&first).unwrap(),
        input_digest(&changed).unwrap()
    );
}

#[tokio::test]
async fn snapshot_sleep_keeps_stop_pending_until_the_preserved_turn_is_interrupted() {
    let service = fixture();
    let input = input();
    let control = Control {
        id: Uuid::new_v4().to_string(),
        run_id: input.id.clone(),
        agent_id: input.agent_id.clone(),
        principal: principal(),
        method: "turn/interrupt".into(),
        params: serde_json::json!({}),
    };
    let result = service
        .stop_durable_run(
            &control,
            &input,
            &State::Running {
                turn_id: "preserved-turn".into(),
            },
        )
        .await;
    assert!(!result.terminal());
    assert!(matches!(result,State::Cancelling{turn_id:Some(id),..} if id=="preserved-turn"));
    assert!(
        service
            .stop_durable_run(
                &control,
                &input,
                &State::WaitingForGuest {
                    reason: "not dispatched".into()
                }
            )
            .await
            .terminal()
    );
}

#[derive(Serialize, Deserialize)]
struct StopAuthorityProofInput {
    claim: Claim,
    prepared: Admission,
    old: Control,
    fresh: Control,
}

struct StopAuthorityProof {
    service: Arc<ControlPlane>,
}
#[workflow]
impl StopAuthorityProof {
    #[handler]
    async fn run(
        &self,
        ctx: WorkflowContext<'_>,
        input: Json<StopAuthorityProofInput>,
    ) -> HandlerResult<Json<Option<Control>>> {
        let workspace =
            ctx.object_client::<TengriWorkspaceRunsClient>(&input.0.claim.workspace_uid);
        workspace.claim(Json(input.0.claim.clone())).call().await?;
        workspace
            .store_stop(Json(input.0.old.clone()))
            .call()
            .await?;
        workspace.store_stop(Json(input.0.fresh)).call().await?;
        workspace.store_stop(Json(input.0.old)).call().await?;
        let state = TengriAgentRun {
            service: self.service.clone(),
        }
        .dispatch_prepared(&ctx, &input.0.prepared)
        .await?;
        if !matches!(state, State::Cancelled { .. }) {
            return Err(TerminalError::new_with_code(
                500,
                "recorded Stop was not checked before native dispatch",
            )
            .into());
        }
        workspace
            .claim(Json(input.0.claim))
            .call()
            .await
            .map_err(Into::into)
    }
    #[handler]
    async fn inspect(
        &self,
        ctx: SharedWorkflowContext<'_>,
        claim: Json<Claim>,
    ) -> HandlerResult<Json<Option<Control>>> {
        ctx.object_client::<TengriWorkspaceRunsClient>(&claim.0.workspace_uid)
            .latest_stop(Json(StopQuery {
                claim: claim.0,
                known_id: String::new(),
            }))
            .call()
            .await
            .map_err(Into::into)
    }
    #[handler]
    async fn release(
        &self,
        ctx: SharedWorkflowContext<'_>,
        claim: Json<Claim>,
    ) -> HandlerResult<()> {
        ctx.object_client::<TengriWorkspaceRunsClient>(&claim.0.workspace_uid)
            .release(claim)
            .call()
            .await
            .map_err(Into::into)
    }
}

#[tokio::test]
#[ignore = "child process for the disposable Restate recovery test"]
async fn fixture_worker() {
    let port = env::var("TENGRI_FIXTURE_PORT").expect("fixture child only");
    let mut service = fixture();
    service.auth = crate::auth::Authenticator::new(
        std::path::Path::new(&env::var("TENGRI_FIXTURE_KEY_FILE").unwrap()),
        "https://proompteng.ai".into(),
    )
    .unwrap();
    let service = Arc::new(service);
    let endpoint = run_endpoint(service.clone())
        .bind(StopAuthorityProof { service })
        .build();
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}"))
        .await
        .unwrap();
    HttpServer::new(endpoint).serve(listener).await;
}

struct Worker(Child);
impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn worker(port: u16, key_file: &std::path::Path) -> Worker {
    Worker(
        Command::new(env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "runs::tests::fixture_worker",
                "--nocapture",
            ])
            .env("TENGRI_FIXTURE_PORT", port.to_string())
            .env("TENGRI_FIXTURE_KEY_FILE", key_file)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    )
}

async fn register(
    http: &reqwest::Client,
    admin: &str,
    port: u16,
    deadline: tokio::time::Instant,
) -> String {
    loop {
        if let Ok(response) = http
            .post(format!("{admin}/deployments"))
            .json(&serde_json::json!({"uri":format!("http://host.docker.internal:{port}")}))
            .send()
            .await
            && response.status().is_success()
        {
            let value: serde_json::Value = response.json().await.unwrap();
            return value["id"].as_str().expect("deployment identity").into();
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "fixture deployment did not register"
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}
struct Engine(String);
impl Drop for Engine {
    fn drop(&mut self) {
        let _ = Command::new("docker")
            .args(["rm", "--force", &self.0])
            .output();
    }
}
fn engine_port(engine: &Engine, port: &str) -> u16 {
    let output = Command::new("docker")
        .args(["inspect", &engine.0])
        .output()
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    json[0]["NetworkSettings"]["Ports"][port][0]["HostPort"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap()
}

async fn admission(service: &ControlPlane, input: Input) -> Envelope {
    let principal = principal();
    let claim = Claim {
        workspace_uid: principal.context.workspace_uid.clone(),
        owner_hash: principal.owner_hash.clone(),
        thread_id: input.thread_id.clone(),
        run_id: input.id.clone(),
    };
    seal(
        service,
        "admission",
        &Admission {
            digest: input_digest(&input).unwrap(),
            input,
            principal,
            claim,
        },
    )
    .await
    .unwrap()
}
async fn status(
    client: &TengriAgentRunIngressClient<reqwest::Client>,
    service: &ControlPlane,
    input: &Input,
    owner: &str,
) -> Result<Snapshot, restate_sdk::ingress::ClientError> {
    let envelope = seal(
        service,
        "query",
        &Query {
            run_id: input.id.clone(),
            owner_hash: owner.into(),
            workspace_uid: principal().context.workspace_uid,
            digest: Some(input_digest(input).unwrap()),
            expires_at_ms: crate::ofz::now_ms().unwrap() + 2000,
        },
    )
    .await
    .unwrap();
    client
        .status(Json(envelope))
        .call()
        .await?
        .into_body()
        .map(Json::into_inner)
}

#[tokio::test]
#[ignore = "requires Docker; starts an isolated Restate 1.7.9 and kills an actual worker process"]
async fn restate_preserves_acceptance_exclusion_and_stop_across_worker_sigkill() {
    let key_file = env::temp_dir().join(format!("tengri-restate-key-{}", Uuid::new_v4()));
    std::fs::write(&key_file, "68".repeat(32)).unwrap();
    let image = "docker.restate.dev/restatedev/restate:1.7.9@sha256:329e32e12059610b681e165161bcd0722d193325b6c893bc46bfec72cd54b595";
    let mut command = Command::new("docker");
    command.args([
        "run",
        "--detach",
        "--publish",
        "127.0.0.1::8080",
        "--publish",
        "127.0.0.1::9070",
        "--tmpfs",
        "/restate-data",
        "--env",
        "RESTATE_DEFAULT_RETRY_POLICY__INITIAL_INTERVAL=1ms",
        "--env",
        "RESTATE_DEFAULT_RETRY_POLICY__MAX_INTERVAL=1ms",
        "--env",
        "RESTATE_DEFAULT_RETRY_POLICY__MAX_ATTEMPTS=2",
    ]);
    if cfg!(target_os = "linux") {
        command.args(["--add-host", "host.docker.internal:host-gateway"]);
    }
    let output = command.arg(image).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let engine = Engine(String::from_utf8(output.stdout).unwrap().trim().into());
    let ingress = ReqwestClient::connect(
        format!("http://127.0.0.1:{}", engine_port(&engine, "8080/tcp"))
            .parse::<http::Uri>()
            .unwrap(),
    )
    .unwrap();
    let admin = format!("http://127.0.0.1:{}", engine_port(&engine, "9070/tcp"));
    let socket = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = socket.local_addr().unwrap().port();
    drop(socket);
    let mut process = worker(port, &key_file);
    let http = reqwest::Client::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    let original_deployment = register(&http, &admin, port, deadline).await;
    let registered: serde_json::Value = http
        .get(format!("{admin}/services/TengriAgentRun"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(registered["retry_policy"]["max_attempts"], u64::MAX);
    let default_policy: serde_json::Value = http
        .get(format!("{admin}/services/StopAuthorityProof"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(default_policy["retry_policy"]["max_attempts"], 2);
    let mut service = fixture();
    service.auth =
        crate::auth::Authenticator::new(&key_file, "https://proompteng.ai".into()).unwrap();
    let workspace = TengriWorkspaceRunsIngressClient::from_client(
        ingress.clone(),
        principal().context.workspace_uid,
    );
    let proof_run = Uuid::new_v4().to_string();
    let proof_claim = Claim {
        workspace_uid: Uuid::new_v4().to_string(),
        owner_hash: principal().owner_hash,
        thread_id: "proof-thread".into(),
        run_id: proof_run.clone(),
    };
    let mut old_stop = Control {
        id: Uuid::new_v4().to_string(),
        run_id: proof_run,
        agent_id: "proof-agent".into(),
        principal: principal(),
        method: "turn/interrupt".into(),
        params: serde_json::json!({}),
    };
    old_stop.principal.context.workspace_uid = proof_claim.workspace_uid.clone();
    old_stop.principal.context.session_id = Uuid::new_v4().to_string();
    old_stop.principal.context.deadline_unix_ms = crate::ofz::now_ms()
        .unwrap()
        .saturating_sub(8 * 60 * 60 * 1000);
    let mut fresh_stop = old_stop.clone();
    fresh_stop.principal.context.session_id = Uuid::new_v4().to_string();
    fresh_stop.principal.context.deadline_unix_ms = crate::ofz::now_ms().unwrap() + 25000;
    fresh_stop.id = Uuid::new_v4().to_string();
    let proof_client =
        StopAuthorityProofIngressClient::from_client(ingress.clone(), Uuid::new_v4().to_string());
    let prepared_input = Input {
        id: proof_claim.run_id.clone(),
        agent_id: fresh_stop.agent_id.clone(),
        thread_id: proof_claim.thread_id.clone(),
        ..input()
    };
    proof_client
        .run(Json(StopAuthorityProofInput {
            claim: proof_claim.clone(),
            prepared: Admission {
                digest: input_digest(&prepared_input).unwrap(),
                input: prepared_input,
                principal: fresh_stop.principal.clone(),
                claim: proof_claim.clone(),
            },
            old: old_stop.clone(),
            fresh: fresh_stop.clone(),
        }))
        .send()
        .await
        .unwrap();
    let latest = proof_client
        .handle()
        .await
        .unwrap()
        .attach()
        .await
        .unwrap()
        .into_body()
        .into_inner()
        .unwrap();
    assert_eq!(
        latest.id, fresh_stop.id,
        "an older delayed Stop cannot replace refreshed authority"
    );
    let input = input();
    let client = TengriAgentRunIngressClient::from_client(ingress.clone(), input.id.clone());
    let envelope = admission(&service, input.clone()).await;
    let typed: Admission = open(&service, "admission", &envelope).await.unwrap();
    assert!(
        client.run(Json(typed)).send().await.is_err(),
        "the durable run can only be created through authenticated admission"
    );
    workspace
        .admit(Json(envelope))
        .call()
        .await
        .unwrap()
        .into_body()
        .unwrap();
    let owner = principal().owner_hash;
    loop {
        if let Ok(snapshot) = status(&client, &service, &input, &owner).await
            && matches!(snapshot.state, State::WaitingForGuest { .. })
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "accepted run did not reach guest wait"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let parallel = Input {
        id: Uuid::new_v4().to_string(),
        thread_id: "parallel-thread".into(),
        ..input.clone()
    };
    let parallel_client =
        TengriAgentRunIngressClient::from_client(ingress.clone(), parallel.id.clone());
    workspace
        .admit(Json(admission(&service, parallel.clone()).await))
        .call()
        .await
        .unwrap()
        .into_body()
        .unwrap();
    loop {
        if let Ok(snapshot) = status(&parallel_client, &service, &parallel, &owner).await
            && matches!(snapshot.state, State::WaitingForGuest { .. })
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "independent conversation was blocked"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let stale_steer = Control {
        id: Uuid::new_v4().to_string(),
        run_id: input.id.clone(),
        agent_id: input.agent_id.clone(),
        principal: principal(),
        method: "turn/steer".into(),
        params: serde_json::json!({"threadId":input.thread_id,"expectedTurnId":"not-started"}),
    };
    let stale_client =
        TengriRunControlIngressClient::from_client(ingress.clone(), stale_steer.id.clone());
    let error = match control_receipt(
        &workspace,
        &stale_client,
        seal(&service, "control", &stale_steer).await.unwrap(),
    )
    .await
    {
        Ok(_) => panic!("an unstarted run cannot receive native steering"),
        Err(error) => error,
    };
    let rejected_status = client_error(error);
    assert_eq!(rejected_status.code(), tonic::Code::FailedPrecondition);
    assert_eq!(
        rejected_status.message(),
        "Codex control was not dispatched"
    );
    let query = Query {
        run_id: String::new(),
        owner_hash: owner.clone(),
        workspace_uid: principal().context.workspace_uid,
        digest: None,
        expires_at_ms: crate::ofz::now_ms().unwrap() + 2000,
    };
    let active = workspace
        .active(Json(seal(&service, "active-query", &query).await.unwrap()))
        .call()
        .await
        .unwrap()
        .into_body()
        .unwrap()
        .into_inner();
    assert_eq!(
        active
            .into_iter()
            .map(|claim| claim.run_id)
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([input.id.clone(), parallel.id.clone()])
    );
    let expired = Query {
        run_id: input.id.clone(),
        owner_hash: owner.clone(),
        workspace_uid: query.workspace_uid.clone(),
        digest: None,
        expires_at_ms: crate::ofz::now_ms().unwrap().saturating_sub(1),
    };
    assert_eq!(
        client
            .status(Json(seal(&service, "query", &expired).await.unwrap()))
            .call()
            .await
            .unwrap()
            .into_body()
            .err()
            .expect("expired status query must fail")
            .response()
            .unwrap()
            .status(),
        408
    );
    assert_eq!(
        workspace
            .active(Json(
                seal(&service, "active-query", &expired).await.unwrap()
            ))
            .call()
            .await
            .unwrap()
            .into_body()
            .err()
            .expect("expired active query must fail")
            .response()
            .unwrap()
            .status(),
        408
    );
    let claim = Claim {
        workspace_uid: query.workspace_uid,
        owner_hash: principal().owner_hash,
        thread_id: input.thread_id.clone(),
        run_id: input.id.clone(),
    };
    assert!(
        workspace.claim(Json(claim)).call().await.is_err(),
        "claim handler must be private to service calls"
    );
    let socket = TcpListener::bind("127.0.0.1:0").unwrap();
    let next_port = socket.local_addr().unwrap().port();
    drop(socket);
    let mut next_version = worker(next_port, &key_file);
    let next_deployment = register(&http, &admin, next_port, deadline).await;
    assert_ne!(
        original_deployment, next_deployment,
        "version registration must retain the original pinned endpoint"
    );
    // Repeated input is the same workflow, and a changed payload is rejected by readback.
    workspace
        .admit(Json(admission(&service, input.clone()).await))
        .call()
        .await
        .unwrap()
        .into_body()
        .unwrap();
    let mut changed = input.clone();
    changed.text.push('!');
    assert_eq!(
        status(&client, &service, &changed, &owner)
            .await
            .unwrap_err()
            .response()
            .unwrap()
            .status(),
        409
    );
    assert_eq!(
        status(&client, &service, &input, &"b".repeat(64))
            .await
            .unwrap_err()
            .response()
            .unwrap()
            .status(),
        403
    );
    let mut other = input.clone();
    other.id = Uuid::new_v4().to_string();
    let other_client = TengriAgentRunIngressClient::from_client(ingress.clone(), other.id.clone());
    workspace
        .admit(Json(admission(&service, other.clone()).await))
        .call()
        .await
        .unwrap()
        .into_body()
        .unwrap();
    loop {
        if let Ok(snapshot) = status(&other_client, &service, &other, &owner).await
            && matches!(snapshot.state, State::Rejected { .. })
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "same-conversation exclusion did not settle"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let mut queued_input = input.clone();
    queued_input.id = Uuid::new_v4().to_string();
    let queued_envelope = admission(&service, queued_input.clone()).await;
    let queued_stop = Control {
        id: Uuid::new_v4().to_string(),
        run_id: input.id.clone(),
        agent_id: input.agent_id.clone(),
        principal: principal(),
        method: "turn/interrupt".into(),
        params: serde_json::json!({}),
    };
    let queued_control_envelope = seal(&service, "control", &queued_stop).await.unwrap();
    process.0.kill().unwrap();
    process.0.wait().unwrap();
    next_version.0.kill().unwrap();
    next_version.0.wait().unwrap();
    let queued_admission = workspace
        .admit(Json(queued_envelope.clone()))
        .send()
        .await
        .unwrap()
        .invocation_handle();
    let queued_control = workspace
        .admit_control(Json(queued_control_envelope))
        .send()
        .await
        .unwrap()
        .invocation_handle();
    let queued_admission = tokio::spawn(async move { queued_admission.attach().await });
    let queued_control = tokio::spawn(async move { queued_control.attach().await });
    tokio::time::sleep(Duration::from_millis(400)).await;
    std::fs::write(&key_file, "69".repeat(32)).unwrap();
    assert!(
        service
            .auth
            .verify_run(
                "admission",
                queued_envelope.payload.as_bytes(),
                &queued_envelope.signature
            )
            .await
            .is_err(),
        "the mounted key must actually rotate before admission readback"
    );
    // These are independent OS processes. Listener cancellation alone would leave HTTP/2 tasks alive.
    process = worker(port, &key_file);
    next_version = worker(next_port, &key_file);
    let latest = proof_client
        .inspect(Json(proof_claim.clone()))
        .call()
        .await
        .unwrap()
        .into_body()
        .unwrap()
        .into_inner()
        .unwrap();
    assert_eq!(
        latest.id, fresh_stop.id,
        "the refreshed Stop authority survives actual worker replacement"
    );
    assert_eq!(
        latest.principal.context.session_id,
        fresh_stop.principal.context.session_id
    );
    let mut changed_claim = proof_claim.clone();
    changed_claim.run_id = Uuid::new_v4().to_string();
    assert_eq!(
        proof_client
            .inspect(Json(changed_claim))
            .call()
            .await
            .and_then(|response| response.into_body())
            .err()
            .expect("a changed claim must be rejected")
            .response()
            .unwrap()
            .status(),
        403,
        "rotation cannot allow a changed claim to access the stored Stop"
    );
    proof_client
        .release(Json(proof_claim.clone()))
        .call()
        .await
        .unwrap()
        .into_body()
        .unwrap();
    assert_eq!(
        proof_client
            .inspect(Json(proof_claim))
            .call()
            .await
            .and_then(|response| response.into_body())
            .err()
            .expect("the completed claim must be released after key rotation")
            .response()
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        queued_admission
            .await
            .unwrap()
            .err()
            .unwrap()
            .response()
            .unwrap()
            .status(),
        503
    );
    assert_eq!(
        queued_control
            .await
            .unwrap()
            .err()
            .unwrap()
            .response()
            .unwrap()
            .status(),
        503
    );
    let stop = queued_stop;
    let stop_client = TengriRunControlIngressClient::from_client(ingress.clone(), stop.id.clone());
    assert!(
        stop_client.run(Json(stop.clone())).send().await.is_err(),
        "the durable control can only be created through authenticated admission"
    );
    let envelope = seal(&service, "control", &stop).await.unwrap();
    let receipt = control_receipt(&workspace, &stop_client, envelope)
        .await
        .unwrap();
    assert_eq!(receipt.digest, control_digest(&stop).unwrap());
    assert!(receipt.result.delivered);
    let repeated = control_receipt(
        &workspace,
        &stop_client,
        seal(&service, "control", &stop).await.unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(repeated.digest, receipt.digest);
    let mut changed_stop = stop.clone();
    changed_stop.method = "turn/steer".into();
    let duplicate = control_receipt(
        &workspace,
        &stop_client,
        seal(&service, "control", &changed_stop).await.unwrap(),
    )
    .await
    .unwrap();
    assert_ne!(
        duplicate.digest,
        control_digest(&changed_stop).unwrap(),
        "changed control input cannot reuse a committed result"
    );
    loop {
        if let Ok(snapshot) = status(&client, &service, &input, &owner).await
            && matches!(snapshot.state, State::Cancelled { .. })
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "durable Stop did not settle after worker replacement"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        matches!(
            status(&parallel_client, &service, &parallel, &owner)
                .await
                .unwrap()
                .state,
            State::WaitingForGuest { .. }
        ),
        "Stop for one conversation cancelled its sibling"
    );
    workspace
        .admit(Json(admission(&service, queued_input.clone()).await))
        .call()
        .await
        .unwrap()
        .into_body()
        .unwrap();
    let queued_client =
        TengriAgentRunIngressClient::from_client(ingress.clone(), queued_input.id.clone());
    loop {
        if let Ok(snapshot) = status(&queued_client, &service, &queued_input, &owner).await
            && matches!(snapshot.state, State::WaitingForGuest { .. })
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "a freshly signed retry must recover the same queued run UUID"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    drop(process);
    drop(next_version);
    std::fs::remove_file(key_file).unwrap();
}

#[tokio::test]
async fn completing_one_conversation_keeps_the_other_run_pinned() {
    let service = fixture();
    let first = input();
    let second = Input {
        thread_id: "second-thread".into(),
        ..input()
    };
    service.pin_run(&principal(), &first, true).await.unwrap();
    service.pin_run(&principal(), &second, true).await.unwrap();
    service.pin_run(&principal(), &first, false).await.unwrap();
    service.pin_run(&principal(), &first, false).await.unwrap();
    let agents: kube::Api<crate::crd::MicroVM> =
        kube::Api::namespaced(service.client.clone(), "tengri");
    let agent = agents.get(&first.agent_id).await.unwrap();
    let pins: BTreeSet<String> =
        serde_json::from_str(&agent.annotations()[crate::activity::ACTIVE_RUN_ANNOTATION]).unwrap();
    assert_eq!(pins, BTreeSet::from([second.id.clone()]));
    service.pin_run(&principal(), &second, false).await.unwrap();
    assert!(
        !agents
            .get(&first.agent_id)
            .await
            .unwrap()
            .annotations()
            .contains_key(crate::activity::ACTIVE_RUN_ANNOTATION)
    );
}

#[tokio::test]
async fn an_accepted_run_is_pinned_before_guest_availability_is_required() {
    let service = fixture();
    let input = input();
    assert!(matches!(
        service.prepare_durable_run(&principal(), &input).await,
        State::WaitingForGuest { .. }
    ));
    let agents: kube::Api<crate::crd::MicroVM> =
        kube::Api::namespaced(service.client.clone(), "tengri");
    let agent = agents.get(&input.agent_id).await.unwrap();
    assert_eq!(
        agent
            .annotations()
            .get(crate::activity::ACTIVE_RUN_ANNOTATION),
        Some(&serde_json::to_string(&vec![input.id.clone()]).unwrap())
    );
    assert_eq!(
        agent.spec.desired_state,
        crate::crd::MicroVMDesiredState::Sleeping
    );
    service.pin_run(&principal(), &input, false).await.unwrap();
    assert!(
        !agents
            .get(&input.agent_id)
            .await
            .unwrap()
            .annotations()
            .contains_key(crate::activity::ACTIVE_RUN_ANNOTATION)
    );
}

#[tokio::test]
async fn a_dispatch_retry_cannot_report_no_effects_from_unavailable_authority() {
    let service = fixture();
    let input = input();
    assert!(matches!(
        service.dispatch_durable_run(&principal(), &input).await,
        State::NeedsReconciliation { .. }
    ));
}

#[tokio::test]
async fn snapshot_resume_rebinds_the_run_pin_to_current_authority() {
    let service = fixture();
    let input = input();
    let mut admitted = principal();
    admitted.context.runtime_epoch = "55555555-5555-4555-8555-555555555555".into();

    service.pin_run(&admitted, &input, true).await.unwrap();

    let agents: kube::Api<crate::crd::MicroVM> =
        kube::Api::namespaced(service.client.clone(), "tengri");
    let agent = agents.get(&input.agent_id).await.unwrap();
    assert_eq!(
        agent
            .annotations()
            .get(crate::activity::ACTIVE_RUN_ANNOTATION),
        Some(&serde_json::to_string(&vec![input.id.clone()]).unwrap())
    );
    assert_ne!(agent.spec.runtime_epoch, admitted.context.runtime_epoch);
}

#[tokio::test]
async fn snapshot_resume_rechecks_authority_without_losing_the_accepted_turn() {
    for replaced_workspace in [false, true] {
        let service = fixture();
        let mut admitted = principal();
        admitted.context.runtime_epoch = "55555555-5555-4555-8555-555555555555".into();
        if replaced_workspace {
            admitted.context.workspace_uid = "66666666-6666-4666-8666-666666666666".into();
        }
        let observed = service
            .observe_durable_run(
                &admitted,
                &input(),
                &State::Running {
                    turn_id: "preserved-turn".into(),
                },
            )
            .await;
        if replaced_workspace {
            assert!(matches!(observed, State::NeedsReconciliation { .. }));
        } else {
            assert_eq!(
                observed,
                State::Recovering {
                    turn_id: "preserved-turn".into(),
                    reason: "waiting for the authorized guest".into(),
                }
            );
        }
        assert_eq!(
            admitted.context.runtime_epoch,
            "55555555-5555-4555-8555-555555555555"
        );
    }
}

#[tokio::test]
async fn refreshed_run_context_still_requires_current_ofz_authority() {
    let mut admitted = principal();
    admitted.context.grant_id = Uuid::new_v4().to_string();
    let original = admitted.clone();
    admitted.refresh_run_context().unwrap();
    assert_eq!(admitted.context.actor, original.context.actor);
    assert_eq!(admitted.context.session_id, original.context.session_id);
    assert_eq!(admitted.context.grant_id, original.context.grant_id);
    assert_eq!(
        admitted.context.workspace_uid,
        original.context.workspace_uid
    );
    assert_eq!(admitted.recovery_generation, original.recovery_generation);

    let authorization = crate::authz::tests::OfzFixture::new().await;
    authorization
        .mode
        .store(1, std::sync::atomic::Ordering::SeqCst);
    let access = authorization
        .authorization
        .access(
            &admitted,
            &admitted.context.workspace_uid,
            "55555555-5555-4555-8555-555555555555",
            "accepted-run",
        )
        .unwrap();
    assert_eq!(
        access.require().await.unwrap_err().code(),
        tonic::Code::PermissionDenied
    );
}
