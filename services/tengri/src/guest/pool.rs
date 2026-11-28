use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::{Duration, Instant},
};

use kube::{Api, Client, ResourceExt};
use tokio::sync::{Mutex, OnceCell};

use super::{
    GUEST_API_PORT, GuestClient, GuestError, GuestTransport, authorization::GuestAuthorization,
};
use crate::{
    crd::{MicroVM, MicroVMPhase},
    identity::WorkloadIdentity,
    slot::Claim,
};

const MAX_CONNECTIONS: usize = 6;
const MAX_AGE: Duration = Duration::from_secs(60);

#[derive(Clone, PartialEq, Eq)]
pub(super) struct GuestTarget {
    pub claim: Claim,
    pub pod_uid: String,
    pub address: SocketAddr,
    pub slot_name: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guest::rpc::{
        proto,
        test_server::{TestServer, TestService},
    };
    use kube::client::Body as KubeBody;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn agent() -> MicroVM {
        serde_json::from_value(json!({
            "apiVersion":"runtime.proompteng.ai/v1alpha1", "kind":"MicroVM",
            "metadata":{"name":"agent-a", "uid":"11111111-1111-4111-8111-111111111111", "generation":2},
            "spec":{
                "reservationId":"77f8ce6b-18c5-4f7b-950c-b5639b70619e",
                "runtimeEpoch":"39d272fe-2781-4bc2-886c-a2993865f646", "policyVersion":1,
                "displayName":"Agent", "ownerHash":"owner", "desiredState":"Running",
                "image":"test-image", "architecture":"amd64", "resources":{"cpuMillis":4000,"memoryMib":8192,"workspaceGib":32},
                "createdAt":"2026-10-11T00:00:00Z", "idleDeadline":"2026-10-12T00:00:00Z",
                "slot":{"name":"slot-a","podUid":"33333333-3333-4333-8333-333333333333","pvcName":"home-a","pvcUid":"home-uid","epoch":7}
            },
            "status":{"phase":"Ready", "guestReady":true, "podUid":"33333333-3333-4333-8333-333333333333", "podIp":"127.0.0.1", "observedGeneration":2}
        })).unwrap()
    }

    #[tokio::test]
    async fn cached_transport_uses_each_actor_and_rechecks_revocation_and_outage() {
        use crate::{auth::Principal, authz::WorkspaceAuthorization, ofz};
        use std::sync::atomic::AtomicU8;
        use tengri::guest_authorization::{
            CONTEXT_HEADER, GuestActor, GuestProof, GuestSigner, GuestVerifier, SIGNATURE_HEADER,
        };

        let signer = GuestSigner::from_seed(&std::array::from_fn::<_, 32, _>(|i| i as u8)).unwrap();
        let verifier = GuestVerifier::from_bytes(signer.public_key()).unwrap();
        let subjects = Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = subjects.clone();
        let verifications = Arc::new(AtomicUsize::new(0));
        let probes = verifications.clone();
        let server = TestServer::start(TestService {
            get_info: Some(Arc::new(move |_| {
                probes.fetch_add(1, Ordering::SeqCst);
                Ok(proto::GuestInfo {
                    microvm_id: "33333333-3333-4333-8333-333333333333".into(),
                    protocol_version: tengri::GUEST_API_PROTOCOL_VERSION,
                    ..Default::default()
                })
            })),
            list_files: Some(Arc::new(move |request| {
                let proof = GuestProof {
                    context: request
                        .metadata()
                        .get(CONTEXT_HEADER)
                        .unwrap()
                        .to_str()
                        .unwrap()
                        .into(),
                    signature: request
                        .metadata()
                        .get(SIGNATURE_HEADER)
                        .unwrap()
                        .to_str()
                        .unwrap()
                        .into(),
                };
                let context = verifier.verify(&proof, ofz::now_ms().unwrap()).unwrap();
                let GuestActor::Human { subject, .. } = context.actor else {
                    panic!("human expected")
                };
                assert_eq!(context.target, "/workspace");
                seen.lock().unwrap().push(subject);
                Ok(proto::FileList {
                    path: request.into_inner().path,
                    entries: vec![],
                })
            })),
            ..Default::default()
        })
        .await;
        let service = tower::service_fn(|_: http::Request<KubeBody>| async {
            Ok::<_, std::convert::Infallible>(http::Response::builder().body(KubeBody::from(
                json!({"apiVersion":"v1","kind":"Secret","immutable":true,"data":{"token":"Zml4dHVyZS10b2tlbg=="}}).to_string().into_bytes()
            )).unwrap())
        });
        let pool = GuestPool::new(
            Client::new(service, "tengri"),
            "tengri",
            WorkloadIdentity::Fixture(
                server
                    .guest
                    .base_url()
                    .strip_prefix("http://")
                    .unwrap()
                    .parse::<SocketAddr>()
                    .unwrap()
                    .port(),
            ),
        );
        let agent = agent();
        let mode = Arc::new(AtomicU8::new(0));
        let authorization = WorkspaceAuthorization::ControlledFixture(mode.clone());
        let authority = super::super::authorization::GuestAuthority::fixture_with_authorization(
            authorization.clone(),
        );
        let mut clients = Vec::new();
        for subject in ["a".repeat(64), "b".repeat(64)] {
            let mut principal = Principal::fixture(
                &subject,
                agent.metadata.uid.as_deref().unwrap(),
                ofz::proto::Action::FilesObserve,
            );
            principal.context.runtime_epoch = agent.spec.runtime_epoch.clone();
            let access = authorization
                .agent_access(&principal, &agent, "/workspace")
                .unwrap();
            let guest = pool
                .for_microvm(&agent, authority.user(access))
                .await
                .unwrap();
            guest.list_files("/workspace").await.unwrap();
            clients.push(guest);
        }
        assert_eq!(*subjects.lock().unwrap(), ["a".repeat(64), "b".repeat(64)]);
        assert_eq!(verifications.load(Ordering::SeqCst), 1);
        for guest in clients {
            mode.store(1, Ordering::SeqCst);
            assert!(matches!(
                guest.list_files("/workspace").await,
                Err(GuestError::Api {
                    status: reqwest::StatusCode::FORBIDDEN,
                    ..
                })
            ));
            mode.store(2, Ordering::SeqCst);
            assert!(matches!(
                guest.list_files("/workspace").await,
                Err(GuestError::Api {
                    status: reqwest::StatusCode::SERVICE_UNAVAILABLE,
                    ..
                })
            ));
        }
        assert_eq!(subjects.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn cached_controls_cannot_race_an_idle_sleep_reservation() {
        use crate::{
            activity::ACTIVE_RUN_ANNOTATION, auth::Principal, authz::WorkspaceAuthorization, ofz,
        };
        use std::sync::atomic::AtomicU8;

        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let server = TestServer::start(TestService {
            get_info: Some(Arc::new(|_| {
                Ok(proto::GuestInfo {
                    microvm_id: "33333333-3333-4333-8333-333333333333".into(),
                    protocol_version: tengri::GUEST_API_PROTOCOL_VERSION,
                    ..Default::default()
                })
            })),
            codex_call: Some(Arc::new(move |_| {
                seen.fetch_add(1, Ordering::SeqCst);
                Ok(proto::CodexResult {
                    result_json: b"{}".to_vec(),
                    event_sequence: 1,
                })
            })),
            ..Default::default()
        })
        .await;
        let mut agent = agent();
        agent.metadata.resource_version = Some("11".into());
        let current = Arc::new(std::sync::Mutex::new(agent.clone()));
        let state = current.clone();
        // 1: a reservation wins the admission CAS; 2: Kubernetes is unavailable.
        let mode = Arc::new(AtomicU8::new(0));
        let admission_mode = mode.clone();
        let patches = Arc::new(AtomicUsize::new(0));
        let writes = patches.clone();
        let service = tower::service_fn(move |request: http::Request<KubeBody>| {
            let state = state.clone();
            let mode = admission_mode.clone();
            let writes = writes.clone();
            async move {
                let mut status = http::StatusCode::OK;
                let body = if request.uri().path().ends_with("/secrets/slot-a-bootstrap") {
                    json!({"apiVersion":"v1","kind":"Secret","immutable":true,"data":{"token":"Zml4dHVyZS10b2tlbg=="}})
                } else {
                    assert!(request.uri().path().ends_with("/microvms/agent-a"));
                    if mode.load(Ordering::SeqCst) == 2 {
                        status = http::StatusCode::SERVICE_UNAVAILABLE;
                        json!({"apiVersion":"v1","kind":"Status","status":"Failure","reason":"ServiceUnavailable","message":"API unavailable","code":503})
                    } else if request.method() == http::Method::PATCH {
                        let bytes = request.into_body().collect_bytes().await.unwrap();
                        let patch: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                        let mut agent = state.lock().unwrap();
                        assert_eq!(patch["metadata"]["uid"], agent.uid().unwrap());
                        assert!(
                            patch["metadata"]["annotations"]
                                [crate::activity::LAST_ACTIVITY_ANNOTATION]
                                .is_string()
                        );
                        if patch["metadata"]["resourceVersion"] != agent.resource_version().unwrap()
                        {
                            status = http::StatusCode::CONFLICT;
                            json!({"apiVersion":"v1","kind":"Status","status":"Failure","reason":"Conflict","message":"activity changed concurrently","code":409})
                        } else if mode.swap(0, Ordering::SeqCst) == 1 {
                            let sleep_claim = format!("idle-sleep/{}", agent.spec.runtime_epoch);
                            agent
                                .metadata
                                .annotations
                                .get_or_insert_default()
                                .insert(ACTIVE_RUN_ANNOTATION.into(), sleep_claim);
                            status = http::StatusCode::CONFLICT;
                            json!({"apiVersion":"v1","kind":"Status","status":"Failure","reason":"Conflict","message":"sleep reservation won","code":409})
                        } else {
                            writes.fetch_add(1, Ordering::SeqCst);
                            agent.metadata.annotations.get_or_insert_default().insert(
                                crate::activity::LAST_ACTIVITY_ANNOTATION.into(),
                                patch["metadata"]["annotations"]
                                    [crate::activity::LAST_ACTIVITY_ANNOTATION]
                                    .as_str()
                                    .unwrap()
                                    .into(),
                            );
                            let version =
                                agent.resource_version().unwrap().parse::<u64>().unwrap() + 1;
                            agent.metadata.resource_version = Some(version.to_string());
                            json!(*agent)
                        }
                    } else {
                        assert_eq!(request.method(), http::Method::GET);
                        let snapshot = json!(*state.lock().unwrap());
                        // Model overlapping reads during a browser's module fan-out.
                        tokio::task::yield_now().await;
                        snapshot
                    }
                };
                Ok::<_, std::convert::Infallible>(
                    http::Response::builder()
                        .status(status)
                        .header("content-type", "application/json")
                        .body(KubeBody::from(body.to_string().into_bytes()))
                        .unwrap(),
                )
            }
        });
        let port = server
            .guest
            .base_url()
            .strip_prefix("http://")
            .unwrap()
            .parse::<SocketAddr>()
            .unwrap()
            .port();
        let pool = GuestPool::new(
            Client::new(service, "tengri"),
            "tengri",
            WorkloadIdentity::Fixture(port),
        );
        let authorization = WorkspaceAuthorization::Fixture;
        let mut principal = Principal::fixture(
            &"a".repeat(64),
            &agent.uid().unwrap(),
            ofz::proto::Action::CodexControl,
        );
        principal.context.runtime_epoch = agent.spec.runtime_epoch.clone();
        let access = authorization.agent_access(&principal, &agent, "").unwrap();
        let guest = pool
            .for_microvm(
                &agent,
                super::super::authorization::GuestAuthority::fixture().user(access),
            )
            .await
            .unwrap();
        guest
            .codex_call("thread/resume", json!({"threadId":"thread-a"}))
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        mode.store(1, Ordering::SeqCst);
        assert!(
            guest
                .codex_call("thread/resume", json!({"threadId":"thread-a"}))
                .await
                .is_err(),
            "a sleep reservation winning the CAS must prevent dispatch through a cached guest"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(patches.load(Ordering::SeqCst), 1);
        assert!(
            guest
                .codex_call("thread/resume", json!({"threadId":"thread-a"}))
                .await
                .is_err(),
            "persisted reservations must block subsequent controls"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        current
            .lock()
            .unwrap()
            .metadata
            .annotations
            .as_mut()
            .unwrap()
            .remove(ACTIVE_RUN_ANNOTATION);
        mode.store(2, Ordering::SeqCst);
        assert!(
            guest
                .codex_call("thread/resume", json!({"threadId":"thread-a"}))
                .await
                .is_err(),
            "an unavailable activity admission must not dispatch guest effects"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        mode.store(0, Ordering::SeqCst);
        guest
            .codex_call("thread/resume", json!({"threadId":"thread-a"}))
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(patches.load(Ordering::SeqCst), 2);

        // Durable run pins remain valid controls; they are not sleep claims.
        current
            .lock()
            .unwrap()
            .metadata
            .annotations
            .as_mut()
            .unwrap()
            .insert(
                ACTIVE_RUN_ANNOTATION.into(),
                "22222222-2222-4222-8222-222222222222".into(),
            );
        guest
            .codex_call("thread/resume", json!({"threadId":"thread-a"}))
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        *current.lock().unwrap() = agent.clone();
        let controls = (0..64).map(|_| async {
            // Each HTTP module request obtains a fresh authorized client from the pool.
            let guest = pool
                .for_microvm(
                    &agent,
                    super::super::authorization::GuestAuthority::fixture()
                        .user(authorization.agent_access(&principal, &agent, "").unwrap()),
                )
                .await
                .unwrap();
            guest
                .codex_call("thread/resume", json!({"threadId":"thread-a"}))
                .await
        });
        let outcomes = futures::future::join_all(controls).await;
        assert!(
            outcomes.iter().all(Result::is_ok),
            "concurrent controls must not exhaust admission retries: {outcomes:?}"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 67);
        for changed in ["uid", "epoch", "sleeping"] {
            {
                let mut value = current.lock().unwrap();
                *value = agent.clone();
                match changed {
                    "uid" => value.metadata.uid = Some("replaced-workspace".into()),
                    "epoch" => value.spec.runtime_epoch = "replaced-runtime".into(),
                    _ => value.spec.desired_state = crate::crd::MicroVMDesiredState::Sleeping,
                }
            }
            assert!(
                guest
                    .codex_call("thread/resume", json!({"threadId":"thread-a"}))
                    .await
                    .is_err(),
                "a cached client must not dispatch to a changed or sleeping runtime: {changed}"
            );
        }
        assert_eq!(calls.load(Ordering::SeqCst), 67);
    }

    #[tokio::test]
    #[ignore = "requires disposable shared TLS PostgreSQL from test-runtime.sh"]
    async fn runtime_shared_state_terminal_controller_signs_exact_suboperations() {
        use crate::{
            activity::ActivityTracker,
            auth::{Authenticator, Principal, signed_fixture_request},
            authz::WorkspaceAuthorization,
            control::Database,
            gateway::PreviewOrigin,
            grpc::{
                ControlPlane, ControlPlaneConfig,
                proto::{
                    IssueTerminalTicketRequest, TerminateTerminalRequest,
                    micro_vm_control_plane_server::MicroVmControlPlane,
                },
            },
            ofz::{self, proto::Action},
            tickets::TicketScope,
        };
        use prost::Message;
        use std::sync::atomic::AtomicU8;
        use tengri::guest_authorization::{
            CONTEXT_HEADER, GuestAction, GuestProof, GuestSigner, GuestVerifier, SIGNATURE_HEADER,
            body_sha256,
        };

        fn verify<T: Message>(
            request: &tonic::Request<T>,
            verifier: &GuestVerifier,
            action: GuestAction,
            method: &str,
            target: &str,
        ) {
            let proof = GuestProof {
                context: request
                    .metadata()
                    .get(CONTEXT_HEADER)
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .into(),
                signature: request
                    .metadata()
                    .get(SIGNATURE_HEADER)
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .into(),
            };
            let context = verifier.verify(&proof, ofz::now_ms().unwrap()).unwrap();
            assert_eq!(context.action, action);
            assert_eq!(context.method, method);
            assert_eq!(context.target, target);
            assert_eq!(
                context.body_sha256,
                body_sha256(&request.get_ref().encode_to_vec())
            );
        }

        let database = Arc::new(
            Database::from_environment("tengri_controller")
                .await
                .unwrap(),
        );
        database.verify_schema().await.unwrap();
        let signer = GuestSigner::from_seed(&std::array::from_fn::<_, 32, _>(|i| i as u8)).unwrap();
        let verifier = GuestVerifier::from_bytes(signer.public_key()).unwrap();
        let terminate_verifier = verifier.clone();
        let codex_verifier = verifier.clone();
        let directory_verifier = verifier.clone();
        let write_verifier = verifier.clone();
        let calls = Arc::new(AtomicUsize::new(0));
        let lists = calls.clone();
        let terminations = calls.clone();
        let server = TestServer::start(TestService {
            get_info: Some(Arc::new(|_| {
                Ok(proto::GuestInfo {
                    microvm_id: "33333333-3333-4333-8333-333333333333".into(),
                    protocol_version: tengri::GUEST_API_PROTOCOL_VERSION,
                    ..Default::default()
                })
            })),
            list_terminals: Some(Arc::new(move |request| {
                verify(
                    &request,
                    &verifier,
                    GuestAction::TerminalObserve,
                    "/proompteng.runtime.guest.v1.NanoagentService/ListTerminals",
                    "",
                );
                lists.fetch_add(1, Ordering::SeqCst);
                Ok(proto::TerminalList {
                    sessions: vec![proto::TerminalSession {
                        id: "terminal-current".into(),
                        ..Default::default()
                    }],
                })
            })),
            terminate_terminal: Some(Arc::new(move |request| {
                verify(
                    &request,
                    &terminate_verifier,
                    GuestAction::TerminalControl,
                    "/proompteng.runtime.guest.v1.NanoagentService/TerminateTerminal",
                    "terminal-current",
                );
                assert_eq!(request.get_ref().id, "terminal-current");
                terminations.fetch_add(1, Ordering::SeqCst);
                Ok(proto::Empty {})
            })),
            codex_call: Some(Arc::new(move |request| {
                verify(
                    &request,
                    &codex_verifier,
                    GuestAction::CodexControl,
                    "/proompteng.runtime.guest.v1.NanoagentService/CodexCall",
                    "",
                );
                assert_eq!(request.get_ref().method, "thread/resume");
                Ok(proto::CodexResult {
                    result_json: b"{}".to_vec(),
                    event_sequence: 1,
                })
            })),
            create_directory: Some(Arc::new(move |request| {
                verify(
                    &request,
                    &directory_verifier,
                    GuestAction::FilesWrite,
                    "/proompteng.runtime.guest.v1.NanoagentService/CreateDirectory",
                    "/workspace/.tengri-attachments",
                );
                Ok(proto::FileEntry {
                    path: request.get_ref().path.clone(),
                    directory: true,
                    ..Default::default()
                })
            })),
            write_file: Some(Arc::new(move |request| {
                verify(
                    &request,
                    &write_verifier,
                    GuestAction::FilesWrite,
                    "/proompteng.runtime.guest.v1.NanoagentService/WriteFile",
                    &request.get_ref().path,
                );
                assert!(
                    request
                        .get_ref()
                        .path
                        .starts_with("/workspace/.tengri-attachments/")
                );
                assert_eq!(request.get_ref().expected_revision, "missing");
                Ok(proto::FileWriteResult {
                    path: request.get_ref().path.clone(),
                    size: request.get_ref().content.len() as i64,
                    revision: super::super::revision_for_content(&request.get_ref().content),
                })
            })),
            ..Default::default()
        })
        .await;
        let mut agent = agent();
        agent.metadata.resource_version = Some("11".into());
        let response_agent = agent.clone();
        let service = tower::service_fn(move |request: http::Request<KubeBody>| {
            let body = if request.uri().path().contains("/secrets/") {
                json!({"apiVersion":"v1","kind":"Secret","immutable":true,
                    "data":{"token":"Zml4dHVyZS10b2tlbg=="}})
            } else {
                serde_json::to_value(&response_agent).unwrap()
            };
            async move {
                Ok::<_, std::convert::Infallible>(
                    http::Response::builder()
                        .header("content-type", "application/json")
                        .body(KubeBody::from(body.to_string().into_bytes()))
                        .unwrap(),
                )
            }
        });
        let client = Client::new(service, "tengri");
        let mode = Arc::new(AtomicU8::new(0));
        let authorization = WorkspaceAuthorization::ControlledFixture(mode.clone());
        let codex_pool = GuestPool::new(
            client.clone(),
            "tengri",
            WorkloadIdentity::Fixture(
                server
                    .guest
                    .base_url()
                    .strip_prefix("http://")
                    .unwrap()
                    .parse::<SocketAddr>()
                    .unwrap()
                    .port(),
            ),
        );
        let codex_authority =
            super::super::authorization::GuestAuthority::fixture_with_authorization(
                authorization.clone(),
            );
        let control = ControlPlane::new(
            client.clone(),
            ControlPlaneConfig {
                identity: WorkloadIdentity::Fixture(
                    server
                        .guest
                        .base_url()
                        .strip_prefix("http://")
                        .unwrap()
                        .parse::<SocketAddr>()
                        .unwrap()
                        .port(),
                ),
                authorization: authorization.clone(),
                guest_authority:
                    super::super::authorization::GuestAuthority::fixture_with_authorization(
                        authorization.clone(),
                    ),
                namespace: "tengri".into(),
                default_image: format!("registry.example/nanoagent@sha256:{}", "b".repeat(64)),
                architecture: crate::crd::MicroVMArchitecture::Amd64,
                database: database.clone(),
                auth: Authenticator::fixture("https://proompteng.ai".into()),
                public_url: "https://tengri.example.test".into(),
                preview_origin: PreviewOrigin::parse(
                    "https://tengri-{session}.example.test".into(),
                    "https://tengri.example.test".into(),
                )
                .unwrap(),
            },
            ActivityTracker::new(client, "tengri".into()),
        )
        .unwrap();
        let mut principal = Principal::fixture(
            &"a".repeat(64),
            &agent.uid().unwrap(),
            Action::TerminalControl,
        );
        principal.context.runtime_epoch = agent.spec.runtime_epoch.clone();
        let terminate = || {
            signed_fixture_request(
                TerminateTerminalRequest {
                    agent_id: agent.name_any(),
                    terminal_id: "terminal-current".into(),
                },
                &principal,
                "/proompteng.runtime.v1.MicroVMControlPlane/TerminateTerminal",
                control.request_audience(),
            )
        };
        let ticket = || {
            signed_fixture_request(
                IssueTerminalTicketRequest {
                    agent_id: agent.name_any(),
                    terminal_id: "terminal-current".into(),
                },
                &principal,
                "/proompteng.runtime.v1.MicroVMControlPlane/IssueTerminalTicket",
                control.request_audience(),
            )
        };
        let terminated = control.terminate_terminal(terminate()).await;
        let issued = control.issue_terminal_ticket(ticket()).await;
        assert!(
            terminated.is_ok() && issued.is_ok(),
            "signed terminal termination and ticket issuance must reach the guest: {terminated:?}; {issued:?}"
        );
        let ticket = issued.unwrap().into_inner();
        let record = control.tickets().consume(&ticket.ticket).await.unwrap();
        assert_eq!(record.principal.action, Action::TerminalControl);
        assert!(
            matches!(record.scope, TicketScope::Terminal { terminal_id } if terminal_id == "terminal-current")
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        let mut codex_principal = principal.clone();
        codex_principal.action = Action::CodexControl;
        let codex_access = authorization
            .agent_access(&codex_principal, &agent, "thread-current")
            .unwrap();
        let codex = codex_pool
            .for_microvm(&agent, codex_authority.user(codex_access))
            .await
            .unwrap();
        codex
            .codex_call("thread/resume", json!({"threadId":"thread-current"}))
            .await
            .unwrap();
        let input = crate::grpc::codex_turn_input(
            &codex,
            "inspect",
            &[crate::grpc::proto::CodexImage {
                media_type: "image/png".into(),
                content: b"\x89PNG\r\n\x1a\n".to_vec(),
            }],
        )
        .await
        .unwrap();
        assert_eq!(input.len(), 2);
        assert_eq!(input[1]["type"], "localImage");
        for (state, code) in [
            (1, tonic::Code::PermissionDenied),
            (4, tonic::Code::Unavailable),
        ] {
            mode.store(state, Ordering::SeqCst);
            assert_eq!(
                control
                    .terminate_terminal(terminate())
                    .await
                    .unwrap_err()
                    .code(),
                code
            );
            assert_eq!(
                control
                    .issue_terminal_ticket(signed_fixture_request(
                        IssueTerminalTicketRequest {
                            agent_id: agent.name_any(),
                            terminal_id: "terminal-current".into(),
                        },
                        &principal,
                        "/proompteng.runtime.v1.MicroVMControlPlane/IssueTerminalTicket",
                        control.request_audience(),
                    ))
                    .await
                    .unwrap_err()
                    .code(),
                code
            );
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "denial and outage cannot reach terminal handlers"
        );
    }

    #[tokio::test]
    async fn concurrent_requests_reuse_verified_connection_but_failures_and_new_claims_do_not() {
        let verifications = Arc::new(AtomicUsize::new(0));
        let calls = verifications.clone();
        let server = TestServer::start(TestService {
            get_info: Some(Arc::new(move |request| {
                assert_eq!(
                    request.metadata().get("authorization").unwrap(),
                    "Bearer fixture-token"
                );
                assert!(
                    request
                        .metadata()
                        .contains_key(crate::slot::supervisor::CLAIM_UID_HEADER)
                );
                assert!(
                    request
                        .metadata()
                        .contains_key(crate::slot::supervisor::CLAIM_EPOCH_HEADER)
                );
                if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    return Err(tonic::Status::unavailable("transient guest failure"));
                }
                Ok(proto::GuestInfo {
                    microvm_id: "33333333-3333-4333-8333-333333333333".into(),
                    protocol_version: tengri::GUEST_API_PROTOCOL_VERSION,
                    ..Default::default()
                })
            })),
            ..Default::default()
        })
        .await;
        let secrets = Arc::new(AtomicUsize::new(0));
        let secret_calls = secrets.clone();
        let service = tower::service_fn(move |request: http::Request<KubeBody>| {
            assert_eq!(
                request.uri().path(),
                "/api/v1/namespaces/tengri/secrets/slot-a-bootstrap"
            );
            secret_calls.fetch_add(1, Ordering::SeqCst);
            async {
                Ok::<_, std::convert::Infallible>(http::Response::builder().body(KubeBody::from(
                    json!({"apiVersion":"v1","kind":"Secret","immutable":true,"data":{"token":"Zml4dHVyZS10b2tlbg=="}}).to_string().into_bytes()
                )).unwrap())
            }
        });
        let port = server
            .guest
            .base_url()
            .strip_prefix("http://")
            .unwrap()
            .parse::<SocketAddr>()
            .unwrap()
            .port();
        let pool = GuestPool::new(
            Client::new(service, "tengri"),
            "tengri",
            WorkloadIdentity::Fixture(port),
        );
        let mut agent = agent();
        assert!(
            pool.for_microvm(
                &agent,
                super::super::authorization::GuestAuthority::fixture_authorization()
            )
            .await
            .is_err()
        );
        let requests = futures::future::join_all((0..16).map(|_| {
            pool.for_microvm(
                &agent,
                super::super::authorization::GuestAuthority::fixture_authorization(),
            )
        }))
        .await;
        assert!(requests.iter().all(Result::is_ok));
        assert_eq!(verifications.load(Ordering::SeqCst), 2);
        assert_eq!(secrets.load(Ordering::SeqCst), 2);

        agent.spec.slot.as_mut().unwrap().epoch += 1;
        pool.for_microvm(
            &agent,
            super::super::authorization::GuestAuthority::fixture_authorization(),
        )
        .await
        .unwrap();
        agent.metadata.uid = Some("11111111-1111-4111-8111-222222222222".into());
        pool.for_microvm(
            &agent,
            super::super::authorization::GuestAuthority::fixture_authorization(),
        )
        .await
        .unwrap();
        assert_eq!(verifications.load(Ordering::SeqCst), 4);

        pool.bindings.lock().await[0].created -= MAX_AGE;
        pool.for_microvm(
            &agent,
            super::super::authorization::GuestAuthority::fixture_authorization(),
        )
        .await
        .unwrap();
        assert_eq!(verifications.load(Ordering::SeqCst), 5);

        agent.status.as_mut().unwrap().phase = MicroVMPhase::Sleeping;
        assert!(matches!(
            pool.for_microvm(
                &agent,
                super::super::authorization::GuestAuthority::fixture_authorization()
            )
            .await,
            Err(GuestError::NotReady(_))
        ));
        agent.status.as_mut().unwrap().phase = MicroVMPhase::Ready;
        agent.status.as_mut().unwrap().pod_uid = Some("pod-b".into());
        assert!(matches!(
            pool.for_microvm(
                &agent,
                super::super::authorization::GuestAuthority::fixture_authorization()
            )
            .await,
            Err(GuestError::NotReady(_))
        ));
        assert_eq!(secrets.load(Ordering::SeqCst), 5);
    }
}

impl GuestTarget {
    pub fn from_microvm(
        microvm: &MicroVM,
        identity: &WorkloadIdentity,
    ) -> Result<Self, GuestError> {
        let id = microvm.name_any();
        let status = microvm
            .status
            .as_ref()
            .filter(|status| {
                microvm.metadata.deletion_timestamp.is_none()
                    && status.phase == MicroVMPhase::Ready
                    && status.guest_ready
                    && status.observed_generation >= microvm.metadata.generation.unwrap_or_default()
            })
            .ok_or_else(|| GuestError::NotReady(id.clone()))?;
        let ip: IpAddr = status
            .pod_ip
            .as_deref()
            .ok_or_else(|| GuestError::MissingGuestIp(id.clone()))?
            .parse()
            .map_err(|_| GuestError::MissingGuestIp(id.clone()))?;
        let pod_uid = status
            .pod_uid
            .as_deref()
            .filter(|uid| !uid.is_empty())
            .ok_or_else(|| GuestError::NotReady(id.clone()))?;
        let slot = microvm
            .spec
            .slot
            .as_ref()
            .filter(|slot| slot.pod_uid == pod_uid)
            .ok_or_else(|| GuestError::NotReady(id.clone()))?;
        let port = GUEST_API_PORT;
        #[cfg(test)]
        let port = match identity {
            WorkloadIdentity::Fixture(port) => *port,
            _ => port,
        };
        #[cfg(not(test))]
        let _ = identity;
        Ok(Self {
            claim: crate::slot::client::claim_for(microvm)?,
            pod_uid: pod_uid.to_owned(),
            address: SocketAddr::new(ip, port),
            slot_name: slot.name.clone(),
        })
    }
}

struct Binding {
    target: GuestTarget,
    certificate: [u8; 32],
    created: Instant,
    guest: Arc<OnceCell<GuestTransport>>,
}

#[derive(Clone)]
pub struct GuestPool {
    client: Client,
    namespace: Arc<str>,
    identity: WorkloadIdentity,
    bindings: Arc<Mutex<Vec<Binding>>>,
    activity: crate::activity::ActivityTracker,
}

impl GuestPool {
    pub fn new(client: Client, namespace: impl Into<Arc<str>>, identity: WorkloadIdentity) -> Self {
        let namespace = namespace.into();
        Self {
            activity: crate::activity::ActivityTracker::new(client.clone(), namespace.to_string()),
            client,
            namespace,
            identity,
            bindings: Default::default(),
        }
    }

    pub async fn for_agent(
        &self,
        id: &str,
        incarnation: Option<&str>,
        authorization: GuestAuthorization,
    ) -> Result<GuestClient, GuestError> {
        let api: Api<MicroVM> = Api::namespaced(self.client.clone(), &self.namespace);
        let microvm = api.get(id).await?;
        if incarnation.is_some_and(|expected| microvm.metadata.uid.as_deref() != Some(expected)) {
            return Err(GuestError::Api {
                status: reqwest::StatusCode::GONE,
                message: "This editor session belongs to a previous agent. Reopen Code.".to_owned(),
            });
        }
        self.for_microvm(&microvm, authorization).await
    }

    pub async fn for_microvm(
        &self,
        microvm: &MicroVM,
        authorization: GuestAuthorization,
    ) -> Result<GuestClient, GuestError> {
        let target = GuestTarget::from_microvm(microvm, &self.identity)?;
        let issuer = authorization
            .bind(microvm)
            .map_err(super::rpc::rpc_error)?
            .with_activity(self.activity.clone());
        let certificate = self.identity.certificate_revision()?;
        let now = Instant::now();
        let guest = {
            let mut bindings = self.bindings.lock().await;
            bindings.retain(|binding| {
                now.duration_since(binding.created) < MAX_AGE
                    && (binding.target.claim.microvm_id != target.claim.microvm_id
                        || (binding.target == target && binding.certificate == certificate))
            });
            if let Some(binding) = bindings
                .iter()
                .find(|binding| binding.target == target && binding.certificate == certificate)
            {
                binding.guest.clone()
            } else {
                if bindings.len() >= MAX_CONNECTIONS {
                    bindings.remove(0);
                }
                let guest = Arc::new(OnceCell::new());
                bindings.push(Binding {
                    target: target.clone(),
                    certificate,
                    created: now,
                    guest: guest.clone(),
                });
                guest
            }
        };
        guest
            .get_or_try_init(|| async {
                let _latency =
                    crate::metrics::global().latency_timer(crate::metrics::Latency::GuestConnect);
                GuestTransport::connect(
                    self.client.clone(),
                    &self.namespace,
                    target,
                    &self.identity,
                    issuer.clone(),
                )
                .await
            })
            .await?
            .clone()
            .authorize(issuer)
    }
}

#[cfg(test)]
mod agent_work_tests {
    use super::*;
    use crate::{
        activity::{ActivityTracker, AgentWorkMonitor},
        guest::{
            authorization::GuestAuthority,
            rpc::{
                proto,
                test_server::{TestServer, TestService},
            },
        },
    };
    use kube::client::Body as KubeBody;
    use serde_json::json;
    use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};

    #[tokio::test]
    async fn automatic_sleep_requires_confirmed_idle_and_preserves_user_activity() {
        let mode = Arc::new(AtomicU8::new(0));
        let reported = mode.clone();
        let server = TestServer::start(TestService {
            get_info: Some(Arc::new(move |_| {
                let mode = reported.load(Ordering::SeqCst);
                if mode == 4 {
                    return Err(tonic::Status::unavailable("guest reconnecting"));
                }
                Ok(proto::GuestInfo {
                    microvm_id: "33333333-3333-4333-8333-333333333333".into(),
                    protocol_version: tengri::GUEST_API_PROTOCOL_VERSION,
                    codex_activity: match mode {
                        3 => None,
                        _ => Some(proto::CodexActivity {
                            working: mode == 0,
                            idle_for_ms: if mode == 1 { 59_999 } else { 60_000 },
                        }),
                    },
                })
            })),
            ..Default::default()
        })
        .await;
        let mut agent: MicroVM = serde_json::from_value(json!({
            "apiVersion":"runtime.proompteng.ai/v1alpha1", "kind":"MicroVM",
            "metadata":{"name":"agent-a", "uid":"11111111-1111-4111-8111-111111111111", "generation":2},
            "spec":{
                "reservationId":"77f8ce6b-18c5-4f7b-950c-b5639b70619e",
                "runtimeEpoch":"39d272fe-2781-4bc2-886c-a2993865f646", "policyVersion":1,
                "displayName":"Agent", "ownerHash":"owner", "desiredState":"Running",
                "image":"test-image", "architecture":"amd64", "resources":{"cpuMillis":4000,"memoryMib":8192,"workspaceGib":32},
                "createdAt":"2026-10-11T00:00:00Z", "idleDeadline":"2026-10-12T00:00:00Z",
                "slot":{"name":"slot-a","podUid":"33333333-3333-4333-8333-333333333333","pvcName":"home-a","pvcUid":"home-uid","epoch":7}
            },
            "status":{"phase":"Ready", "guestReady":true, "podUid":"33333333-3333-4333-8333-333333333333", "podIp":"127.0.0.1", "observedGeneration":2}
        })).unwrap();
        agent.spec.power.idle_timeout_minutes = 1;
        let reply = json!(agent).to_string();
        let patches = Arc::new(AtomicUsize::new(0));
        let writes = patches.clone();
        let service = tower::service_fn(move |request: http::Request<KubeBody>| {
            let reply = reply.clone();
            let writes = writes.clone();
            async move {
                let body = if request.method() == http::Method::PATCH {
                    assert!(request.uri().path().ends_with("/microvms/agent-a"));
                    let bytes = http_body_util::BodyExt::collect(request.into_body())
                        .await
                        .unwrap()
                        .to_bytes();
                    let patch: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                    assert!(
                        patch["metadata"]["annotations"]
                            [crate::activity::LAST_AGENT_WORK_ANNOTATION]
                            .is_string()
                    );
                    assert!(
                        patch["metadata"]["annotations"]
                            .get(crate::activity::LAST_ACTIVITY_ANNOTATION)
                            .is_none(),
                        "guest work must not overwrite newer user activity"
                    );
                    writes.fetch_add(1, Ordering::SeqCst);
                    reply
                } else {
                    assert!(request.uri().path().ends_with("/secrets/slot-a-bootstrap"));
                    json!({"apiVersion":"v1","kind":"Secret","immutable":true,"data":{"token":"Zml4dHVyZS10b2tlbg=="}}).to_string()
                };
                Ok::<_, std::convert::Infallible>(http::Response::new(KubeBody::from(
                    body.into_bytes(),
                )))
            }
        });
        let client = Client::new(service, "tengri");
        let port = server
            .guest
            .base_url()
            .strip_prefix("http://")
            .unwrap()
            .parse::<SocketAddr>()
            .unwrap()
            .port();
        let monitor = AgentWorkMonitor::new(
            GuestPool::new(client.clone(), "tengri", WorkloadIdentity::Fixture(port)),
            GuestAuthority::fixture(),
            ActivityTracker::new(client, "tengri".into()),
        );
        assert!(
            !monitor.permits_sleep(&agent).await.unwrap(),
            "active work must inhibit sleep"
        );
        mode.store(1, Ordering::SeqCst);
        assert!(
            !monitor.permits_sleep(&agent).await.unwrap(),
            "recent completion must start a full idle interval"
        );
        assert_eq!(patches.load(Ordering::SeqCst), 2);
        mode.store(2, Ordering::SeqCst);
        assert!(
            monitor.permits_sleep(&agent).await.unwrap(),
            "fully idle guest may sleep"
        );
        assert_eq!(
            patches.load(Ordering::SeqCst),
            2,
            "observer probes cannot extend idle activity"
        );
        for unavailable in [3, 4] {
            mode.store(unavailable, Ordering::SeqCst);
            assert!(
                monitor.permits_sleep(&agent).await.is_err(),
                "unknown or unavailable state cannot authorize sleep"
            );
        }
        mode.store(0, Ordering::SeqCst);
        assert!(
            !monitor.permits_sleep(&agent).await.unwrap(),
            "reconnection must observe ongoing work"
        );
    }

    #[tokio::test]
    async fn work_probe_cannot_read_workspace_content() {
        let agent: MicroVM = serde_json::from_value(json!({
            "apiVersion":"runtime.proompteng.ai/v1alpha1","kind":"MicroVM",
            "metadata":{"name":"agent-a","uid":"11111111-1111-4111-8111-111111111111"},
            "spec":{"reservationId":"77f8ce6b-18c5-4f7b-950c-b5639b70619e","runtimeEpoch":"39d272fe-2781-4bc2-886c-a2993865f646","policyVersion":1,"displayName":"Agent","ownerHash":"owner","desiredState":"Running","image":"test","architecture":"amd64","resources":{"cpuMillis":4000,"memoryMib":8192,"workspaceGib":32},"createdAt":"2026-10-11T00:00:00Z","idleDeadline":"2026-10-12T00:00:00Z","slot":{"name":"slot-a","podUid":"33333333-3333-4333-8333-333333333333","pvcName":"home-a","pvcUid":"home-uid","epoch":7}}
        })).unwrap();
        let issuer = GuestAuthority::fixture().probe().bind(&agent).unwrap();
        let error = issuer
            .sign(
                "/proompteng.runtime.guest.v1.NanoagentService/ListFiles",
                "/workspace",
                &[],
            )
            .await
            .err()
            .expect("content must be denied");
        assert_eq!(error.code(), tonic::Code::PermissionDenied);
    }
}
