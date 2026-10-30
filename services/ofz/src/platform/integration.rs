use super::{
    authorization, connections, executions,
    mutations::{self, Command},
    onboarding,
};
use crate::{
    control_integration::{acknowledge_fixture_archive, setup},
    native::{Relationship, Update},
    policy, proto as p,
};
use platform_client::{ExecutionLookup, ExecutionPayload, authz as sdk, relay as wire};
use sha2::{Digest, Sha256};
use tonic::{Code, Request};
use uuid::Uuid;
const RELAY: &str = "spiffe://proompteng.ai/ns/relay/sa/relay";
const OPENCODE: &str = "spiffe://proompteng.ai/ns/opencode/sa/opencode";
const FIXTURE_FIRST: &str = "spiffe://proompteng.ai/ns/fixture/sa/first";
const FIXTURE_SECOND: &str = "spiffe://proompteng.ai/ns/fixture/sa/second";

struct FixtureConnector {
    resource_id: String,
}
#[tonic::async_trait]
impl relay::connector::Connector for FixtureConnector {
    fn id(&self) -> &str {
        "fixture"
    }
    fn operations(&self) -> Vec<wire::ConnectorOperation> {
        vec![wire::ConnectorOperation {
            connector_id: "fixture".into(),
            name: "read".into(),
            description: "Read a fixture value without HTTP".into(),
            action: "fixture.status.read".into(),
            input_schema_json: br#"{"type":"object","properties":{},"additionalProperties":false}"#
                .to_vec(),
            targets: vec![wire::ConnectorTarget {
                name: "fixture".into(),
                resource: Some(sdk::PlatformResource {
                    kind: "kubernetes.namespace".into(),
                    id: self.resource_id.clone(),
                    target: String::new(),
                }),
            }],
            read_only: true,
        }]
    }
    fn normalize(
        &self,
        operation: &str,
        arguments: &[u8],
    ) -> Result<relay::connector::Normalized, tonic::Status> {
        if operation != "read"
            || serde_json::from_slice::<serde_json::Value>(arguments).ok()
                != Some(serde_json::json!({}))
        {
            return Err(tonic::Status::invalid_argument("invalid fixture operation"));
        }
        Ok(relay::connector::Normalized {
            action: "fixture.status.read".into(),
            resources: vec![sdk::PlatformResource {
                kind: "kubernetes.namespace".into(),
                id: self.resource_id.clone(),
                target: String::new(),
            }],
            prepared_request: b"second adapter".to_vec(),
        })
    }
    async fn execute(
        &self,
        prepared: &relay::connector::Normalized,
    ) -> Result<relay::connector::Output, relay::connector::Failure> {
        Ok(relay::connector::Output {
            bytes: prepared.prepared_request.clone(),
            content_type: "text/plain".into(),
            upstream_status: 0,
        })
    }
}

fn workload_lookup(
    body: &[u8],
    client: &str,
    identity: &str,
) -> Request<wire::GetExecutionRequest> {
    let mut request = platform_client::request(wire::GetExecutionRequest {
        subject: Some(sdk::PlatformSubject {
            client_service: client.into(),
            identity: Some(sdk::platform_subject::Identity::WorkloadId(identity.into())),
        }),
        body: serde_json::to_vec(&ExecutionLookup {
            execution_body: String::from_utf8(body.to_vec()).unwrap(),
            binding: None,
            delegation_id: None,
        })
        .unwrap(),
    });
    request
        .extensions_mut()
        .insert(platform_client::tls::Peer(identity.into()));
    request
}
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
fn delegated_lookup(
    payload: &ExecutionPayload,
    authority: &mutations::Outcome,
) -> Request<wire::GetExecutionRequest> {
    delegated_lookup_binding(payload, authority, payload.binding.clone())
}
fn delegated_lookup_binding(
    payload: &ExecutionPayload,
    authority: &mutations::Outcome,
    binding: Option<sdk::PlatformBinding>,
) -> Request<wire::GetExecutionRequest> {
    let body = serde_json::to_vec(&ExecutionLookup {
        execution_body: serde_json::to_string(payload).unwrap(),
        binding,
        delegation_id: Some(authority.delegation_id.clone()),
    })
    .unwrap();
    let mut request = platform_client::request(wire::GetExecutionRequest {
        subject: Some(sdk::PlatformSubject {
            client_service: payload.client_service.clone(),
            identity: Some(sdk::platform_subject::Identity::Delegation(
                sdk::PlatformDelegationProof {
                    delegation_id: authority.delegation_id.clone(),
                    credential: authority.credential.clone(),
                    proof: super::proof::tests::signed_proof(
                        &authority.credential,
                        &Sha256::digest(&body),
                    )
                    .1,
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
    assert!(onboarding::verify_configuration(&database).await.is_err());
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
    let mut assignments = vec![
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
    assignments.extend([FIXTURE_FIRST, FIXTURE_SECOND].into_iter().map(|identity| {
        p::PolicyRelationship {
            resource: Some(resource(&resource_id)),
            relation: "status_reader".into(),
            subject_kind: "workload".into(),
            subject_id: identity.into(),
            enabled: true,
        }
    }));
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
    let execution = check(&resource_id);
    let authorized = authorization::check(&database, &native, RELAY, execution.clone())
        .await
        .unwrap();
    let start = p::RecordPlatformExecutionRequest {
        operation_id: execution.operation_id.clone(),
        authorization_receipt_id: authorized.audit_receipt_id,
        request_hash: execution.request_hash.clone(),
        outcome: "started".into(),
        ..Default::default()
    };
    executions::record(&database, RELAY, start.clone())
        .await
        .unwrap();
    let mut observation = execution.clone();
    observation.request_hash = Sha256::digest(b"distinct status observation").to_vec();
    let observed = executions::get(
        &database,
        &native,
        RELAY,
        p::GetPlatformExecutionRequest {
            authorization: Some(observation),
            execution_request_hash: execution.request_hash.clone(),
        },
    )
    .await
    .unwrap()
    .execution
    .unwrap();
    assert_eq!(observed.outcome, "started");
    assert!(observed.result_hash.is_empty());
    assert_eq!(
        observed.authorization_receipt_id,
        start.authorization_receipt_id
    );
    assert_eq!(
        executions::record(&database, RELAY, start.clone())
            .await
            .unwrap_err()
            .code(),
        Code::AlreadyExists
    );
    // An interrupted start owns the operation forever; outcome retries remain idempotent.
    let completed = p::RecordPlatformExecutionRequest {
        outcome: "succeeded".into(),
        upstream_status: 200,
        result_hash: Sha256::digest(b"isolated result").to_vec(),
        ..start
    };
    let first = executions::record(&database, RELAY, completed.clone())
        .await
        .unwrap();
    assert_eq!(
        executions::record(&database, RELAY, completed)
            .await
            .unwrap()
            .audit_receipt_id,
        first.audit_receipt_id
    );
    let concurrent = check(&resource_id);
    let first = authorization::check(&database, &native, RELAY, concurrent.clone())
        .await
        .unwrap();
    let second = authorization::check(&database, &native, RELAY, concurrent.clone())
        .await
        .unwrap();
    connection.batch_execute("CREATE FUNCTION ofz.fixture_pause_execution_start() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$; CREATE TRIGGER fixture_pause_execution_start BEFORE INSERT ON ofz.platform_executions FOR EACH ROW EXECUTE FUNCTION ofz.fixture_pause_execution_start();").await.unwrap();
    let start = p::RecordPlatformExecutionRequest {
        operation_id: concurrent.operation_id.clone(),
        authorization_receipt_id: first.audit_receipt_id,
        request_hash: concurrent.request_hash,
        outcome: "started".into(),
        ..Default::default()
    };
    let other = p::RecordPlatformExecutionRequest {
        authorization_receipt_id: second.audit_receipt_id,
        ..start.clone()
    };
    let (first, second) = tokio::join!(
        executions::record(&database, RELAY, start),
        executions::record(&database, RELAY, other)
    );
    connection.batch_execute("DROP TRIGGER fixture_pause_execution_start ON ofz.platform_executions; DROP FUNCTION ofz.fixture_pause_execution_start();").await.unwrap();
    assert!(
        first.is_ok() ^ second.is_ok(),
        "only one executor may own the start"
    );
    assert_eq!(
        first.err().or_else(|| second.err()).unwrap().code(),
        Code::AlreadyExists
    );
    assert_eq!(connection.query_one("SELECT count(*) FROM ofz.audit WHERE receipt->>'operation_id'=$1 AND receipt->>'platform_action'='relay.execution.started'", &[&concurrent.operation_id]).await.unwrap().get::<_,i64>(0), 1);
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
    let automatic_target = format!("galactic/{}", Uuid::new_v4());
    let automatic = p::PutPlatformConnectionRequest {
        operation_id: Uuid::new_v4().to_string(),
        issuer: Some(session(&humans[0])),
        client_service: "tengri-web".into(),
        connection_id: Uuid::new_v4().to_string(),
        expected_version: 0,
        client_reference: format!("{workspace}/automatic"),
        actions: vec!["kubernetes.status.read".into()],
        resources: vec![resource(&automatic_target)],
        binding: Some(p::PlatformBinding {
            service: "tengri".into(),
            id: workspace.to_string(),
            generation: epoch.to_string(),
        }),
    };
    let mut other_owner = automatic.clone();
    other_owner.operation_id = Uuid::new_v4().to_string();
    other_owner.issuer = Some(session(&humans[1]));
    assert_eq!(
        mutations::execute(
            &database,
            &native,
            policy::BFF_ID,
            Command::PutConnection(other_owner)
        )
        .await
        .unwrap_err()
        .code(),
        Code::PermissionDenied
    );
    assert!(
        !native
            .check(&[crate::native::Check::new(
                "kubernetes_namespace",
                &automatic_target,
                "read_status",
                "human",
                &humans[1].0
            )])
            .await
            .unwrap()
            .0
    );
    connection
        .execute(
            "UPDATE ofz.sessions SET mfa_at_ms=ofz.now_ms()-600000 WHERE id=$1",
            &[&Uuid::parse_str(&humans[0].1).unwrap()],
        )
        .await
        .unwrap();
    let needs_verification = mutations::execute(
        &database,
        &native,
        policy::BFF_ID,
        Command::PutConnection(automatic.clone()),
    )
    .await
    .unwrap_err();
    assert_eq!(needs_verification.code(), Code::PermissionDenied);
    assert_eq!(
        needs_verification.message(),
        "fresh multifactor authentication required"
    );
    assert_eq!(
        connection
            .query_one(
                "SELECT count(*) FROM ofz.platform_connections WHERE id=$1",
                &[&Uuid::parse_str(&automatic.connection_id).unwrap()]
            )
            .await
            .unwrap()
            .get::<_, i64>(0),
        0
    );
    assert!(
        !native
            .check(&[crate::native::Check::new(
                "kubernetes_namespace",
                &automatic_target,
                "read_status",
                "human",
                &humans[0].0
            )])
            .await
            .unwrap()
            .0
    );
    connection
        .execute(
            "UPDATE ofz.sessions SET mfa_at_ms=ofz.now_ms() WHERE id=$1",
            &[&Uuid::parse_str(&humans[0].1).unwrap()],
        )
        .await
        .unwrap();
    let automatic_saved = mutations::execute(
        &database,
        &native,
        policy::BFF_ID,
        Command::PutConnection(automatic.clone()),
    )
    .await
    .unwrap();
    assert!(automatic_saved.decision.allowed);
    assert!(
        native
            .check(&[crate::native::Check::new(
                "kubernetes_namespace",
                &automatic_target,
                "read_status",
                "human",
                &humans[0].0
            )])
            .await
            .unwrap()
            .0
    );
    assert!(
        !native
            .check(&[crate::native::Check::new(
                "kubernetes_namespace",
                &automatic_target,
                "read_logs",
                "human",
                &humans[0].0
            )])
            .await
            .unwrap()
            .0
    );
    assert!(
        !authorization::check(&database, &native, RELAY, check(&automatic_target))
            .await
            .unwrap()
            .allowed
    );
    let repeated = mutations::execute(
        &database,
        &native,
        policy::BFF_ID,
        Command::PutConnection(automatic.clone()),
    )
    .await
    .unwrap();
    assert_eq!(
        repeated.decision.audit_receipt_id,
        automatic_saved.decision.audit_receipt_id
    );
    let automatic_receipt: serde_json::Value = connection
        .query_one(
            "SELECT receipt FROM ofz.audit WHERE id=$1",
            &[&Uuid::parse_str(&automatic_saved.decision.audit_receipt_id).unwrap()],
        )
        .await
        .unwrap()
        .get(0);
    assert!(
        automatic_receipt["platform_resources"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(serde_json::Value::as_str)
            .any(|entry| entry.contains("status_reader") && entry.contains(&automatic_target))
    );
    let version = database.state().await.unwrap().version;
    native
        .apply(
            &Uuid::new_v4().to_string(),
            version,
            &[Update::delete(Relationship::new(
                "kubernetes_namespace",
                &automatic_target,
                "status_reader",
                "human",
                &humans[0].0,
            ))],
        )
        .await
        .unwrap();
    connection
        .execute("UPDATE ofz.platform_state SET version=version+1", &[])
        .await
        .unwrap();
    let gateway = crate::registry::configured()
        .unwrap()
        .service(policy::BFF_ID)
        .unwrap();
    assert_eq!(
        connections::scope_authority(
            &database,
            &native,
            gateway,
            &automatic.actions,
            &automatic.resources,
            automatic.binding.as_ref(),
            &humans[0].0
        )
        .await
        .unwrap_err()
        .code(),
        Code::PermissionDenied
    );
    assert_eq!(
        mutations::execute(
            &database,
            &native,
            policy::BFF_ID,
            Command::PutConnection(automatic.clone())
        )
        .await
        .unwrap_err()
        .code(),
        Code::PermissionDenied
    );
    assert!(
        !native
            .check(&[crate::native::Check::new(
                "kubernetes_namespace",
                &automatic_target,
                "read_status",
                "human",
                &humans[0].0
            )])
            .await
            .unwrap()
            .0
    );
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
    let mut denied_onboarding = automatic.clone();
    denied_onboarding.operation_id = Uuid::new_v4().to_string();
    denied_onboarding.connection_id = Uuid::new_v4().to_string();
    denied_onboarding.client_reference = format!("{workspace}/denied-onboarding");
    denied_onboarding.actions = vec!["kubernetes.events.read".into()];
    assert_eq!(
        mutations::execute(
            &database,
            &native,
            policy::BFF_ID,
            Command::PutConnection(denied_onboarding)
        )
        .await
        .unwrap_err()
        .code(),
        Code::PermissionDenied
    );
    assert!(
        !native
            .check(&[crate::native::Check::new(
                "kubernetes_namespace",
                &automatic_target,
                "read_events",
                "human",
                &humans[0].0
            )])
            .await
            .unwrap()
            .0
    );
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
        expires_at_unix_ms: database.state().await.unwrap().now_ms + 900_000,
        binding: Some(p::PlatformBinding {
            service: "tengri".into(),
            id: workspace.to_string(),
            generation: epoch.to_string(),
        }),
        connection_id: Uuid::new_v4().to_string(),
        expected_connection_version: 1,
    };
    let intent = p::PutPlatformConnectionRequest {
        operation_id: Uuid::new_v4().to_string(),
        issuer: create.issuer.clone(),
        client_service: create.client_service.clone(),
        connection_id: create.connection_id.clone(),
        expected_version: 0,
        client_reference: format!("{workspace}/galactic"),
        actions: create.actions.clone(),
        resources: create.resources.clone(),
        binding: create.binding.clone(),
    };
    connection
        .execute(
            "UPDATE ofz.sessions SET mfa_at_ms=ofz.now_ms()-600000 WHERE id=$1",
            &[&Uuid::parse_str(&humans[0].1).unwrap()],
        )
        .await
        .unwrap();
    let saved = mutations::execute(
        &database,
        &native,
        policy::BFF_ID,
        Command::PutConnection(intent.clone()),
    )
    .await
    .unwrap();
    connection
        .execute(
            "UPDATE ofz.sessions SET mfa_at_ms=ofz.now_ms() WHERE id=$1",
            &[&Uuid::parse_str(&humans[0].1).unwrap()],
        )
        .await
        .unwrap();
    assert_eq!(
        mutations::execute(
            &database,
            &native,
            policy::BFF_ID,
            Command::PutConnection(intent.clone())
        )
        .await
        .unwrap()
        .decision
        .audit_receipt_id,
        saved.decision.audit_receipt_id
    );
    let listed = connections::list(
        &database,
        &native,
        policy::BFF_ID,
        p::ListPlatformConnectionsRequest {
            issuer: create.issuer.clone(),
            client_service: create.client_service.clone(),
            binding: create.binding.clone(),
        },
    )
    .await
    .unwrap()
    .connections;
    assert_eq!(listed.len(), 2);
    assert!(
        listed
            .iter()
            .any(|entry| entry.id == automatic.connection_id)
    );
    let listed = listed
        .iter()
        .find(|entry| entry.id == create.connection_id)
        .unwrap();
    assert!(listed.enabled);
    assert!(!listed.credential_active);
    assert!(listed.binding.as_ref().unwrap().generation.is_empty());
    let legacy_operation = Uuid::new_v4();
    let legacy = connection.execute("INSERT INTO ofz.platform_commands(operation_id,workload_id,fingerprint,prepared) VALUES($1,$2,$3,$4)", &[&legacy_operation,&policy::BFF_ID,&vec![0_u8;32],&serde_json::json!({"command":{"Create":{}}})]).await.unwrap_err();
    assert_eq!(
        legacy.as_db_error().unwrap().code(),
        &tokio_postgres::error::SqlState::CHECK_VIOLATION
    );
    assert!(
        !native
            .applied(&format!("platform-command/{legacy_operation}"))
            .await
            .unwrap()
            .0
    );
    connection
        .execute(
            "UPDATE ofz.sessions SET mfa_at_ms=ofz.now_ms()-600000 WHERE id=$1",
            &[&Uuid::parse_str(&humans[0].1).unwrap()],
        )
        .await
        .unwrap();
    let consent_replay = mutations::execute(
        &database,
        &native,
        policy::BFF_ID,
        Command::PutConnection(intent.clone()),
    )
    .await
    .unwrap();
    assert_eq!(
        consent_replay.decision.audit_receipt_id,
        saved.decision.audit_receipt_id
    );
    let mut renewal = create.clone();
    renewal.operation_id = Uuid::new_v4().to_string();
    let renewed = mutations::execute(
        &database,
        &native,
        policy::BFF_ID,
        Command::Create(renewal.clone()),
    )
    .await
    .unwrap();
    mutations::execute(
        &database,
        &native,
        policy::BFF_ID,
        Command::Activate(p::ActivatePlatformDelegationRequest {
            operation_id: Uuid::new_v4().to_string(),
            issuer: create.issuer.clone(),
            delegation_id: renewed.delegation_id.clone(),
            proof_key_thumbprint: create.proof_key_thumbprint.clone(),
        }),
    )
    .await
    .unwrap();
    mutations::execute(
        &database,
        &native,
        policy::BFF_ID,
        Command::Revoke(p::RevokePlatformDelegationRequest {
            operation_id: Uuid::new_v4().to_string(),
            issuer: create.issuer.clone(),
            delegation_id: renewed.delegation_id,
        }),
    )
    .await
    .unwrap();
    connection
        .execute(
            "UPDATE ofz.sessions SET mfa_at_ms=0 WHERE id=$1",
            &[&Uuid::parse_str(&humans[0].1).unwrap()],
        )
        .await
        .unwrap();
    renewal.operation_id = Uuid::new_v4().to_string();
    assert!(
        mutations::execute(&database, &native, policy::BFF_ID, Command::Create(renewal))
            .await
            .unwrap_err()
            .message()
            .contains("multifactor authentication required")
    );
    connection
        .execute(
            "UPDATE ofz.sessions SET mfa_at_ms=ofz.now_ms() WHERE id=$1",
            &[&Uuid::parse_str(&humans[0].1).unwrap()],
        )
        .await
        .unwrap();
    acknowledge_fixture_archive(&admin).await;
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
    onboarding::verify_configuration(&database).await.unwrap();
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
    let clients =
        sdk::platform_authorization_service_client::PlatformAuthorizationServiceClient::new(
            channel.clone(),
        )
        .get_platform_configuration(platform_client::request(
            sdk::GetPlatformConfigurationRequest {},
        ))
        .await
        .unwrap()
        .into_inner()
        .relay_clients;
    let relay = relay::service::Service::new(
        clients,
        vec![
            Box::new(adapter),
            Box::new(FixtureConnector {
                resource_id: resource_id.clone(),
            }),
        ],
        channel,
    )
    .unwrap();
    let enrolled = relay.clone();
    let enrollment_refresh = tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(2));
        loop {
            interval.tick().await;
            enrolled.refresh_enrollment().await;
        }
    });
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
    let workload_body = serde_json::to_vec(&payload).unwrap();
    let mut invocation = platform_client::request(wire::ExecuteRequest {
        subject: Some(sdk::PlatformSubject {
            client_service: "opencode".into(),
            identity: Some(sdk::platform_subject::Identity::WorkloadId(OPENCODE.into())),
        }),
        body: workload_body.clone(),
    });
    invocation
        .extensions_mut()
        .insert(platform_client::tls::Peer(OPENCODE.into()));
    let response = relay.execute(invocation).await.unwrap().into_inner();
    let result_hash = Sha256::digest(&response.result).to_vec();
    let status = String::from_utf8(response.result).unwrap();
    assert!(status.contains("fixture-pod"));
    assert!(!status.contains("must-never-leave-status"));
    assert!(!response.execution_receipt_id.is_empty());
    let provider_requests = requests.load(std::sync::atomic::Ordering::SeqCst);
    let observed = relay
        .get_execution(workload_lookup(&workload_body, "opencode", OPENCODE))
        .await
        .unwrap()
        .into_inner();
    let execution = observed.execution.unwrap();
    assert_eq!(execution.operation_id, payload.operation_id);
    assert_eq!(execution.outcome, "succeeded");
    assert_eq!(
        execution.execution_receipt_id,
        response.execution_receipt_id
    );
    assert_eq!(execution.result_hash, result_hash);
    assert!(!observed.lookup_receipt_id.is_empty());
    let mut changed_bytes = workload_body.clone();
    changed_bytes.push(b'\n');
    assert_eq!(
        relay
            .get_execution(workload_lookup(&changed_bytes, "opencode", OPENCODE))
            .await
            .unwrap_err()
            .code(),
        Code::NotFound
    );
    assert_eq!(
        requests.load(std::sync::atomic::Ordering::SeqCst),
        provider_requests
    );

    let fixture_payload = ExecutionPayload {
        operation_id: Uuid::new_v4().to_string(),
        client_service: "fixture-client".into(),
        connector_id: "fixture".into(),
        operation: "read".into(),
        arguments: serde_json::json!({}),
        binding: None,
        delegation_id: None,
    };
    let fixture_body = serde_json::to_vec(&fixture_payload).unwrap();
    let mut fixture_request = platform_client::request(wire::ExecuteRequest {
        subject: Some(sdk::PlatformSubject {
            client_service: "fixture-client".into(),
            identity: Some(sdk::platform_subject::Identity::WorkloadId(
                FIXTURE_FIRST.into(),
            )),
        }),
        body: fixture_body.clone(),
    });
    fixture_request
        .extensions_mut()
        .insert(platform_client::tls::Peer(FIXTURE_FIRST.into()));
    let fixture_output = relay.execute(fixture_request).await.unwrap().into_inner();
    assert_eq!(fixture_output.result, b"second adapter");
    assert_eq!(
        relay
            .get_execution(workload_lookup(
                &fixture_body,
                "fixture-client",
                FIXTURE_FIRST
            ))
            .await
            .unwrap()
            .into_inner()
            .execution
            .unwrap()
            .outcome,
        "succeeded"
    );
    assert_eq!(
        relay
            .get_execution(workload_lookup(
                &fixture_body,
                "fixture-client",
                FIXTURE_SECOND
            ))
            .await
            .unwrap_err()
            .code(),
        Code::NotFound
    );
    assert_eq!(
        requests.load(std::sync::atomic::Ordering::SeqCst),
        provider_requests
    );
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
    let completed_payload = payload.clone();
    let lookup = delegated_lookup(&completed_payload, &created);
    let reused = lookup.get_ref().clone();
    let observed = relay.get_execution(lookup).await.unwrap().into_inner();
    let observed = observed.execution.unwrap();
    assert_eq!(observed.outcome, "succeeded");
    assert_eq!(observed.execution_receipt_id, response.execution_receipt_id);
    let mut replay = platform_client::request(reused);
    replay
        .extensions_mut()
        .insert(platform_client::tls::Peer(policy::BFF_ID.into()));
    assert_eq!(
        relay.get_execution(replay).await.unwrap_err().code(),
        Code::Unauthenticated
    );
    let mut wrong_purpose = delegated_lookup(&completed_payload, &created);
    wrong_purpose.get_mut().subject = delegated_request(&completed_payload, &created.credential)
        .into_inner()
        .subject;
    assert_eq!(
        relay.get_execution(wrong_purpose).await.unwrap_err().code(),
        Code::Unauthenticated
    );
    let before_denials = requests.load(std::sync::atomic::Ordering::SeqCst);
    connection
        .execute(
            "UPDATE ofz.platform_delegations SET expires_at_ms=ofz.now_ms()-1 WHERE id=$1",
            &[&Uuid::parse_str(&created.delegation_id).unwrap()],
        )
        .await
        .unwrap();
    payload.operation_id = Uuid::new_v4().to_string();
    let expired = relay
        .execute(delegated_request(&payload, &created.credential))
        .await
        .unwrap_err();
    assert_eq!(expired.code(), Code::Unauthenticated, "{expired}");
    assert_eq!(
        relay
            .get_execution(delegated_lookup(&completed_payload, &created))
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
    assert_eq!(
        relay
            .get_execution(delegated_lookup(&completed_payload, &created))
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
    enrollment_refresh.abort();
    assert!(enrollment_refresh.await.unwrap_err().is_cancelled());
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
    relay.refresh_enrollment().await;
    assert_eq!(
        relay
            .get_execution(delegated_lookup(&completed_payload, &created))
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
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
    let mut renewal = create.clone();
    renewal.operation_id = Uuid::new_v4().to_string();
    renewal.expires_at_unix_ms = database.state().await.unwrap().now_ms + 60_000;
    let renewed = mutations::execute(&database, &native, policy::BFF_ID, Command::Create(renewal))
        .await
        .unwrap();
    relay.refresh_enrollment().await;
    let inactive = relay
        .get_execution(delegated_lookup(&completed_payload, &renewed))
        .await
        .unwrap_err();
    assert_eq!(inactive.code(), Code::Unauthenticated, "{inactive}");
    mutations::execute(
        &database,
        &native,
        policy::BFF_ID,
        Command::Activate(p::ActivatePlatformDelegationRequest {
            operation_id: Uuid::new_v4().to_string(),
            issuer: Some(session(&humans[0])),
            delegation_id: renewed.delegation_id.clone(),
            proof_key_thumbprint: create.proof_key_thumbprint.clone(),
        }),
    )
    .await
    .unwrap();
    relay.refresh_enrollment().await;
    let recovered = relay
        .get_execution(delegated_lookup(&completed_payload, &renewed))
        .await
        .unwrap()
        .into_inner()
        .execution
        .unwrap();
    assert_eq!(
        recovered.execution_receipt_id,
        observed.execution_receipt_id
    );
    assert_eq!(
        recovered.authorization_receipt_id,
        observed.authorization_receipt_id
    );
    acknowledge_fixture_archive(&admin).await;
    connection
        .execute(
            "UPDATE ofz.sessions SET mfa_at_ms=ofz.now_ms()-600000 WHERE id=$1",
            &[&Uuid::parse_str(&humans[0].1).unwrap()],
        )
        .await
        .unwrap();
    let revoked = mutations::execute(
        &database,
        &native,
        policy::BFF_ID,
        Command::RevokeConnection(p::RevokePlatformConnectionRequest {
            operation_id: Uuid::new_v4().to_string(),
            issuer: create.issuer.clone(),
            client_service: create.client_service.clone(),
            connection_id: create.connection_id.clone(),
        }),
    )
    .await
    .unwrap();
    assert!(revoked.version > renewed.version);
    relay.refresh_enrollment().await;
    connection
        .execute(
            "UPDATE ofz.sessions SET mfa_at_ms=ofz.now_ms() WHERE id=$1",
            &[&Uuid::parse_str(&humans[0].1).unwrap()],
        )
        .await
        .unwrap();
    assert_eq!(
        relay
            .get_execution(delegated_lookup(&completed_payload, &renewed))
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    let stale = mutations::execute(
        &database,
        &native,
        policy::BFF_ID,
        Command::PutConnection(intent.clone()),
    )
    .await
    .unwrap();
    assert_eq!(
        stale.decision.audit_receipt_id,
        saved.decision.audit_receipt_id
    );
    assert!(
        !connection
            .query_one(
                "SELECT enabled FROM ofz.platform_connections WHERE id=$1",
                &[&Uuid::parse_str(&create.connection_id).unwrap()]
            )
            .await
            .unwrap()
            .get::<_, bool>(0)
    );
    let mut forbidden_renewal = create.clone();
    forbidden_renewal.operation_id = Uuid::new_v4().to_string();
    assert_eq!(
        mutations::execute(
            &database,
            &native,
            policy::BFF_ID,
            Command::Create(forbidden_renewal.clone())
        )
        .await
        .unwrap_err()
        .code(),
        Code::FailedPrecondition
    );
    let mut stale_intent = intent.clone();
    stale_intent.operation_id = Uuid::new_v4().to_string();
    stale_intent.expected_version = 1;
    assert_eq!(
        mutations::execute(
            &database,
            &native,
            policy::BFF_ID,
            Command::PutConnection(stale_intent)
        )
        .await
        .unwrap_err()
        .code(),
        Code::Aborted
    );
    let next_epoch = Uuid::new_v4();
    connection
        .execute(
            "UPDATE ofz.workspaces SET runtime_epoch=$2 WHERE uid=$1",
            &[&workspace, &next_epoch],
        )
        .await
        .unwrap();
    let next_binding = p::PlatformBinding {
        service: "tengri".into(),
        id: workspace.to_string(),
        generation: next_epoch.to_string(),
    };
    let lookup_binding = Some(sdk::PlatformBinding {
        service: next_binding.service.clone(),
        id: next_binding.id.clone(),
        generation: next_binding.generation.clone(),
    });
    let mut enabled_intent = intent.clone();
    enabled_intent.operation_id = Uuid::new_v4().to_string();
    enabled_intent.expected_version = 2;
    enabled_intent.binding = Some(next_binding.clone());
    let enabled = mutations::execute(
        &database,
        &native,
        policy::BFF_ID,
        Command::PutConnection(enabled_intent.clone()),
    )
    .await
    .unwrap();
    assert!(enabled.version > revoked.version);
    forbidden_renewal.operation_id = Uuid::new_v4().to_string();
    assert_eq!(
        mutations::execute(
            &database,
            &native,
            policy::BFF_ID,
            Command::Create(forbidden_renewal)
        )
        .await
        .unwrap_err()
        .code(),
        Code::FailedPrecondition
    );
    let mut fresh = create.clone();
    fresh.operation_id = Uuid::new_v4().to_string();
    fresh.expected_connection_version = 3;
    fresh.binding = Some(next_binding.clone());
    fresh.expires_at_unix_ms = database.state().await.unwrap().now_ms + 900_000;
    let mut excessive = fresh.clone();
    excessive.operation_id = Uuid::new_v4().to_string();
    excessive.actions.push("kubernetes.events.read".into());
    let exceeded = mutations::execute(
        &database,
        &native,
        policy::BFF_ID,
        Command::Create(excessive),
    )
    .await
    .unwrap_err();
    assert_eq!(exceeded.code(), Code::PermissionDenied);
    assert!(
        exceeded
            .message()
            .contains("scope differs from saved connection")
    );
    let rebound = mutations::execute(
        &database,
        &native,
        policy::BFF_ID,
        Command::Create(fresh.clone()),
    )
    .await
    .unwrap();
    mutations::execute(
        &database,
        &native,
        policy::BFF_ID,
        Command::Activate(p::ActivatePlatformDelegationRequest {
            operation_id: Uuid::new_v4().to_string(),
            issuer: create.issuer.clone(),
            delegation_id: rebound.delegation_id.clone(),
            proof_key_thumbprint: create.proof_key_thumbprint.clone(),
        }),
    )
    .await
    .unwrap();
    relay.refresh_enrollment().await;
    assert_eq!(
        relay
            .get_execution(delegated_lookup(&completed_payload, &rebound))
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    let after_runtime = relay
        .get_execution(delegated_lookup_binding(
            &completed_payload,
            &rebound,
            lookup_binding.clone(),
        ))
        .await
        .unwrap()
        .into_inner()
        .execution
        .unwrap();
    assert_eq!(
        after_runtime.execution_receipt_id,
        observed.execution_receipt_id
    );
    let other_list = connections::list(
        &database,
        &native,
        policy::BFF_ID,
        p::ListPlatformConnectionsRequest {
            issuer: Some(session(&humans[1])),
            client_service: create.client_service.clone(),
            binding: Some(next_binding.clone()),
        },
    )
    .await
    .unwrap();
    assert!(other_list.connections.is_empty());
    acknowledge_fixture_archive(&admin).await;
    mutations::execute(
        &database,
        &native,
        policy::BFF_ID,
        Command::Relationships(p::WritePolicyRelationshipsRequest {
            operation_id: Uuid::new_v4().to_string(),
            administrator: Some(session(&humans[1])),
            expected_policy_version: database.state().await.unwrap().version,
            relationships: ["status_reader", "log_reader"]
                .into_iter()
                .map(|relation| p::PolicyRelationship {
                    resource: Some(resource(&resource_id)),
                    relation: relation.into(),
                    subject_kind: "human".into(),
                    subject_id: humans[1].0.clone(),
                    enabled: true,
                })
                .collect(),
            reason: "Fixture access for ownership transfer".into(),
        }),
    )
    .await
    .unwrap();
    let version = database.state().await.unwrap().version;
    native
        .apply(
            &Uuid::new_v4().to_string(),
            version,
            &[
                Update::delete(Relationship::new(
                    "workspace",
                    &workspace.to_string(),
                    "owner",
                    "human",
                    &humans[0].0,
                )),
                Update::touch(Relationship::new(
                    "workspace",
                    &workspace.to_string(),
                    "owner",
                    "human",
                    &humans[1].0,
                )),
            ],
        )
        .await
        .unwrap();
    connection
        .execute(
            "UPDATE ofz.workspaces SET owner_id=$2 WHERE uid=$1",
            &[&workspace, &humans[1].0],
        )
        .await
        .unwrap();
    connection
        .execute("UPDATE ofz.platform_state SET version=version+1", &[])
        .await
        .unwrap();
    let mut other_intent = enabled_intent;
    other_intent.operation_id = Uuid::new_v4().to_string();
    other_intent.issuer = Some(session(&humans[1]));
    other_intent.connection_id = Uuid::new_v4().to_string();
    other_intent.expected_version = 0;
    mutations::execute(
        &database,
        &native,
        policy::BFF_ID,
        Command::PutConnection(other_intent.clone()),
    )
    .await
    .unwrap();
    let mut other_credential = fresh;
    other_credential.operation_id = Uuid::new_v4().to_string();
    other_credential.issuer = other_intent.issuer.clone();
    other_credential.connection_id = other_intent.connection_id;
    other_credential.expected_connection_version = 1;
    let other = mutations::execute(
        &database,
        &native,
        policy::BFF_ID,
        Command::Create(other_credential),
    )
    .await
    .unwrap();
    mutations::execute(
        &database,
        &native,
        policy::BFF_ID,
        Command::Activate(p::ActivatePlatformDelegationRequest {
            operation_id: Uuid::new_v4().to_string(),
            issuer: other_intent.issuer,
            delegation_id: other.delegation_id.clone(),
            proof_key_thumbprint: create.proof_key_thumbprint.clone(),
        }),
    )
    .await
    .unwrap();
    relay.refresh_enrollment().await;
    assert_eq!(
        relay
            .get_execution(delegated_lookup_binding(
                &completed_payload,
                &other,
                lookup_binding
            ))
            .await
            .unwrap_err()
            .code(),
        Code::NotFound
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
