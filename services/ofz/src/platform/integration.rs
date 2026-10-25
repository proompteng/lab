use super::{
    authorization,
    mutations::{self, Command},
    onboarding,
};
use crate::{
    control_integration::{acknowledge_fixture_archive, setup},
    native::{Relationship, Update},
    policy, proto as p,
};
use platform_client::{ExecutionPayload, authz as sdk, relay as wire};
use sha2::{Digest, Sha256};
use tonic::{Code, Request};
use uuid::Uuid;
const RELAY: &str = "spiffe://proompteng.ai/ns/relay/sa/relay";
const OPENCODE: &str = "spiffe://proompteng.ai/ns/opencode/sa/opencode";
fn delegated_request(
    payload: &ExecutionPayload,
    credential: &str,
) -> Request<wire::ExecuteRequest> {
    let body = serde_json::to_vec(payload).unwrap();
    let proof = super::proof::tests::signed_proof(credential, &Sha256::digest(&body)).1;
    let mut request = platform_client::request(wire::ExecuteRequest {
        subject: Some(sdk::PlatformSubject {
            client_service: payload.client_service.clone(),
            identity: Some(sdk::platform_subject::Identity::Delegation(
                sdk::PlatformDelegationProof {
                    delegation_id: payload.delegation_id.clone().unwrap(),
                    credential: credential.into(),
                    proof,
                },
            )),
        }),
        body,
    });
    request
        .extensions_mut()
        .insert(platform_client::tls::Peer(policy::BFF_ID.into()));
    request
}
fn session(id: &(String, String)) -> p::PlatformHumanSession {
    p::PlatformHumanSession {
        human_id: id.0.clone(),
        session_id: id.1.clone(),
        origin: "https://proompteng.ai".into(),
    }
}
fn resource(id: &str) -> p::PlatformResource {
    p::PlatformResource {
        kind: "kubernetes.namespace".into(),
        id: id.into(),
        target: String::new(),
    }
}
fn check(id: &str) -> p::CheckPlatformAccessRequest {
    p::CheckPlatformAccessRequest {
        operation_id: Uuid::new_v4().to_string(),
        subject: Some(p::PlatformSubject {
            client_service: "opencode".into(),
            identity: Some(p::platform_subject::Identity::WorkloadId(OPENCODE.into())),
        }),
        action: "kubernetes.status.read".into(),
        resources: vec![resource(id)],
        request_hash: Sha256::digest(b"isolated platform fixture").to_vec(),
        ..Default::default()
    }
}
#[tokio::test]
#[ignore = "requires isolated PostgreSQL, SpiceDB and TLS Kubernetes fixture from test-control.sh platform"]
async fn platform_policy_and_both_clients_execute_through_relay() {
    let (admin, database, native, humans) = setup().await;
    let connection = admin.pool.get().await.unwrap();
    native
        .write_schema(include_str!(
            "../../tests/fixtures/authorization-before-platform.zed"
        ))
        .await
        .unwrap();
    native
        .apply(
            &Uuid::new_v4().to_string(),
            1,
            &[
                Update::touch(Relationship::new(
                    "kube_namespace",
                    "galactic/retired",
                    "platform",
                    "platform",
                    "lab",
                )),
                Update::touch(Relationship::new(
                    "kube_namespace",
                    "galactic/retired",
                    "status_reader",
                    "human",
                    &humans[0].0,
                )),
                Update::touch(Relationship::new(
                    "platform",
                    "lab",
                    "kube_broker",
                    "workload",
                    &policy::workload_object_id(
                        "spiffe://proompteng.ai/ns/tengri/sa/tengri-kube-broker",
                    ),
                )),
            ],
        )
        .await
        .unwrap();
    connection
        .execute("UPDATE ofz.platform_state SET version=2", &[])
        .await
        .unwrap();
    // The old control fixture seeds the original bootstrap state explicitly; never a production operation.
    let base_hash = native.schema_hash().await.unwrap();
    connection.execute("INSERT INTO ofz.bootstrap(fingerprint,manifest,schema_hash,bootstrap_audit_id,activation_audit_id,phase,bootstrap_receipt,activation_receipt) VALUES($1,'{}',$2,$3,$4,'active','{}','{}')", &[&vec![0u8;32],&base_hash,&Uuid::new_v4(),&Uuid::new_v4()]).await.unwrap();
    assert_eq!(
        onboarding::execute(&database, &native)
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    connection.batch_execute("CREATE FUNCTION ofz.fixture_interrupt_onboarding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.receipt->>'platform_action'='ofz.policies.onboard' THEN RAISE EXCEPTION 'isolated onboarding interruption'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_interrupt_onboarding BEFORE INSERT ON ofz.audit FOR EACH ROW EXECUTE FUNCTION ofz.fixture_interrupt_onboarding();").await.unwrap();
    assert_eq!(
        onboarding::execute(&admin, &native)
            .await
            .unwrap_err()
            .code(),
        Code::Unavailable
    );
    assert_eq!(
        connection
            .query_one(
                "SELECT count(*) FROM ofz.platform_policy_installations WHERE NOT completed",
                &[]
            )
            .await
            .unwrap()
            .get::<_, i64>(0),
        1
    );
    assert!(onboarding::verify(&database).await.is_err());
    assert_eq!(
        native.schema_hash().await.unwrap(),
        onboarding::expected_schema_hash().unwrap()
    );
    connection.batch_execute("DROP TRIGGER fixture_interrupt_onboarding ON ofz.audit; DROP FUNCTION ofz.fixture_interrupt_onboarding();").await.unwrap();
    let revision = onboarding::execute(&admin, &native).await.unwrap();
    assert_eq!(
        onboarding::execute(&admin, &native).await.unwrap(),
        revision
    );
    assert_eq!(
        connection
            .query_one("SELECT schema_hash FROM ofz.bootstrap", &[])
            .await
            .unwrap()
            .get::<_, Vec<u8>>(0),
        base_hash
    );
    onboarding::verify(&database).await.unwrap();
    let namespace = Uuid::new_v4().to_string();
    let resource_id = format!("galactic/{namespace}");
    assert!(
        !authorization::check(&database, &native, RELAY, check(&resource_id))
            .await
            .unwrap()
            .allowed
    );
    let assignments = vec![
        p::PolicyRelationship {
            resource: Some(resource(&resource_id)),
            relation: "status_reader".into(),
            subject_kind: "workload".into(),
            subject_id: OPENCODE.into(),
            enabled: true,
        },
        p::PolicyRelationship {
            resource: Some(resource(&resource_id)),
            relation: "status_reader".into(),
            subject_kind: "human".into(),
            subject_id: humans[0].0.clone(),
            enabled: true,
        },
        p::PolicyRelationship {
            resource: Some(resource(&resource_id)),
            relation: "log_reader".into(),
            subject_kind: "human".into(),
            subject_id: humans[0].0.clone(),
            enabled: true,
        },
    ];
    let mut write = p::WritePolicyRelationshipsRequest {
        operation_id: Uuid::new_v4().to_string(),
        administrator: Some(session(&humans[0])),
        expected_policy_version: database.state().await.unwrap().version,
        relationships: assignments,
        reason: "isolated namespace policy onboarding".into(),
    };
    let mut forged = write.clone();
    forged.administrator = Some(session(&humans[2]));
    assert_eq!(
        mutations::execute(
            &database,
            &native,
            policy::BFF_ID,
            Command::Relationships(forged)
        )
        .await
        .unwrap_err()
        .code(),
        Code::PermissionDenied
    );
    let state = database.state().await.unwrap();
    crate::commands::execute(
        &database,
        &native,
        policy::BFF_ID,
        p::ExecuteCommandRequest {
            operation_id: write.operation_id.clone(),
            expected_version: state.version,
            reason: "prove command marker domain separation".into(),
            context: Some(p::RequestContext {
                actor: Some(p::Actor {
                    identity: Some(p::actor::Identity::HumanId(humans[0].0.clone())),
                }),
                session_id: humans[0].1.clone(),
                trace_id: Uuid::new_v4().to_string(),
                deadline_unix_ms: state.now_ms + 25000,
                origin: "https://proompteng.ai".into(),
                contract_version: crate::CONTRACT_VERSION,
                ..Default::default()
            }),
            command: Some(p::execute_command_request::Command::SetQuota(p::SetQuota {
                human_id: humans[0].0.clone(),
                total_workspaces: 2,
                active_workspaces: 1,
                retained_bytes: 64 * 1024 * 1024 * 1024,
            })),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    write.expected_policy_version = database.state().await.unwrap().version;
    let applied = mutations::execute(
        &database,
        &native,
        policy::BFF_ID,
        Command::Relationships(write.clone()),
    )
    .await
    .unwrap();
    assert_eq!(
        mutations::execute(
            &database,
            &native,
            policy::BFF_ID,
            Command::Relationships(write)
        )
        .await
        .unwrap()
        .decision
        .audit_receipt_id,
        applied.decision.audit_receipt_id
    );
    assert!(
        authorization::check(&database, &native, RELAY, check(&resource_id))
            .await
            .unwrap()
            .allowed
    );
    assert!(
        !authorization::check(&database, &native, RELAY, check("galactic/other-namespace"))
            .await
            .unwrap()
            .allowed
    );
    assert_eq!(
        authorization::check(&database, &native, policy::BFF_ID, check(&resource_id))
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    let entered = std::sync::Arc::new(tokio::sync::Notify::new());
    let resume = std::sync::Arc::new(tokio::sync::Notify::new());
    let delayed = native
        .clone()
        .with_check_barrier(entered.clone(), resume.clone());
    let delayed_database = database.clone();
    let delayed_request = check(&resource_id);
    let admitted = tokio::spawn(async move {
        authorization::check(&delayed_database, &delayed, RELAY, delayed_request).await
    });
    entered.notified().await;
    tokio::time::sleep(std::time::Duration::from_millis(2100)).await;
    resume.notify_one();
    entered.notified().await;
    resume.notify_one();
    let admitted = admitted.await.unwrap().unwrap();
    assert!(admitted.allowed);
    assert!(admitted.valid_until_unix_ms > database.state().await.unwrap().now_ms);
    let workspace = Uuid::new_v4();
    let epoch = Uuid::new_v4();
    let reservation = Uuid::new_v4();
    connection.execute("INSERT INTO ofz.reservations(id,owner_id,home_bytes,workspace_uid,state) VALUES($1,$2,34359738368,$3,'enrolled')", &[&reservation,&humans[0].0,&workspace]).await.unwrap();
    connection.execute("INSERT INTO ofz.workspaces(uid,owner_id,home_uid,reservation_id,home_bytes,running,runtime_epoch) VALUES($1,$2,$3,$4,34359738368,true,$5)", &[&workspace,&humans[0].0,&Uuid::new_v4(),&reservation,&epoch]).await.unwrap();
    let version = database.state().await.unwrap().version;
    native
        .apply(
            &Uuid::new_v4().to_string(),
            version,
            &[
                Update::touch(Relationship::new(
                    "workspace",
                    &workspace.to_string(),
                    "owner",
                    "human",
                    &humans[0].0,
                )),
                Update::touch(Relationship::new(
                    "workspace",
                    &workspace.to_string(),
                    "platform",
                    "platform",
                    "lab",
                )),
            ],
        )
        .await
        .unwrap();
    connection
        .execute("UPDATE ofz.platform_state SET version=version+1", &[])
        .await
        .unwrap();
    // A workspace owner can delegate approved reads without being a platform administrator.
    let version = database.state().await.unwrap().version;
    native
        .apply(
            &Uuid::new_v4().to_string(),
            version,
            &[Update::delete(Relationship::new(
                "platform",
                "lab",
                "administrator",
                "human",
                &humans[0].0,
            ))],
        )
        .await
        .unwrap();
    connection
        .execute(
            "DELETE FROM ofz.memberships WHERE human_id=$1 AND role=2",
            &[&humans[0].0],
        )
        .await
        .unwrap();
    connection
        .execute("UPDATE ofz.platform_state SET version=version+1", &[])
        .await
        .unwrap();
    let body_hash = Sha256::digest(b"delegation fixture").to_vec();
    let (thumbprint, _) = super::proof::tests::signed_proof(&"x".repeat(43), &body_hash);
    let create = p::CreatePlatformDelegationRequest {
        operation_id: Uuid::new_v4().to_string(),
        issuer: Some(session(&humans[0])),
        client_service: "tengri-web".into(),
        agent_id: Uuid::new_v4().to_string(),
        actions: vec![
            "kubernetes.status.read".into(),
            "kubernetes.logs.read".into(),
        ],
        resources: vec![resource(&resource_id)],
        proof_key_thumbprint: thumbprint.clone(),
        expires_at_unix_ms: database.state().await.unwrap().now_ms + 60_000,
        binding: Some(p::PlatformBinding {
            service: "tengri".into(),
            id: workspace.to_string(),
            generation: epoch.to_string(),
        }),
    };
    let mut interrupted = create.clone();
    interrupted.operation_id = Uuid::new_v4().to_string();
    connection.batch_execute("CREATE FUNCTION ofz.fixture_interrupt_delegation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.receipt->>'platform_action'='ofz.delegations.create' THEN RAISE EXCEPTION 'isolated delegation interruption'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_interrupt_delegation BEFORE INSERT ON ofz.audit FOR EACH ROW EXECUTE FUNCTION ofz.fixture_interrupt_delegation();").await.unwrap();
    assert_eq!(
        mutations::execute(
            &database,
            &native,
            policy::BFF_ID,
            Command::Create(interrupted.clone())
        )
        .await
        .unwrap_err()
        .code(),
        Code::Unavailable
    );
    assert!(
        native
            .applied(&format!("platform-command/{}", interrupted.operation_id))
            .await
            .unwrap()
            .0
    );
    assert!(onboarding::verify(&database).await.is_err());
    connection.batch_execute("DROP TRIGGER fixture_interrupt_delegation ON ofz.audit; DROP FUNCTION ofz.fixture_interrupt_delegation();").await.unwrap();
    let recovered = mutations::execute(
        &database,
        &native,
        policy::BFF_ID,
        Command::Create(interrupted),
    )
    .await
    .unwrap();
    assert!(recovered.credential.is_empty());
    assert!(
        !connection
            .query_one(
                "SELECT active FROM ofz.platform_delegations WHERE id=$1",
                &[&Uuid::parse_str(&recovered.delegation_id).unwrap()]
            )
            .await
            .unwrap()
            .get::<_, bool>(0)
    );
    let created = mutations::execute(
        &database,
        &native,
        policy::BFF_ID,
        Command::Create(create.clone()),
    )
    .await
    .unwrap();
    assert!(
        mutations::execute(
            &database,
            &native,
            policy::BFF_ID,
            Command::Create(create.clone())
        )
        .await
        .unwrap()
        .credential
        .is_empty()
    );
    let mut delegated = check(&resource_id);
    delegated.binding = create.binding.clone();
    delegated.subject = Some(p::PlatformSubject {
        client_service: "tengri-web".into(),
        identity: Some(p::platform_subject::Identity::Delegation(
            p::PlatformDelegationProof {
                delegation_id: created.delegation_id.clone(),
                credential: created.credential.clone(),
                proof: super::proof::tests::signed_proof(&created.credential, &body_hash).1,
            },
        )),
    });
    delegated.request_hash = body_hash.clone();
    assert_eq!(
        authorization::check(&database, &native, RELAY, delegated.clone())
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    mutations::execute(
        &database,
        &native,
        policy::BFF_ID,
        Command::Activate(p::ActivatePlatformDelegationRequest {
            operation_id: Uuid::new_v4().to_string(),
            issuer: Some(session(&humans[0])),
            delegation_id: created.delegation_id.clone(),
            proof_key_thumbprint: thumbprint,
        }),
    )
    .await
    .unwrap();
    assert!(
        authorization::check(&database, &native, RELAY, delegated.clone())
            .await
            .unwrap()
            .allowed
    );
    assert_eq!(
        authorization::check(&database, &native, RELAY, delegated.clone())
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let authority = listener.local_addr().unwrap();
    let ofz = super::service::Service::new(database.clone(), native.clone());
    let grpc = tokio::spawn(async move {
        let incoming =
            async_stream::stream! {loop{yield listener.accept().await.map(|(stream,_)|stream);}};
        tonic::transport::Server::builder().add_service(p::platform_authorization_service_server::PlatformAuthorizationServiceServer::with_interceptor(ofz,|mut r:Request<()>|{r.extensions_mut().insert(crate::transport::Peer(RELAY.into()));Ok(r)})).serve_with_incoming(incoming).await.unwrap();
    });
    let channel = tonic::transport::Endpoint::from_shared(format!("http://{authority}"))
        .unwrap()
        .connect()
        .await
        .unwrap();
    let config_dir = std::path::PathBuf::from(std::env::var("OFZ_TEST_CA_FILE").unwrap())
        .parent()
        .unwrap()
        .to_owned();
    let token_file = config_dir.join("relay-token");
    std::fs::write(&token_file, "isolated-relay-kubernetes-credential").unwrap();
    let (kube_endpoint, requests, kube_task) = kubernetes_fixture(&config_dir, &namespace).await;
    let _config=relay::config::Config::parse(&serde_json::to_vec(&serde_json::json!({"version":1,"connectors":[{"type":"kubernetes","id":"galactic","endpoint":kube_endpoint,"ca_file":config_dir.join("ca.crt"),"token_file":token_file,"namespaces":[{"name":"fixture","uid":namespace}]}]})).unwrap()).unwrap();
    let adapter = relay::kubernetes::Kubernetes::new(
        "galactic".into(),
        kube_endpoint,
        config_dir.join("ca.crt").to_str().unwrap(),
        token_file.to_str().unwrap().into(),
        vec![relay::config::Namespace {
            name: "fixture".into(),
            uid: namespace.clone(),
        }],
    )
    .unwrap();
    let relay = relay::service::Service::new(
        vec![
            sdk::RegisteredRelayClient {
                id: "opencode".into(),
                identities: vec![OPENCODE.into()],
            },
            sdk::RegisteredRelayClient {
                id: "tengri-web".into(),
                identities: vec![policy::BFF_ID.into()],
            },
        ],
        vec![Box::new(adapter)],
        channel,
    )
    .unwrap();
    use wire::relay_service_server::RelayService;
    let payload = ExecutionPayload {
        operation_id: Uuid::new_v4().to_string(),
        client_service: "opencode".into(),
        connector_id: "galactic".into(),
        operation: "status".into(),
        arguments: serde_json::json!({"namespace":"fixture"}),
        binding: None,
        delegation_id: None,
    };
    let mut invocation = platform_client::request(wire::ExecuteRequest {
        subject: Some(sdk::PlatformSubject {
            client_service: "opencode".into(),
            identity: Some(sdk::platform_subject::Identity::WorkloadId(OPENCODE.into())),
        }),
        body: serde_json::to_vec(&payload).unwrap(),
    });
    invocation
        .extensions_mut()
        .insert(platform_client::tls::Peer(OPENCODE.into()));
    let response = relay.execute(invocation).await.unwrap().into_inner();
    let status = String::from_utf8(response.result).unwrap();
    assert!(status.contains("fixture-pod"));
    assert!(!status.contains("must-never-leave-status"));
    assert!(!response.execution_receipt_id.is_empty());
    let mut payload = ExecutionPayload {
        operation_id: Uuid::new_v4().to_string(),
        client_service: "tengri-web".into(),
        connector_id: "galactic".into(),
        operation: "logs".into(),
        arguments: serde_json::json!({"namespace":"fixture","pod":"fixture-pod"}),
        binding: Some(sdk::PlatformBinding {
            service: "tengri".into(),
            id: workspace.to_string(),
            generation: epoch.to_string(),
        }),
        delegation_id: Some(created.delegation_id.clone()),
    };
    let body = serde_json::to_vec(&payload).unwrap();
    let proof = super::proof::tests::signed_proof(&created.credential, &Sha256::digest(&body)).1;
    let subject = sdk::PlatformSubject {
        client_service: "tengri-web".into(),
        identity: Some(sdk::platform_subject::Identity::Delegation(
            sdk::PlatformDelegationProof {
                delegation_id: created.delegation_id.clone(),
                credential: created.credential.clone(),
                proof,
            },
        )),
    };
    let mut invocation = platform_client::request(wire::ExecuteRequest {
        subject: Some(subject),
        body,
    });
    invocation
        .extensions_mut()
        .insert(platform_client::tls::Peer(policy::BFF_ID.into()));
    let response = relay.execute(invocation).await.unwrap().into_inner();
    assert_eq!(response.result, b"fixture log line\n");
    assert!(response.content_type.starts_with("text/plain"));
    let before_denials = requests.load(std::sync::atomic::Ordering::SeqCst);
    connection
        .execute(
            "UPDATE ofz.platform_delegations SET expires_at_ms=ofz.now_ms()-1 WHERE id=$1",
            &[&Uuid::parse_str(&created.delegation_id).unwrap()],
        )
        .await
        .unwrap();
    payload.operation_id = Uuid::new_v4().to_string();
    assert_eq!(
        relay
            .execute(delegated_request(&payload, &created.credential))
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    connection
        .execute(
            "UPDATE ofz.platform_delegations SET expires_at_ms=$1 WHERE id=$2",
            &[
                &(create.expires_at_unix_ms as i64),
                &Uuid::parse_str(&created.delegation_id).unwrap(),
            ],
        )
        .await
        .unwrap();
    connection
        .execute(
            "UPDATE ofz.workspaces SET running=false WHERE uid=$1",
            &[&workspace],
        )
        .await
        .unwrap();
    payload.operation_id = Uuid::new_v4().to_string();
    assert_eq!(
        relay
            .execute(delegated_request(&payload, &created.credential))
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    connection
        .execute(
            "UPDATE ofz.workspaces SET running=true WHERE uid=$1",
            &[&workspace],
        )
        .await
        .unwrap();
    assert_eq!(
        requests.load(std::sync::atomic::Ordering::SeqCst),
        before_denials
    );
    let mut denied = payload.clone();
    denied.operation_id = Uuid::new_v4().to_string();
    denied.arguments = serde_json::json!({"namespace":"fixture","pod":"denied"});
    let provider_error = relay
        .execute(delegated_request(&denied, &created.credential))
        .await
        .unwrap_err();
    assert_eq!(provider_error.code(), Code::PermissionDenied);
    assert!(!provider_error.message().contains("PRIVATE_PROVIDER_ERROR"));
    assert_eq!(connection.query_one("SELECT count(*) FROM ofz.platform_executions WHERE operation_id=$1 AND outcome='failed' AND upstream_status=403",&[&Uuid::parse_str(&denied.operation_id).unwrap()]).await.unwrap().get::<_,i64>(0),1);
    let before = requests.load(std::sync::atomic::Ordering::SeqCst);
    mutations::execute(
        &database,
        &native,
        policy::BFF_ID,
        Command::Revoke(p::RevokePlatformDelegationRequest {
            operation_id: Uuid::new_v4().to_string(),
            issuer: Some(session(&humans[0])),
            delegation_id: created.delegation_id.clone(),
        }),
    )
    .await
    .unwrap();
    payload.operation_id = Uuid::new_v4().to_string();
    let body = serde_json::to_vec(&payload).unwrap();
    let mut invocation = platform_client::request(wire::ExecuteRequest {
        subject: Some(sdk::PlatformSubject {
            client_service: "tengri-web".into(),
            identity: Some(sdk::platform_subject::Identity::Delegation(
                sdk::PlatformDelegationProof {
                    delegation_id: created.delegation_id,
                    credential: created.credential.clone(),
                    proof: super::proof::tests::signed_proof(
                        &created.credential,
                        &Sha256::digest(&body),
                    )
                    .1,
                },
            )),
        }),
        body,
    });
    invocation
        .extensions_mut()
        .insert(platform_client::tls::Peer(policy::BFF_ID.into()));
    assert_eq!(
        relay.execute(invocation).await.unwrap_err().code(),
        Code::Unauthenticated
    );
    assert_eq!(requests.load(std::sync::atomic::Ordering::SeqCst), before);
    acknowledge_fixture_archive(&admin).await;
    assert!(
        connection
            .query_one(
                "SELECT count(*) FROM ofz.platform_executions WHERE outcome='succeeded'",
                &[]
            )
            .await
            .unwrap()
            .get::<_, i64>(0)
            >= 2
    );
    grpc.abort();
    kube_task.abort();
}
async fn kubernetes_fixture(
    directory: &std::path::Path,
    namespace: &str,
) -> (
    String,
    std::sync::Arc<std::sync::atomic::AtomicUsize>,
    tokio::task::JoinHandle<()>,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let cert = std::fs::read(directory.join("server.crt")).unwrap();
    let key = std::fs::read(directory.join("server.key")).unwrap();
    let certificates = rustls_pemfile::certs(&mut cert.as_slice())
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let key = rustls_pemfile::private_key(&mut key.as_slice())
        .unwrap()
        .unwrap();
    let tls = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certificates, key)
        .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(std::sync::Arc::new(tls));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let namespace = namespace.to_owned();
    let count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let requests = count.clone();
    let task = tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let mut stream = acceptor.accept(stream).await.unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 4096];
            while !bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = stream.read(&mut buffer).await.unwrap();
                if n == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..n]);
                assert!(bytes.len() < 16384);
            }
            let request = String::from_utf8(bytes).unwrap();
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("authorization: bearer isolated-relay-kubernetes-credential")
            );
            requests.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let forbidden = request.starts_with("GET /api/v1/namespaces/fixture/pods/denied/log?");
            let body = if forbidden {
                b"PRIVATE_PROVIDER_ERROR".to_vec()
            } else if request.starts_with("GET /api/v1/namespaces/fixture/pods/fixture-pod/log?") {
                b"fixture log line\n".to_vec()
            } else if request.starts_with("GET /api/v1/namespaces/fixture/pods?") {
                serde_json::to_vec(&serde_json::json!({"items":[{"metadata":{"name":"fixture-pod","uid":"pod-uid"},"spec":{"containers":[{"env":[{"name":"PRIVATE_TOKEN","value":"must-never-leave-status"}]}]},"status":{"phase":"Running"}}]})).unwrap()
            } else {
                serde_json::to_vec(&serde_json::json!({"metadata":{"uid":namespace}})).unwrap()
            };
            let response = format!(
                "HTTP/1.1 {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                if forbidden { "403 Forbidden" } else { "200 OK" },
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
            stream.write_all(&body).await.unwrap();
            stream.shutdown().await.unwrap();
        }
    });
    (format!("https://localhost:{port}"), count, task)
}
