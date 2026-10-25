use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use std::env;

use rustls::{ClientConfig, RootCertStore};
use sha2::{Digest, Sha256};
use tokio_postgres::Config;
use tokio_postgres_rustls::MakeRustlsConnect;
use tonic::{Code, Request};
use uuid::Uuid;

use crate::{
    commands::{self, *},
    decision,
    native::{Native, Relationship, Update},
    policy::{self, BFF_ID, CONTROLLER_ID, OFZ_ID},
    proto::{
        actor::Identity, authorization_service_server::AuthorizationService,
        execute_command_request::Command, *,
    },
    service::Service,
    sessions::{self, Issuer},
    store::{self, Database, sql_error},
    transport::Peer,
};

fn rpc_as<T>(message: T, peer: &str) -> Request<T> {
    let mut request = Request::new(message);
    request
        .metadata_mut()
        .insert("x-ofz-contract-version", "1".parse().unwrap());
    request.extensions_mut().insert(Peer(peer.into()));
    request
}

fn rpc<T>(message: T) -> Request<T> {
    rpc_as(message, BFF_ID)
}

async fn workspace_roster(
    service: &Service,
    database: &Database,
    identity: &(String, String),
    uid: &str,
) -> Vec<AccessEntry> {
    let mut context = request(
        database,
        identity,
        Command::ReserveWorkspace(ReserveWorkspace::default()),
    )
    .await
    .context
    .unwrap();
    context.workspace_uid = uid.into();
    service
        .list_access(rpc_as(
            ListAccessRequest {
                context: Some(context),
                resource: Some(policy::workspace(uid)),
                ..Default::default()
            },
            BFF_ID,
        ))
        .await
        .unwrap()
        .into_inner()
        .entries
}

async fn acknowledge_fixture_archive(admin: &Database) {
    // Synthetic acknowledgement for control tests; independent archive durability is a separate gate.
    admin.pool.get().await.unwrap().batch_execute("BEGIN; UPDATE ofz.audit_outbox SET acknowledged_at_ms=ofz.now_ms(),archive_receipt='control-fixture-only'; UPDATE ofz.archive_state SET acknowledged_sequence=coalesce((SELECT max(sequence) FROM ofz.audit),0),acknowledged_at_ms=ofz.now_ms(); COMMIT;").await.unwrap();
}

async fn setup() -> (Database, Database, Native, Vec<(String, String)>) {
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .ok();
    let config: Config = env::var("OFZ_TEST_DSN")
        .expect("run test-control.sh")
        .parse()
        .unwrap();
    assert_eq!(config.get_dbname(), Some("ofz_control"));
    assert!(
        config.get_hosts().iter().all(
            |host| matches!(host,tokio_postgres::config::Host::Tcp(host) if host=="localhost")
        )
    );
    let bytes = tokio::fs::read(env::var("OFZ_TEST_CA_FILE").unwrap())
        .await
        .unwrap();
    let mut roots = RootCertStore::empty();
    for cert in rustls_pemfile::certs(&mut bytes.as_slice()) {
        roots.add(cert.unwrap()).unwrap();
    }
    let tls = MakeRustlsConnect::new(
        ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth(),
    );
    let admin = Database::new(config.clone(), tls.clone()).unwrap();
    let conn = admin.pool.get().await.unwrap();
    conn.batch_execute(
        "CREATE ROLE ofz_api LOGIN PASSWORD 'ofz-test-only'; CREATE ROLE ofz_archiver NOLOGIN;",
    )
    .await
    .unwrap();
    admin.migrate().await.unwrap();
    admin.migrate().await.unwrap();
    let mut api_config = config;
    api_config
        .user("ofz_api")
        .password("ofz-test-only")
        .options(store::CONNECTION_OPTIONS);
    let api = Database::new(api_config, tls).unwrap();
    let native = Native::new(
        &env::var("OFZ_TEST_NATIVE_ENDPOINT").unwrap(),
        env::var("OFZ_TEST_NATIVE_KEY_FILE").unwrap().into(),
    )
    .unwrap();
    let endpoint = env::var("OFZ_TEST_NATIVE_ENDPOINT").unwrap();
    assert!(endpoint.starts_with("http://127.0.0.1:"));
    reqwest::Client::new()
        .post(format!("{endpoint}/v1/schema/write"))
        .bearer_auth("ofz-policy-fixture")
        .json(&serde_json::json!({"schema":crate::SCHEMA}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let now = admin.state().await.unwrap().now_ms;
    let mut identities = vec![];
    let mut relationships = vec![];
    for number in 1..=4 {
        let human = policy::github_human_id(&number.to_string()).unwrap();
        conn.execute(
            "INSERT INTO ofz.humans(id,github_id) VALUES($1,$2)",
            &[&human, &number.to_string()],
        )
        .await
        .unwrap();
        let session = Uuid::new_v4();
        conn.execute(
            "INSERT INTO ofz.memberships(human_id,role) VALUES($1,1)",
            &[&human],
        )
        .await
        .unwrap();
        relationships.push(Update::touch(Relationship::new(
            "platform", "lab", "member", "human", &human,
        )));
        if number <= 2 {
            conn.execute(
                "INSERT INTO ofz.memberships(human_id,role) VALUES($1,2)",
                &[&human],
            )
            .await
            .unwrap();
            relationships.push(Update::touch(Relationship::new(
                "platform",
                "lab",
                "administrator",
                "human",
                &human,
            )));
        }
        let credential = URL_SAFE_NO_PAD.encode(Sha256::digest(session.as_bytes()));
        conn.execute("INSERT INTO ofz.sessions(id,token_hash,human_id,identity_subject,identity_session,operation_id,expires_at_ms,idle_deadline_ms,mfa_at_ms,recovery_generation,github_id,establishment_fingerprint) VALUES($1,$2,$3,$4,$4,$5,$6,$6,$7,1,$8,$2)", &[&session,&Sha256::digest(credential.as_bytes()).to_vec(),&human,&Uuid::new_v4().to_string(),&Uuid::new_v4(),&((now+3_600_000) as i64),&(now as i64),&number.to_string()]).await.unwrap();
        identities.push((human, session.to_string()));
    }
    for (role, id) in [
        ("bff", BFF_ID),
        ("controller", CONTROLLER_ID),
        ("kube_broker", policy::KUBE_BROKER_ID),
        ("connector_broker", policy::CONNECTOR_BROKER_ID),
    ] {
        relationships.push(Update::touch(Relationship::new(
            "platform",
            "lab",
            role,
            "workload",
            &policy::workload_object_id(id),
        )));
    }
    let bootstrap = Uuid::new_v4().to_string();
    let bootstrap_started = tokio::time::Instant::now();
    loop {
        let outcome = match native.applied(&bootstrap).await {
            Ok((true, _)) => break,
            Ok((false, _)) => native
                .apply(&bootstrap, 0, &relationships)
                .await
                .map(|_| ()),
            Err(error) => Err(error),
        };
        match outcome {
            Ok(()) => break,
            Err(error)
                if error.code() == Code::Unavailable
                    && bootstrap_started.elapsed() < std::time::Duration::from_secs(30) =>
            {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            Err(error) => panic!("fixture bootstrap failed: {error}"),
        }
    }
    conn.execute("UPDATE ofz.platform_state SET version=1,fenced=false", &[])
        .await
        .unwrap();
    conn.execute(
        "UPDATE ofz.archive_state SET acknowledged_at_ms=ofz.now_ms()",
        &[],
    )
    .await
    .unwrap();
    drop(conn);
    api.verify_schema().await.unwrap();
    (admin, api, native, identities)
}

async fn request(
    database: &Database,
    identity: &(String, String),
    command: Command,
) -> ExecuteCommandRequest {
    let state = database.state().await.unwrap();
    let workspace_uid = match &command {
        Command::SetWorkspaceRole(c) => c.workspace_uid.clone(),
        Command::TransferWorkspace(c) => c.workspace_uid.clone(),
        Command::CreateGrant(c) => c.workspace_uid.clone(),
        Command::RemoveWorkspace(c) => c.workspace_uid.clone(),
        Command::SetWorkspaceRuntime(c) => c.workspace_uid.clone(),
        Command::RevokeGrant(c) => {
            decision::grant(database, &c.grant_id)
                .await
                .unwrap()
                .workspace_uid
        }
        _ => String::new(),
    };
    ExecuteCommandRequest {
        context: Some(RequestContext {
            actor: Some(Actor {
                identity: Some(Identity::HumanId(identity.0.clone())),
            }),
            session_id: identity.1.clone(),
            grant_id: String::new(),
            trace_id: Uuid::new_v4().to_string(),
            deadline_unix_ms: state.now_ms + 10_000,
            contract_version: crate::CONTRACT_VERSION,
            workspace_uid,
            origin: "https://proompteng.ai".into(),
            ..Default::default()
        }),
        operation_id: Uuid::new_v4().to_string(),
        expected_version: state.version,
        reason: "integration qualification".into(),
        client_request_hash: vec![],
        command: Some(command),
    }
}

async fn verify_runtime_reads(
    service: &Service,
    database: &Database,
    owner: &(String, String),
    next_owner: &(String, String),
    uid: &str,
    home: &str,
    reservation_id: &str,
) {
    let projection = runtime_state(service, database, owner, uid).await;
    assert_eq!(projection.home_uid, home);
    assert_eq!(projection.reservation_id, reservation_id);
    assert_eq!(projection.owner_id, owner.0);
    assert!(!projection.running && !projection.runtime_allowed);
    assert_eq!(projection.state, "active");
    let reservation_context = request(
        database,
        owner,
        Command::ReserveWorkspace(ReserveWorkspace::default()),
    )
    .await
    .context;
    let reservation_read = GetWorkspaceReservationRequest {
        context: reservation_context.clone(),
        reservation_id: reservation_id.into(),
        recovery_generation: projection.recovery_generation,
    };
    assert_eq!(
        service
            .get_workspace_reservation(rpc_as(reservation_read.clone(), BFF_ID))
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    let reservation = service
        .get_workspace_reservation(rpc_as(reservation_read.clone(), CONTROLLER_ID))
        .await
        .unwrap()
        .into_inner();
    assert_eq!(reservation.workspace_uid, uid);
    assert_eq!(reservation.state, "enrolled");
    let mut wrong_owner = reservation_read.clone();
    wrong_owner.context = request(
        database,
        next_owner,
        Command::ReserveWorkspace(ReserveWorkspace::default()),
    )
    .await
    .context;
    assert_eq!(
        service
            .get_workspace_reservation(rpc_as(wrong_owner, CONTROLLER_ID))
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    let mut old_generation = reservation_read;
    old_generation.recovery_generation += 1;
    assert_eq!(
        service
            .get_workspace_reservation(rpc_as(old_generation, CONTROLLER_ID))
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    let mut workload_context = controller_request(
        database,
        owner,
        Command::ReserveWorkspace(ReserveWorkspace::default()),
    )
    .await
    .context
    .unwrap();
    workload_context.workspace_uid = uid.to_string();
    let runtime_read = GetWorkspaceStateRequest {
        stream_receipt_id: String::new(),
        context: Some(workload_context.clone()),
        workspace_uid: uid.to_string(),
    };
    assert_eq!(
        service
            .get_workspace_state(rpc_as(runtime_read.clone(), BFF_ID))
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    let mut wrong_workspace = runtime_read;
    wrong_workspace.workspace_uid = Uuid::new_v4().to_string();
    assert_eq!(
        service
            .get_workspace_state(rpc_as(wrong_workspace, CONTROLLER_ID))
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
}

async fn verify_runtime_removal(
    service: &Service,
    admin: &Database,
    database: &Database,
    native: &Native,
    owner: &(String, String),
    next_owner: &(String, String),
    binding: (&str, &str, &str, &str),
) {
    let (uid, runtime_epoch, home, reservation_id) = binding;
    // Removal keeps retained-home quota until the exact controller completion receipt.
    acknowledge_fixture_archive(admin).await;
    let transferred = runtime_state(service, database, owner, uid).await;
    assert_eq!(transferred.owner_id, next_owner.0);
    assert_eq!(transferred.state, "quarantined");
    assert!(!transferred.runtime_allowed);
    let stop = controller_request(
        database,
        owner,
        Command::SetWorkspaceRuntime(SetWorkspaceRuntime {
            workspace_uid: uid.into(),
            runtime_epoch: runtime_epoch.into(),
            running: false,
        }),
    )
    .await;
    commands::execute(database, native, CONTROLLER_ID, stop)
        .await
        .unwrap();
    let removal = execute(
        database,
        native,
        next_owner,
        Command::RemoveWorkspace(RemoveWorkspace {
            workspace_uid: uid.into(),
        }),
    )
    .await;
    let mut removal_status = GetCommandRequest {
        context: request(
            database,
            next_owner,
            Command::RemoveWorkspace(RemoveWorkspace {
                workspace_uid: uid.into(),
            }),
        )
        .await
        .context,
        operation_id: removal.operation_id,
        ..Default::default()
    };
    assert!(
        !commands::get(database, native, BFF_ID, removal_status.clone())
            .await
            .unwrap()
            .workspace_removed
    );
    let mut other_actor = removal_status.clone();
    other_actor.context = request(
        database,
        owner,
        Command::RemoveWorkspace(RemoveWorkspace {
            workspace_uid: uid.into(),
        }),
    )
    .await
    .context;
    assert_eq!(
        commands::get(database, native, BFF_ID, other_actor)
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    let removing = runtime_state(service, database, owner, uid).await;
    assert_eq!(removing.state, "removing");
    assert!(!removing.running && !removing.runtime_allowed);
    assert_creation_reservation_retired(service, database, owner, reservation_id).await;
    assert_eq!(
        admin
            .pool
            .get()
            .await
            .unwrap()
            .query_one(
                "SELECT state FROM ofz.reservations WHERE id=$1",
                &[&Uuid::parse_str(reservation_id).unwrap()]
            )
            .await
            .unwrap()
            .get::<_, String>(0),
        "enrolled"
    );
    let complete = CompleteWorkspaceRemoval {
        workspace_uid: uid.into(),
        home_uid: home.into(),
        reservation_id: reservation_id.into(),
    };
    let mut wrong_home = complete.clone();
    wrong_home.home_uid = Uuid::new_v4().to_string();
    let wrong_home = controller_request(
        database,
        owner,
        Command::CompleteWorkspaceRemoval(wrong_home),
    )
    .await;
    assert_eq!(
        commands::execute(database, native, CONTROLLER_ID, wrong_home)
            .await
            .unwrap_err()
            .code(),
        Code::FailedPrecondition
    );
    let human_completion = request(
        database,
        next_owner,
        Command::CompleteWorkspaceRemoval(complete.clone()),
    )
    .await;
    assert_eq!(
        commands::execute(database, native, BFF_ID, human_completion)
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    let complete =
        controller_request(database, owner, Command::CompleteWorkspaceRemoval(complete)).await;
    let completion = commands::execute(database, native, CONTROLLER_ID, complete.clone())
        .await
        .unwrap();
    assert_eq!(
        commands::execute(database, native, CONTROLLER_ID, complete)
            .await
            .unwrap(),
        completion
    );
    assert_eq!(
        runtime_state(service, database, owner, uid).await.state,
        "removed"
    );
    removal_status.context.as_mut().unwrap().deadline_unix_ms =
        database.state().await.unwrap().now_ms + 2000;
    assert!(
        commands::get(database, native, BFF_ID, removal_status)
            .await
            .unwrap()
            .workspace_removed
    );
    assert_eq!(
        admin
            .pool
            .get()
            .await
            .unwrap()
            .query_one(
                "SELECT state FROM ofz.reservations WHERE id=$1",
                &[&Uuid::parse_str(reservation_id).unwrap()]
            )
            .await
            .unwrap()
            .get::<_, String>(0),
        "released"
    );
    assert_creation_reservation_retired(service, database, owner, reservation_id).await;
}

async fn assert_creation_reservation_retired(
    service: &Service,
    database: &Database,
    owner: &(String, String),
    reservation_id: &str,
) {
    let context = request(
        database,
        owner,
        Command::ReserveWorkspace(ReserveWorkspace::default()),
    )
    .await
    .context;
    let error = service
        .get_workspace_reservation(rpc_as(
            GetWorkspaceReservationRequest {
                context,
                reservation_id: reservation_id.into(),
                recovery_generation: 1,
            },
            CONTROLLER_ID,
        ))
        .await
        .expect_err("removed creation must not recover a usable reservation");
    assert_eq!(error.code(), Code::FailedPrecondition);
    assert_eq!(error.message(), "workspace reservation released");
}

async fn controller_request(
    database: &Database,
    identity: &(String, String),
    command: Command,
) -> ExecuteCommandRequest {
    let mut message = request(database, identity, command).await;
    let context = message.context.as_mut().unwrap();
    context.actor = Some(decision::workload_actor(CONTROLLER_ID));
    context.session_id.clear();
    message
}

async fn runtime_state(
    service: &Service,
    database: &Database,
    identity: &(String, String),
    uid: &str,
) -> GetWorkspaceStateResponse {
    let mut context = controller_request(
        database,
        identity,
        Command::ReserveWorkspace(ReserveWorkspace::default()),
    )
    .await
    .context
    .unwrap();
    context.workspace_uid = uid.into();
    service
        .get_workspace_state(rpc_as(
            GetWorkspaceStateRequest {
                stream_receipt_id: String::new(),
                context: Some(context),
                workspace_uid: uid.into(),
            },
            CONTROLLER_ID,
        ))
        .await
        .unwrap()
        .into_inner()
}

async fn execute(
    database: &Database,
    native: &Native,
    identity: &(String, String),
    command: Command,
) -> CommandReceipt {
    let request = request(database, identity, command).await;
    commands::execute(database, native, BFF_ID, request)
        .await
        .unwrap()
}

async fn read(
    database: &Database,
    native: &Native,
    identity: &(String, String),
    uid: &str,
    action: Action,
) -> Result<CheckResponse, tonic::Status> {
    let mut request = request(
        database,
        identity,
        Command::ReserveWorkspace(ReserveWorkspace::default()),
    )
    .await;
    request.context.as_mut().unwrap().workspace_uid = uid.into();
    if matches!(action, Action::FilesObserve | Action::FilesWrite) {
        let row = database
            .pool
            .get()
            .await
            .unwrap()
            .query_one(
                "SELECT runtime_epoch FROM ofz.workspaces WHERE uid=$1",
                &[&Uuid::parse_str(uid).unwrap()],
            )
            .await
            .unwrap();
        request.context.as_mut().unwrap().runtime_epoch = row
            .get::<_, Option<Uuid>>(0)
            .map(|epoch| epoch.to_string())
            .unwrap_or_default();
    }
    decision::check(
        database,
        native,
        BFF_ID,
        CheckRequest {
            context: request.context,
            action: action as i32,
            resource: Some(policy::workspace(uid)),
            target: String::new(),
            stream_receipt_id: String::new(),
        },
    )
    .await
}

struct ControlFixture {
    admin: Database,
    database: Database,
    native: Native,
    identities: Vec<(String, String)>,
    service: Service,
}

struct WorkspaceFixture {
    uid: String,
    home: String,
    reservation_id: String,
}

#[tokio::test]
#[ignore = "requires the disposable TLS PostgreSQL and SpiceDB from test-control.sh"]
async fn control_integration_durability_authority_and_quota() {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::WARN)
        .with_test_writer()
        .try_init()
        .ok();
    let (admin, database, native, identities) = setup().await;
    let service = Service::new(
        database.clone(),
        native.clone(),
        Issuer::new(
            "https://identity.invalid/realms/tengri".into(),
            "tengri-bff".into(),
        )
        .unwrap(),
    );
    let fixture = ControlFixture {
        admin,
        database,
        native,
        identities,
        service,
    };
    Box::pin(verify_maintenance_state_during_audit(&fixture)).await;
    Box::pin(verify_session_bootstrap(&fixture)).await;
    let workspace = Box::pin(verify_workspace_enrollment(&fixture)).await;
    if policy::connectors_enabled() {
        Box::pin(verify_connector_grants(&fixture, &workspace)).await;
    } else {
        Box::pin(verify_dormant_connector_grants(&fixture)).await;
    }
    verify_audit_write_pressure(
        &fixture.admin,
        &fixture.database,
        &fixture.identities[0],
        &workspace.uid,
    )
    .await;
    Box::pin(verify_authorization_after_audit(&fixture, &workspace)).await;
    Box::pin(verify_runtime_reads(
        &fixture.service,
        &fixture.database,
        &fixture.identities[0],
        &fixture.identities[1],
        &workspace.uid,
        &workspace.home,
        &workspace.reservation_id,
    ))
    .await;
    acknowledge_fixture_archive(&fixture.admin).await;
    Box::pin(verify_access_rosters(&fixture, &workspace)).await;
    acknowledge_fixture_archive(&fixture.admin).await;
    Box::pin(verify_concurrent_quota(&fixture)).await;
    Box::pin(verify_abandoned_reservation_expiry(&fixture, &workspace)).await;
    Box::pin(verify_emergency_crash_recovery(&fixture, &workspace)).await;
    let grant_id = Box::pin(verify_delegation_and_journal_integrity(
        &fixture, &workspace,
    ))
    .await;
    Box::pin(verify_archive_fencing(&fixture, &workspace, grant_id)).await;
    // Renew the synthetic administrators before the independent runtime/ownership phase.
    let administrator_sessions: Vec<Uuid> = fixture.identities[..2]
        .iter()
        .map(|(_, session)| Uuid::parse_str(session).unwrap())
        .collect();
    assert_eq!(
        fixture
            .admin
            .pool
            .get()
            .await
            .unwrap()
            .execute(
                "UPDATE ofz.sessions SET mfa_at_ms=ofz.now_ms() WHERE id=ANY($1) AND NOT revoked",
                &[&administrator_sessions],
            )
            .await
            .unwrap(),
        2
    );
    let runtime_epoch = Box::pin(verify_runtime_transfer(&fixture, &workspace)).await;
    Box::pin(verify_offboarding(&fixture, &workspace)).await;
    Box::pin(verify_runtime_removal(
        &fixture.service,
        &fixture.admin,
        &fixture.database,
        &fixture.native,
        &fixture.identities[0],
        &fixture.identities[1],
        (
            &workspace.uid,
            &runtime_epoch,
            &workspace.home,
            &workspace.reservation_id,
        ),
    ))
    .await;
    Box::pin(verify_offboarding_preserves_removal(&fixture)).await;
    Box::pin(verify_offboarding_during_enrollment(&fixture)).await;
    Box::pin(verify_journal_loss(&fixture, &workspace)).await;
}

async fn verify_authorization_after_audit(fixture: &ControlFixture, workspace: &WorkspaceFixture) {
    enum Read {
        Decision,
        Runtime,
    }
    let client = fixture.admin.pool.get().await.unwrap();
    let api = fixture.database.pool.get().await.unwrap();
    assert_eq!(
        api.query_one("SHOW statement_timeout", &[])
            .await
            .unwrap()
            .get::<_, String>(0),
        "2s"
    );
    drop(api);
    client.batch_execute("CREATE FUNCTION ofz.fixture_delay_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(3); RETURN NEW; END $$;").await.unwrap();
    for read in [Read::Decision, Read::Runtime] {
        for request_budget in [5000, 2000] {
            acknowledge_fixture_archive(&fixture.admin).await;
            let mut context = match read {
                Read::Decision => {
                    request(
                        &fixture.database,
                        &fixture.identities[0],
                        Command::ReserveWorkspace(ReserveWorkspace::default()),
                    )
                    .await
                }
                Read::Runtime => {
                    controller_request(
                        &fixture.database,
                        &fixture.identities[0],
                        Command::ReserveWorkspace(ReserveWorkspace::default()),
                    )
                    .await
                }
            }
            .context
            .unwrap();
            context.workspace_uid = workspace.uid.clone();
            context.deadline_unix_ms =
                fixture.database.state().await.unwrap().now_ms + request_budget;
            let deadline = context.deadline_unix_ms;
            let trace = context.trace_id.clone();
            let mut renewal_context = context.clone();
            client.batch_execute(&format!(
                "CREATE TRIGGER fixture_delay_audit AFTER INSERT ON ofz.audit FOR EACH ROW WHEN (NEW.receipt->>'trace_id'='{trace}') EXECUTE FUNCTION ofz.fixture_delay_audit();"
            )).await.unwrap();
            let outcome = match read {
                Read::Decision => fixture
                    .service
                    .check(rpc(CheckRequest {
                        context: Some(context),
                        resource: Some(policy::workspace(&workspace.uid)),
                        action: Action::WorkspaceMetadataRead as i32,
                        ..Default::default()
                    }))
                    .await
                    .map(|response| {
                        let response = response.into_inner();
                        (
                            response.allowed,
                            response.valid_until_unix_ms,
                            response.audit_receipt_id,
                            Some(response.revision),
                        )
                    }),
                Read::Runtime => fixture
                    .service
                    .get_workspace_state(rpc_as(
                        GetWorkspaceStateRequest {
                            stream_receipt_id: String::new(),
                            context: Some(context),
                            workspace_uid: workspace.uid.clone(),
                        },
                        CONTROLLER_ID,
                    ))
                    .await
                    .map(|response| {
                        let response = response.into_inner();
                        (
                            response.owner_id == fixture.identities[0].0,
                            response.valid_until_unix_ms,
                            response.audit_receipt_id,
                            None,
                        )
                    }),
            };
            let finished = fixture.database.state().await.unwrap();
            client
                .batch_execute("DROP TRIGGER fixture_delay_audit ON ofz.audit;")
                .await
                .unwrap();
            if request_budget == 2000 {
                assert!(
                    outcome.is_err(),
                    "audit must not extend the caller's deadline"
                );
            } else {
                let (allowed, valid_until, receipt, revision) = outcome.unwrap();
                assert!(allowed && !receipt.is_empty());
                if let Some(revision) = revision {
                    let audit: AuditReceipt = store::decode(
                        client
                            .query_one(
                                "SELECT receipt FROM ofz.audit WHERE id=$1",
                                &[&Uuid::parse_str(&receipt).unwrap()],
                            )
                            .await
                            .unwrap()
                            .get(0),
                    )
                    .unwrap();
                    assert_eq!(
                        revision, audit.revision,
                        "an allowed response must identify its durable audited revision"
                    );
                    renewal_context.deadline_unix_ms =
                        fixture.database.state().await.unwrap().now_ms + 2000;
                    let renewed = fixture
                        .service
                        .check(rpc(CheckRequest {
                            context: Some(renewal_context),
                            resource: Some(policy::workspace(&workspace.uid)),
                            action: Action::WorkspaceMetadataRead as i32,
                            stream_receipt_id: receipt.clone(),
                            ..Default::default()
                        }))
                        .await
                        .unwrap()
                        .into_inner();
                    assert!(renewed.allowed);
                    assert_eq!(renewed.audit_receipt_id, receipt);
                    assert_eq!(renewed.revision, audit.revision);
                }
                assert!(
                    valid_until > finished.now_ms && valid_until <= finished.now_ms + 2000,
                    "audit consumed the authorization window: {valid_until} <= {}",
                    finished.now_ms
                );
                assert!(valid_until <= deadline);
            }
        }
    }
    client
        .batch_execute("DROP FUNCTION ofz.fixture_delay_audit();")
        .await
        .unwrap();
    let mut context = request(
        &fixture.database,
        &fixture.identities[0],
        Command::ReserveWorkspace(ReserveWorkspace::default()),
    )
    .await
    .context
    .unwrap();
    context.workspace_uid = workspace.uid.clone();
    let resource = policy::workspace(&workspace.uid);
    let legacy = store::receipt(
        &context,
        BFF_ID,
        resource.clone(),
        Action::WorkspaceMetadataRead,
        true,
        "",
        "legacy revision fixture",
    );
    assert!(legacy.revision.is_empty());
    let legacy = fixture.database.audit(&legacy, "").await.unwrap();
    assert_eq!(
        fixture
            .service
            .check(rpc(CheckRequest {
                context: Some(context),
                resource: Some(resource),
                action: Action::WorkspaceMetadataRead as i32,
                stream_receipt_id: legacy,
                ..Default::default()
            }))
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    let api = fixture.database.pool.get().await.unwrap();
    assert_eq!(
        api.query_one("SHOW statement_timeout", &[])
            .await
            .unwrap()
            .get::<_, String>(0),
        "2s"
    );
    acknowledge_fixture_archive(&fixture.admin).await;
}

async fn verify_maintenance_state_during_audit(fixture: &ControlFixture) {
    let uid = Uuid::new_v4();
    let reservation = Uuid::new_v4();
    let home = Uuid::new_v4();
    let epoch = Uuid::new_v4();
    let client = fixture.admin.pool.get().await.unwrap();
    client.execute(
        "INSERT INTO ofz.reservations(id,owner_id,home_bytes,workspace_uid,state) VALUES($1,$2,34359738368,$3,'enrolled')",
        &[&reservation, &fixture.identities[0].0, &uid],
    ).await.unwrap();
    client.execute(
        "INSERT INTO ofz.workspaces(uid,owner_id,home_uid,reservation_id,home_bytes,running,runtime_epoch) VALUES($1,$2,$3,$4,34359738368,true,$5)",
        &[&uid,&fixture.identities[0].0,&home,&reservation,&epoch],
    ).await.unwrap();
    for (before, during) in [
        (
            "UPDATE ofz.archive_state SET acknowledged_at_ms=ofz.now_ms()-61000",
            "UPDATE ofz.archive_state SET acknowledged_at_ms=ofz.now_ms()",
        ),
        (
            "UPDATE ofz.archive_state SET acknowledged_at_ms=ofz.now_ms()",
            "UPDATE ofz.archive_state SET acknowledged_at_ms=ofz.now_ms()-61000",
        ),
        (
            "UPDATE ofz.platform_state SET fenced=true",
            "UPDATE ofz.platform_state SET fenced=false",
        ),
        (
            "UPDATE ofz.platform_state SET fenced=false",
            "UPDATE ofz.platform_state SET fenced=true",
        ),
    ] {
        acknowledge_fixture_archive(&fixture.admin).await;
        client.batch_execute(before).await.unwrap();
        let mut audit_connection = fixture.admin.pool.get().await.unwrap();
        let audit_lock = audit_connection.transaction().await.unwrap();
        audit_lock
            .batch_execute("LOCK TABLE ofz.audit IN SHARE MODE")
            .await
            .unwrap();
        let mut context = controller_request(
            &fixture.database,
            &fixture.identities[0],
            Command::ReserveWorkspace(ReserveWorkspace::default()),
        )
        .await
        .context
        .unwrap();
        context.workspace_uid = uid.to_string();
        context.runtime_epoch = epoch.to_string();
        let trace = context.trace_id.clone();
        let service = fixture.service.clone();
        let request = AuthorizeGuestMaintenanceRequest {
            stream_receipt_id: String::new(),
            context: Some(context),
            workspace_uid: uid.to_string(),
            purpose: GuestMaintenancePurpose::Probe as i32,
            terminal_id: String::new(),
        };
        let in_flight = tokio::spawn(async move {
            service
                .authorize_guest_maintenance(rpc_as(request, CONTROLLER_ID))
                .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                let blocked: bool = audit_lock.query_one(
                    "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE relation='ofz.audit'::regclass AND mode='RowExclusiveLock' AND NOT granted)", &[],
                ).await.unwrap().get(0);
                if blocked { break; }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }).await.expect("maintenance must reach its audit write before authority changes");
        client.batch_execute(during).await.unwrap();
        audit_lock.commit().await.unwrap();
        let outcome = in_flight.await.unwrap();
        assert_eq!(
            outcome.unwrap_err().code(),
            Code::Aborted,
            "maintenance cannot return a decision from a different archive or fence state than its receipt"
        );
        let receipt: AuditReceipt = store::decode(client.query_one(
            "SELECT receipt FROM ofz.audit WHERE receipt->>'trace_id'=$1 ORDER BY sequence DESC LIMIT 1", &[&trace],
        ).await.unwrap().get(0)).unwrap();
        assert!(
            !receipt.allowed,
            "an aborted disclosure requires a terminal denial receipt"
        );
        client
            .batch_execute("UPDATE ofz.platform_state SET fenced=false")
            .await
            .unwrap();
    }
    client.batch_execute("CREATE FUNCTION ofz.fixture_delay_workload_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(3); RETURN NEW; END $$;").await.unwrap();
    enum NativeChange {
        RuntimeRevocation,
        MaintenanceRevocation,
        UnrelatedWrite,
    }
    for change in [
        NativeChange::RuntimeRevocation,
        NativeChange::MaintenanceRevocation,
        NativeChange::UnrelatedWrite,
    ] {
        let maintenance = !matches!(change, NativeChange::RuntimeRevocation);
        let revoke = !matches!(change, NativeChange::UnrelatedWrite);
        acknowledge_fixture_archive(&fixture.admin).await;
        let mut context = controller_request(
            &fixture.database,
            &fixture.identities[0],
            Command::ReserveWorkspace(ReserveWorkspace::default()),
        )
        .await
        .context
        .unwrap();
        context.workspace_uid = uid.to_string();
        context.runtime_epoch = epoch.to_string();
        context.deadline_unix_ms = fixture.database.state().await.unwrap().now_ms + 5000;
        let trace = context.trace_id.clone();
        client.batch_execute(&format!(
            "CREATE TRIGGER fixture_delay_workload_audit AFTER INSERT ON ofz.audit FOR EACH ROW WHEN (NEW.receipt->>'trace_id'='{trace}') EXECUTE FUNCTION ofz.fixture_delay_workload_audit();"
        )).await.unwrap();
        let service = fixture.service.clone();
        let workspace_uid = uid.to_string();
        let in_flight = tokio::spawn(async move {
            if maintenance {
                service
                    .authorize_guest_maintenance(rpc_as(
                        AuthorizeGuestMaintenanceRequest {
                            stream_receipt_id: String::new(),
                            context: Some(context),
                            workspace_uid,
                            purpose: GuestMaintenancePurpose::Probe as i32,
                            terminal_id: String::new(),
                        },
                        CONTROLLER_ID,
                    ))
                    .await
                    .and_then(|response| {
                        response
                            .into_inner()
                            .decision
                            .ok_or_else(|| tonic::Status::internal("maintenance decision missing"))
                    })
                    .map(Some)
            } else {
                service
                    .get_workspace_state(rpc_as(
                        GetWorkspaceStateRequest {
                            stream_receipt_id: String::new(),
                            context: Some(context),
                            workspace_uid,
                        },
                        CONTROLLER_ID,
                    ))
                    .await
                    .map(|_| None)
            }
        });
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                let writing: bool = client.query_one(
                    "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='ofz_api' AND wait_event='PgSleep' AND query LIKE 'INSERT INTO ofz.audit%')", &[],
                ).await.unwrap().get(0);
                if writing { break; }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }).await.expect("runtime read must be committing its audit before workload revocation");
        let relationship = if revoke {
            Relationship::new(
                "platform",
                "lab",
                "controller",
                "workload",
                &policy::workload_object_id(CONTROLLER_ID),
            )
        } else {
            Relationship::new(
                "platform",
                "lab",
                "auditor",
                "human",
                &fixture.identities[2].0,
            )
        };
        fixture
            .native
            .write_fixture_relationships(&[if revoke {
                Update::delete(relationship.clone())
            } else {
                Update::touch(relationship.clone())
            }])
            .await
            .unwrap();
        let outcome = in_flight.await.unwrap();
        fixture
            .native
            .write_fixture_relationships(&[if revoke {
                Update::touch(relationship)
            } else {
                Update::delete(relationship)
            }])
            .await
            .unwrap();
        client
            .batch_execute("DROP TRIGGER fixture_delay_workload_audit ON ofz.audit;")
            .await
            .unwrap();
        let receipt: AuditReceipt = store::decode(client.query_one(
            "SELECT receipt FROM ofz.audit WHERE receipt->>'trace_id'=$1 ORDER BY sequence DESC LIMIT 1", &[&trace],
        ).await.unwrap().get(0)).unwrap();
        if revoke {
            assert_eq!(outcome.unwrap_err().code(), Code::PermissionDenied);
            assert!(
                !receipt.allowed,
                "revoked workload requires a terminal denial receipt"
            );
        } else {
            let decision = outcome.unwrap().unwrap();
            assert!(decision.allowed && receipt.allowed);
            assert_eq!(decision.audit_receipt_id, receipt.id);
            assert_eq!(
                decision.revision, receipt.revision,
                "unrelated native writes must not break audit correlation"
            );
        }
    }
    client
        .batch_execute("DROP FUNCTION ofz.fixture_delay_workload_audit();")
        .await
        .unwrap();
    client
        .execute("DELETE FROM ofz.workspaces WHERE uid=$1", &[&uid])
        .await
        .unwrap();
    client
        .execute("DELETE FROM ofz.reservations WHERE id=$1", &[&reservation])
        .await
        .unwrap();
    acknowledge_fixture_archive(&fixture.admin).await;
}

async fn verify_offboarding_preserves_removal(fixture: &ControlFixture) {
    let ControlFixture {
        admin,
        database,
        native,
        identities,
        service,
    } = fixture;
    acknowledge_fixture_archive(admin).await;
    let humans: Vec<String> = ["7", "8", "9"]
        .iter()
        .map(|number| policy::github_human_id(number).unwrap())
        .collect();
    for (human, github_id) in humans.iter().zip(["7", "8", "9"]) {
        execute(
            database,
            native,
            &identities[0],
            Command::SetMembership(SetMembership {
                human_id: human.clone(),
                github_id: github_id.into(),
                role: PlatformRole::Member as i32,
                enabled: true,
            }),
        )
        .await;
    }
    let session = Uuid::new_v4();
    let now = admin.state().await.unwrap().now_ms as i64;
    let credential = URL_SAFE_NO_PAD.encode(Sha256::digest(session.as_bytes()));
    admin.pool.get().await.unwrap().execute(
        "INSERT INTO ofz.sessions(id,token_hash,human_id,identity_subject,identity_session,operation_id,expires_at_ms,idle_deadline_ms,mfa_at_ms,recovery_generation,github_id,establishment_fingerprint) VALUES($1,$2,$3,$4,$4,$5,$6,$6,$7,1,'7',$2)",
        &[&session,&Sha256::digest(credential.as_bytes()).to_vec(),&humans[0],&Uuid::new_v4().to_string(),&Uuid::new_v4(),&(now+3_600_000),&now],
    ).await.unwrap();
    let owner = (humans[0].clone(), session.to_string());
    let reservation_id = Uuid::new_v4().to_string();
    let workspace_uid = Uuid::new_v4().to_string();
    let home_uid = Uuid::new_v4().to_string();
    execute(
        database,
        native,
        &owner,
        Command::ReserveWorkspace(ReserveWorkspace {
            reservation_id: reservation_id.clone(),
            home_bytes: HOME_BYTES,
        }),
    )
    .await;
    for command in [
        Command::BeginWorkspaceEnrollment(BeginWorkspaceEnrollment {
            reservation_id: reservation_id.clone(),
            workspace_uid: workspace_uid.clone(),
            owner_id: owner.0.clone(),
        }),
        Command::EnrollWorkspace(EnrollWorkspace {
            reservation_id: reservation_id.clone(),
            workspace_uid: workspace_uid.clone(),
            home_uid: home_uid.clone(),
            owner_id: owner.0.clone(),
            home_bytes: HOME_BYTES,
        }),
    ] {
        let request = controller_request(database, &owner, command).await;
        commands::execute(database, native, CONTROLLER_ID, request)
            .await
            .unwrap();
    }
    execute(
        database,
        native,
        &owner,
        Command::SetWorkspaceRole(SetWorkspaceRole {
            workspace_uid: workspace_uid.clone(),
            human_id: humans[1].clone(),
            role: WorkspaceRole::Developer as i32,
            enabled: true,
            scope: None,
        }),
    )
    .await;
    let mut emergency = EmergencyAccess {
        workspace_uid: workspace_uid.clone(),
        human_id: humans[2].clone(),
        incident_id: "INC-REMOVAL-OFFBOARDING".into(),
        custodian_approval_id: String::new(),
        expires_at_unix_ms: database.state().await.unwrap().now_ms + 600_000,
    };
    emergency.custodian_approval_id = execute(
        database,
        native,
        &identities[0],
        Command::EmergencyAccess(emergency.clone()),
    )
    .await
    .operation_id;
    execute(
        database,
        native,
        &identities[1],
        Command::EmergencyAccess(emergency),
    )
    .await;
    execute(
        database,
        native,
        &owner,
        Command::RemoveWorkspace(RemoveWorkspace {
            workspace_uid: workspace_uid.clone(),
        }),
    )
    .await;
    for (human, github_id) in [&humans[1], &humans[2], &humans[0]]
        .into_iter()
        .zip(["8", "9", "7"])
    {
        execute(
            database,
            native,
            &identities[0],
            Command::SetMembership(SetMembership {
                human_id: human.clone(),
                github_id: github_id.into(),
                role: PlatformRole::Member as i32,
                enabled: false,
            }),
        )
        .await;
        let projection = runtime_state(service, database, &owner, &workspace_uid).await;
        assert_eq!(
            projection.state, "removing",
            "offboarding {github_id} must preserve approved removal"
        );
        assert!(!projection.running && !projection.runtime_allowed);
        let usage = admin
            .pool
            .get()
            .await
            .unwrap()
            .query_one(
                "SELECT used_workspaces,used_bytes FROM ofz.quota_usage WHERE owner_id=$1",
                &[&owner.0],
            )
            .await
            .unwrap();
        assert_eq!(usage.get::<_, i64>(0), 1);
        assert_eq!(usage.get::<_, i64>(1), HOME_BYTES as i64);
    }
    let complete = controller_request(
        database,
        &owner,
        Command::CompleteWorkspaceRemoval(CompleteWorkspaceRemoval {
            workspace_uid: workspace_uid.clone(),
            home_uid,
            reservation_id: reservation_id.clone(),
        }),
    )
    .await;
    let receipt = commands::execute(database, native, CONTROLLER_ID, complete.clone())
        .await
        .unwrap();
    assert_eq!(
        commands::execute(database, native, CONTROLLER_ID, complete)
            .await
            .unwrap(),
        receipt
    );
    assert_eq!(
        runtime_state(service, database, &owner, &workspace_uid)
            .await
            .state,
        "removed"
    );
    let released = admin.pool.get().await.unwrap().query_one(
        "SELECT r.state,COALESCE(q.used_workspaces,0),COALESCE(q.used_bytes,0) FROM ofz.reservations r LEFT JOIN ofz.quota_usage q ON q.owner_id=r.owner_id WHERE r.id=$1",
        &[&Uuid::parse_str(&reservation_id).unwrap()],
    ).await.unwrap();
    assert_eq!(released.get::<_, String>(0), "released");
    assert_eq!(released.get::<_, i64>(1), 0);
    assert_eq!(released.get::<_, i64>(2), 0);
}

async fn verify_offboarding_during_enrollment(fixture: &ControlFixture) {
    acknowledge_fixture_archive(&fixture.admin).await;
    let human = policy::github_human_id("5").unwrap();
    execute(
        &fixture.database,
        &fixture.native,
        &fixture.identities[1],
        Command::SetMembership(SetMembership {
            human_id: human.clone(),
            github_id: "5".into(),
            role: PlatformRole::Member as i32,
            enabled: true,
        }),
    )
    .await;
    let session = Uuid::new_v4();
    let now = fixture.admin.state().await.unwrap().now_ms as i64;
    let credential = URL_SAFE_NO_PAD.encode(Sha256::digest(session.as_bytes()));
    fixture.admin.pool.get().await.unwrap().execute(
        "INSERT INTO ofz.sessions(id,token_hash,human_id,identity_subject,identity_session,operation_id,expires_at_ms,idle_deadline_ms,mfa_at_ms,recovery_generation,github_id,establishment_fingerprint) VALUES($1,$2,$3,$4,$4,$5,$6,$6,$7,1,'5',$2)",
        &[&session,&Sha256::digest(credential.as_bytes()).to_vec(),&human,&Uuid::new_v4().to_string(),&Uuid::new_v4(),&(now+3_600_000),&now],
    ).await.unwrap();
    let owner = (human.clone(), session.to_string());
    let reservation = Uuid::new_v4().to_string();
    execute(
        &fixture.database,
        &fixture.native,
        &owner,
        Command::ReserveWorkspace(ReserveWorkspace {
            reservation_id: reservation.clone(),
            home_bytes: HOME_BYTES,
        }),
    )
    .await;
    let uid = Uuid::new_v4().to_string();
    let home = Uuid::new_v4().to_string();
    let begin = controller_request(
        &fixture.database,
        &owner,
        Command::BeginWorkspaceEnrollment(BeginWorkspaceEnrollment {
            reservation_id: reservation.clone(),
            workspace_uid: uid.clone(),
            owner_id: human.clone(),
        }),
    )
    .await;
    commands::execute(&fixture.database, &fixture.native, CONTROLLER_ID, begin)
        .await
        .unwrap();
    execute(
        &fixture.database,
        &fixture.native,
        &fixture.identities[1],
        Command::SetMembership(SetMembership {
            human_id: human.clone(),
            github_id: "5".into(),
            role: PlatformRole::Member as i32,
            enabled: false,
        }),
    )
    .await;
    let enroll = controller_request(
        &fixture.database,
        &owner,
        Command::EnrollWorkspace(EnrollWorkspace {
            reservation_id: reservation.clone(),
            workspace_uid: uid.clone(),
            home_uid: home.clone(),
            owner_id: human.clone(),
            home_bytes: HOME_BYTES,
        }),
    )
    .await;
    let receipt = commands::execute(
        &fixture.database,
        &fixture.native,
        CONTROLLER_ID,
        enroll.clone(),
    )
    .await
    .expect(
        "an accepted home must remain manageable when its owner is offboarded during enrollment",
    );
    assert_eq!(
        commands::execute(&fixture.database, &fixture.native, CONTROLLER_ID, enroll)
            .await
            .unwrap(),
        receipt
    );
    let projection = runtime_state(&fixture.service, &fixture.database, &owner, &uid).await;
    assert_eq!(projection.state, "quarantined");
    assert_eq!(projection.home_uid, home);
    assert_eq!(projection.reservation_id, reservation);
    assert!(!projection.running && !projection.runtime_allowed);
    assert!(
        read(
            &fixture.database,
            &fixture.native,
            &owner,
            &uid,
            Action::FilesObserve
        )
        .await
        .is_err()
    );
    let retained = fixture
        .admin
        .pool
        .get()
        .await
        .unwrap()
        .query_one(
            "SELECT used_workspaces,used_active,used_bytes FROM ofz.quota_usage WHERE owner_id=$1",
            &[&human],
        )
        .await
        .unwrap();
    assert_eq!(retained.get::<_, i64>(0), 1);
    assert_eq!(retained.get::<_, i64>(1), 0);
    assert_eq!(retained.get::<_, i64>(2), HOME_BYTES as i64);
}

async fn verify_session_bootstrap(fixture: &ControlFixture) {
    let ControlFixture {
        admin,
        database,
        native,
        service,
        ..
    } = fixture;
    let owner = &fixture.identities[0];
    let retry_credential = URL_SAFE_NO_PAD.encode(Sha256::digest(Uuid::new_v4().as_bytes()));
    let retry_id = Uuid::new_v4();
    let retry_operation = Uuid::new_v4();
    let retry_request = EstablishSessionRequest {
        identity_token: "completed-identity-response-fixture".into(),
        nonce: URL_SAFE_NO_PAD.encode(Sha256::digest(b"completed-oidc-nonce")),
        operation_id: retry_operation.to_string(),
        credential: retry_credential.clone(),
        previous_credential: String::new(),
    };
    let retry_fingerprint = Sha256::digest(
        store::encode(&retry_request)
            .unwrap()
            .to_string()
            .as_bytes(),
    )
    .to_vec();
    let conn = admin.pool.get().await.unwrap();
    conn.execute("INSERT INTO ofz.sessions(id,token_hash,human_id,identity_subject,identity_session,operation_id,expires_at_ms,idle_deadline_ms,mfa_at_ms,recovery_generation,github_id,establishment_fingerprint) SELECT $1,$2,human_id,identity_subject,identity_session,$3,expires_at_ms,idle_deadline_ms,mfa_at_ms,recovery_generation,github_id,$4 FROM ofz.sessions WHERE id=$5", &[&retry_id,&Sha256::digest(retry_credential.as_bytes()).to_vec(),&retry_operation,&retry_fingerprint,&Uuid::parse_str(&owner.1).unwrap()]).await.unwrap();
    let before_retry: i64 = conn
        .query_one("SELECT count(*) FROM ofz.sessions", &[])
        .await
        .unwrap()
        .get(0);
    let issuer = Issuer::new(
        "https://identity.invalid/realms/tengri".into(),
        "tengri-bff".into(),
    )
    .unwrap();
    let recovered = sessions::establish(database, native, &issuer, BFF_ID, retry_request.clone())
        .await
        .unwrap();
    assert_eq!(recovered.id, retry_id.to_string());
    assert_eq!(recovered.credential, retry_credential);
    assert_eq!(
        conn.query_one("SELECT count(*) FROM ofz.sessions", &[])
            .await
            .unwrap()
            .get::<_, i64>(0),
        before_retry,
        "recovering a committed session does not create another session"
    );
    let mut collision = retry_request.clone();
    collision.nonce.push('A');
    assert_eq!(
        sessions::establish(database, native, &issuer, BFF_ID, collision)
            .await
            .unwrap_err()
            .code(),
        Code::AlreadyExists
    );
    let mut collision = retry_request.clone();
    collision.credential = URL_SAFE_NO_PAD.encode([9_u8; 32]);
    assert_eq!(
        sessions::establish(database, native, &issuer, BFF_ID, collision)
            .await
            .unwrap_err()
            .code(),
        Code::AlreadyExists
    );
    conn.execute(
        "UPDATE ofz.sessions SET revoked=true WHERE id=$1",
        &[&retry_id],
    )
    .await
    .unwrap();
    assert_eq!(
        sessions::establish(database, native, &issuer, BFF_ID, retry_request)
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated,
        "lost-response recovery does not revive a revoked session"
    );
    assert!(
        conn.query_one("SELECT revoked FROM ofz.sessions WHERE id=$1", &[&retry_id])
            .await
            .unwrap()
            .get::<_, bool>(0)
    );
    drop(conn);
    let context = request(
        database,
        owner,
        Command::ReserveWorkspace(ReserveWorkspace::default()),
    )
    .await
    .context;
    let list = ListAccessRequest {
        context: context.clone(),
        resource: Some(policy::platform()),
        ..Default::default()
    };
    let audit = ReadAuditRequest {
        context,
        ..Default::default()
    };
    let conn = admin.pool.get().await.unwrap();
    conn.execute(
        "UPDATE ofz.sessions SET mfa_at_ms=0 WHERE id=$1",
        &[&Uuid::parse_str(&owner.1).unwrap()],
    )
    .await
    .unwrap();
    assert_eq!(
        service
            .list_access(rpc_as(list.clone(), BFF_ID))
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied,
        "single-factor administrators cannot read policy rosters"
    );
    assert_eq!(
        service
            .read_audit(rpc_as(audit.clone(), BFF_ID))
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied,
        "single-factor administrators cannot read immutable audit"
    );
    conn.execute(
        "UPDATE ofz.sessions SET mfa_at_ms=ofz.now_ms()-600000 WHERE id=$1",
        &[&Uuid::parse_str(&owner.1).unwrap()],
    )
    .await
    .unwrap();
    drop(conn);
    assert_eq!(
        service
            .list_access(rpc_as(list.clone(), CONTROLLER_ID))
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied,
        "a controller cannot forge a human policy reader"
    );
    assert_eq!(
        service
            .read_audit(rpc_as(audit.clone(), CONTROLLER_ID))
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied,
        "a controller cannot forge a human audit reader"
    );
    assert!(
        !service
            .list_access(rpc_as(list, BFF_ID))
            .await
            .unwrap()
            .into_inner()
            .entries
            .is_empty()
    );
    service.read_audit(rpc_as(audit, BFF_ID)).await.unwrap();
    admin
        .pool
        .get()
        .await
        .unwrap()
        .execute(
            "UPDATE ofz.sessions SET mfa_at_ms=ofz.now_ms() WHERE id=$1",
            &[&Uuid::parse_str(&owner.1).unwrap()],
        )
        .await
        .unwrap();
    let preflight = AuthorizeCommandRequest {
        context: request(
            database,
            owner,
            Command::ReserveWorkspace(ReserveWorkspace::default()),
        )
        .await
        .context,
        action: Action::MembersManage as i32,
        resource: Some(policy::platform()),
    };
    assert_eq!(
        service
            .authorize_command(rpc_as(preflight.clone(), CONTROLLER_ID))
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    assert_eq!(
        service
            .authorize_command(rpc(AuthorizeCommandRequest {
                action: Action::FilesObserve as i32,
                ..preflight
            }))
            .await
            .unwrap_err()
            .code(),
        Code::InvalidArgument,
        "preflight cannot authorize runtime content"
    );
}

async fn verify_workspace_enrollment(fixture: &ControlFixture) -> WorkspaceFixture {
    let ControlFixture {
        admin,
        database,
        native,
        ..
    } = fixture;
    let owner = &fixture.identities[0];
    let reservation = Uuid::new_v4().to_string();
    let first = request(
        database,
        owner,
        Command::ReserveWorkspace(ReserveWorkspace {
            reservation_id: reservation.clone(),
            home_bytes: HOME_BYTES,
        }),
    )
    .await;
    let receipt = commands::execute(database, native, BFF_ID, first.clone())
        .await
        .unwrap();
    let replay = commands::execute(database, native, BFF_ID, first.clone())
        .await
        .unwrap();
    assert_eq!(receipt, replay);
    let mut conflict = first.clone();
    conflict.reason = "different command under same operation ID".into();
    assert_eq!(
        commands::execute(database, native, BFF_ID, conflict)
            .await
            .unwrap_err()
            .code(),
        Code::AlreadyExists
    );
    let mut stale = first.clone();
    stale.operation_id = Uuid::new_v4().to_string();
    assert_eq!(
        commands::execute(database, native, BFF_ID, stale)
            .await
            .unwrap_err()
            .code(),
        Code::Aborted
    );
    let uid = Uuid::new_v4().to_string();
    let begin = controller_request(
        database,
        owner,
        Command::BeginWorkspaceEnrollment(BeginWorkspaceEnrollment {
            reservation_id: reservation.clone(),
            workspace_uid: uid.clone(),
            owner_id: owner.0.clone(),
        }),
    )
    .await;
    assert_eq!(
        commands::execute(database, native, BFF_ID, begin.clone())
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    let begun = commands::execute(database, native, CONTROLLER_ID, begin.clone())
        .await
        .unwrap();
    assert_eq!(
        commands::execute(database, native, CONTROLLER_ID, begin)
            .await
            .unwrap(),
        begun
    );
    admin
        .pool
        .get()
        .await
        .unwrap()
        .execute(
            "UPDATE ofz.reservations SET created_at_ms=ofz.now_ms()-300001 WHERE id=$1",
            &[&Uuid::parse_str(&reservation).unwrap()],
        )
        .await
        .unwrap();
    assert_eq!(
        admin
            .pool
            .get()
            .await
            .unwrap()
            .query_one(
                "SELECT used_workspaces FROM ofz.quota_usage WHERE owner_id=$1",
                &[&owner.0]
            )
            .await
            .unwrap()
            .get::<_, i64>(0),
        1,
        "accepted enrollment remains quota-counted across the creation deadline"
    );
    let mut enroll = request(
        database,
        owner,
        Command::EnrollWorkspace(EnrollWorkspace {
            workspace_uid: uid.clone(),
            owner_id: owner.0.clone(),
            home_uid: Uuid::new_v4().to_string(),
            home_bytes: HOME_BYTES,
            reservation_id: reservation,
        }),
    )
    .await;
    enroll.context.as_mut().unwrap().actor = Some(decision::workload_actor(CONTROLLER_ID));
    enroll.context.as_mut().unwrap().session_id.clear();
    let mut wrong_uid = enroll.clone();
    wrong_uid.operation_id = Uuid::new_v4().to_string();
    if let Some(Command::EnrollWorkspace(command)) = wrong_uid.command.as_mut() {
        command.workspace_uid = Uuid::new_v4().to_string();
    }
    assert_eq!(
        commands::execute(database, native, CONTROLLER_ID, wrong_uid)
            .await
            .unwrap_err()
            .code(),
        Code::FailedPrecondition,
        "enrollment cannot consume a reservation bound to another MicroVM UID"
    );
    assert_eq!(
        commands::execute(database, native, BFF_ID, enroll.clone())
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    admin
        .pool
        .get()
        .await
        .unwrap()
        .execute("UPDATE ofz.archive_state SET acknowledged_at_ms=0", &[])
        .await
        .unwrap();
    assert_eq!(
        commands::execute(database, native, CONTROLLER_ID, enroll.clone())
            .await
            .unwrap_err()
            .code(),
        Code::Unavailable,
        "archive failure fences controller enrollment as well as human grants"
    );
    assert!(
        admin
            .pool
            .get()
            .await
            .unwrap()
            .query_opt(
                "SELECT 1 FROM ofz.workspaces WHERE uid=$1",
                &[&Uuid::parse_str(&uid).unwrap()]
            )
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        !native
            .check(&[crate::native::Check::new(
                "workspace",
                &uid,
                "view_metadata",
                "human",
                &owner.0
            )])
            .await
            .unwrap()
            .0
    );
    acknowledge_fixture_archive(admin).await;
    let enrolled_home = match enroll.command.as_ref().unwrap() {
        Command::EnrollWorkspace(command) => command.home_uid.clone(),
        _ => unreachable!(),
    };
    let enrolled_reservation = match enroll.command.as_ref().unwrap() {
        Command::EnrollWorkspace(command) => command.reservation_id.clone(),
        _ => unreachable!(),
    };
    commands::execute(database, native, CONTROLLER_ID, enroll)
        .await
        .unwrap();
    WorkspaceFixture {
        uid,
        home: enrolled_home,
        reservation_id: enrolled_reservation,
    }
}

async fn verify_dormant_connector_grants(fixture: &ControlFixture) {
    let client = fixture.admin.pool.get().await.unwrap();
    let snapshot = "SELECT (SELECT count(*) FROM ofz.commands), (SELECT count(*) FROM ofz.grants), (SELECT count(*) FROM ofz.replay), (SELECT count(*) FROM ofz.audit), (SELECT version FROM ofz.platform_state WHERE singleton)";
    let before = client.query_one(snapshot, &[]).await.unwrap();
    let input = request(
        &fixture.database,
        &fixture.identities[0],
        Command::ConfigureConnector(ConfigureConnector {
            connection_id: Uuid::new_v4().to_string(),
            create: true,
            enabled: true,
        }),
    )
    .await;
    assert_eq!(
        commands::execute(&fixture.database, &fixture.native, BFF_ID, input.clone())
            .await
            .unwrap_err()
            .code(),
        Code::Unimplemented,
    );
    assert_eq!(
        crate::connector_agent::check(
            &fixture.database,
            &fixture.native,
            policy::CONNECTOR_BROKER_ID,
            CheckConnectorAgentRequest::default(),
        )
        .await
        .unwrap_err()
        .code(),
        Code::Unimplemented,
    );
    assert_eq!(
        decision::check(
            &fixture.database,
            &fixture.native,
            BFF_ID,
            CheckRequest {
                context: input.context,
                action: Action::ConnectorCreate as i32,
                resource: Some(policy::platform()),
                ..Default::default()
            },
        )
        .await
        .unwrap_err()
        .code(),
        Code::Unimplemented,
    );
    let after = client.query_one(snapshot, &[]).await.unwrap();
    for column in 0..5usize {
        assert_eq!(
            before.get::<_, i64>(column),
            after.get::<_, i64>(column),
            "a dormant connector request changed durable authority"
        );
    }
}

async fn verify_connector_grants(fixture: &ControlFixture, workspace: &WorkspaceFixture) {
    acknowledge_fixture_archive(&fixture.admin).await;
    let owner = &fixture.identities[0];
    let stranger = &fixture.identities[2];
    let connection = Uuid::new_v4().to_string();
    let configured = request(
        &fixture.database,
        owner,
        Command::ConfigureConnector(ConfigureConnector {
            connection_id: connection.clone(),
            create: true,
            enabled: true,
        }),
    )
    .await;
    let receipt = commands::execute(
        &fixture.database,
        &fixture.native,
        BFF_ID,
        configured.clone(),
    )
    .await
    .unwrap();
    assert_eq!(
        commands::execute(&fixture.database, &fixture.native, BFF_ID, configured)
            .await
            .unwrap()
            .audit_receipt_id,
        receipt.audit_receipt_id
    );
    let takeover = request(
        &fixture.database,
        stranger,
        Command::ConfigureConnector(ConfigureConnector {
            connection_id: connection.clone(),
            create: true,
            enabled: true,
        }),
    )
    .await;
    assert_eq!(
        commands::execute(&fixture.database, &fixture.native, BFF_ID, takeover)
            .await
            .unwrap_err()
            .code(),
        Code::AlreadyExists
    );
    let unauthorized = request(
        &fixture.database,
        stranger,
        Command::ConfigureConnector(ConfigureConnector {
            connection_id: connection.clone(),
            create: false,
            enabled: false,
        }),
    )
    .await;
    assert_eq!(
        commands::execute(&fixture.database, &fixture.native, BFF_ID, unauthorized)
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    let old = fixture
        .admin
        .pool
        .get()
        .await
        .unwrap()
        .query_one(
            "SELECT running,runtime_epoch FROM ofz.workspaces WHERE uid=$1",
            &[&Uuid::parse_str(&workspace.uid).unwrap()],
        )
        .await
        .unwrap();
    let epoch = Uuid::new_v4().to_string();
    execute(
        &fixture.database,
        &fixture.native,
        owner,
        Command::SetWorkspaceRuntime(SetWorkspaceRuntime {
            workspace_uid: workspace.uid.clone(),
            running: true,
            runtime_epoch: epoch.clone(),
        }),
    )
    .await;
    let body = Sha256::digest(b"exact connector invocation bytes").to_vec();
    let (thumbprint, _) = crate::connector_agent::tests::signed_proof(&"a".repeat(43), &body);
    let grant_id = Uuid::new_v4().to_string();
    let command = request(
        &fixture.database,
        owner,
        Command::CreateGrant(CreateGrant {
            grant_id: grant_id.clone(),
            agent_id: Uuid::new_v4().to_string(),
            workspace_uid: workspace.uid.clone(),
            resource: Some(Resource {
                kind: ResourceKind::ConnectorConnection as i32,
                id: connection.clone(),
            }),
            actions: vec![Action::ConnectorRead as i32],
            scope: Some(ObservationScope {
                connector_operations: vec!["search".into()],
                max_bytes: 1024,
                max_items: 20,
                ..Default::default()
            }),
            expires_at_unix_ms: fixture.database.state().await.unwrap().now_ms + 600000,
            proof_key_thumbprint: thumbprint,
        }),
    )
    .await;
    let credential = commands::execute(&fixture.database, &fixture.native, BFF_ID, command)
        .await
        .unwrap()
        .agent_credential;
    let signed = || {
        let (_, proof) = crate::connector_agent::tests::signed_proof(&credential, &body);
        CheckConnectorAgentRequest {
            grant_id: grant_id.clone(),
            credential: credential.clone(),
            proof,
            request_hash: body.clone(),
            connection_id: connection.clone(),
            operation: "search".into(),
            action: Action::ConnectorRead as i32,
        }
    };
    let input = signed();
    let allowed = crate::connector_agent::check(
        &fixture.database,
        &fixture.native,
        policy::CONNECTOR_BROKER_ID,
        input.clone(),
    )
    .await
    .unwrap();
    assert!(allowed.decision.as_ref().unwrap().allowed);
    assert_eq!(allowed.context.as_ref().unwrap().runtime_epoch, epoch);
    assert_eq!(
        crate::connector_agent::check(
            &fixture.database,
            &fixture.native,
            policy::CONNECTOR_BROKER_ID,
            input
        )
        .await
        .unwrap_err()
        .code(),
        Code::Unauthenticated,
        "a proof cannot be replayed through another API process"
    );
    let mut wrong = signed();
    wrong.operation = "delete".into();
    assert_eq!(
        crate::connector_agent::check(
            &fixture.database,
            &fixture.native,
            policy::CONNECTOR_BROKER_ID,
            wrong
        )
        .await
        .unwrap_err()
        .code(),
        Code::PermissionDenied
    );
    let mut read_cannot_write = signed();
    read_cannot_write.action = Action::ConnectorInvoke as i32;
    assert_eq!(
        crate::connector_agent::check(
            &fixture.database,
            &fixture.native,
            policy::CONNECTOR_BROKER_ID,
            read_cannot_write
        )
        .await
        .unwrap_err()
        .code(),
        Code::PermissionDenied
    );
    let write_grant = Uuid::new_v4().to_string();
    let (thumbprint, _) = crate::connector_agent::tests::signed_proof(&"a".repeat(43), &body);
    let write_command = request(
        &fixture.database,
        owner,
        Command::CreateGrant(CreateGrant {
            grant_id: write_grant.clone(),
            agent_id: Uuid::new_v4().to_string(),
            workspace_uid: workspace.uid.clone(),
            resource: Some(Resource {
                kind: ResourceKind::ConnectorConnection as i32,
                id: connection.clone(),
            }),
            actions: vec![Action::ConnectorInvoke as i32],
            scope: Some(ObservationScope {
                connector_operations: vec!["create_issue".into()],
                max_bytes: 1024,
                max_items: 20,
                ..Default::default()
            }),
            expires_at_unix_ms: fixture.database.state().await.unwrap().now_ms + 600000,
            proof_key_thumbprint: thumbprint,
        }),
    )
    .await;
    let write_credential =
        commands::execute(&fixture.database, &fixture.native, BFF_ID, write_command)
            .await
            .unwrap()
            .agent_credential;
    let (_, write_proof) = crate::connector_agent::tests::signed_proof(&write_credential, &body);
    let mut write_input = signed();
    write_input.grant_id = write_grant.clone();
    write_input.credential = write_credential;
    write_input.proof = write_proof;
    write_input.action = Action::ConnectorInvoke as i32;
    write_input.operation = "create_issue".into();
    assert!(
        crate::connector_agent::check(
            &fixture.database,
            &fixture.native,
            policy::CONNECTOR_BROKER_ID,
            write_input
        )
        .await
        .unwrap()
        .decision
        .unwrap()
        .allowed
    );
    execute(
        &fixture.database,
        &fixture.native,
        owner,
        Command::RevokeGrant(RevokeGrant {
            grant_id: write_grant,
        }),
    )
    .await;
    let changed_epoch = Uuid::new_v4();
    let uid = Uuid::parse_str(&workspace.uid).unwrap();
    fixture
        .admin
        .pool
        .get()
        .await
        .unwrap()
        .execute(
            "UPDATE ofz.workspaces SET runtime_epoch=$1 WHERE uid=$2",
            &[&changed_epoch, &uid],
        )
        .await
        .unwrap();
    assert_eq!(
        crate::connector_agent::check(
            &fixture.database,
            &fixture.native,
            policy::CONNECTOR_BROKER_ID,
            signed()
        )
        .await
        .unwrap_err()
        .code(),
        Code::PermissionDenied,
        "a new runtime must not resurrect an old connector capability"
    );
    fixture
        .admin
        .pool
        .get()
        .await
        .unwrap()
        .execute(
            "UPDATE ofz.workspaces SET runtime_epoch=$1 WHERE uid=$2",
            &[&Uuid::parse_str(&epoch).unwrap(), &uid],
        )
        .await
        .unwrap();
    let revoke = request(
        &fixture.database,
        owner,
        Command::ConfigureConnector(ConfigureConnector {
            connection_id: connection.clone(),
            create: false,
            enabled: false,
        }),
    )
    .await;
    commands::execute(&fixture.database, &fixture.native, BFF_ID, revoke)
        .await
        .unwrap();
    assert_eq!(
        crate::connector_agent::check(
            &fixture.database,
            &fixture.native,
            policy::CONNECTOR_BROKER_ID,
            signed()
        )
        .await
        .unwrap_err()
        .code(),
        Code::PermissionDenied
    );
    execute(
        &fixture.database,
        &fixture.native,
        owner,
        Command::RevokeGrant(RevokeGrant { grant_id }),
    )
    .await;
    execute(
        &fixture.database,
        &fixture.native,
        owner,
        Command::SetWorkspaceRuntime(SetWorkspaceRuntime {
            workspace_uid: workspace.uid.clone(),
            running: false,
            runtime_epoch: epoch,
        }),
    )
    .await;
    fixture
        .admin
        .pool
        .get()
        .await
        .unwrap()
        .execute(
            "UPDATE ofz.workspaces SET running=$1,runtime_epoch=$2 WHERE uid=$3",
            &[
                &old.get::<_, bool>(0),
                &old.get::<_, Option<Uuid>>(1),
                &Uuid::parse_str(&workspace.uid).unwrap(),
            ],
        )
        .await
        .unwrap();
    acknowledge_fixture_archive(&fixture.admin).await;
}

async fn verify_access_rosters(fixture: &ControlFixture, workspace: &WorkspaceFixture) {
    let ControlFixture {
        database,
        native,
        identities,
        service,
        ..
    } = fixture;
    let owner = &fixture.identities[0];
    let uid = workspace.uid.clone();
    assert!(
        read(database, native, owner, &uid, Action::WorkspaceMetadataRead)
            .await
            .unwrap()
            .allowed
    );
    assert!(
        !read(
            database,
            native,
            &identities[1],
            &uid,
            Action::WorkspaceMetadataRead
        )
        .await
        .unwrap()
        .allowed,
        "platform administration grants no content access"
    );
    let open = read(database, native, owner, &uid, Action::WorkspaceMetadataRead)
        .await
        .unwrap();
    let mut stream_context = request(
        database,
        owner,
        Command::ReserveWorkspace(ReserveWorkspace::default()),
    )
    .await
    .context
    .unwrap();
    stream_context.workspace_uid = uid.clone();
    let stream = CheckRequest {
        context: Some(stream_context),
        resource: Some(policy::workspace(&uid)),
        action: Action::WorkspaceMetadataRead as i32,
        target: String::new(),
        stream_receipt_id: open.audit_receipt_id,
    };
    assert!(
        decision::check(database, native, BFF_ID, stream.clone())
            .await
            .unwrap()
            .allowed
    );
    let mut wrong_origin = stream.clone();
    wrong_origin.context.as_mut().unwrap().origin = "https://other.example".into();
    assert_eq!(
        decision::check(database, native, BFF_ID, wrong_origin)
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    let mut wrong_epoch = stream.clone();
    wrong_epoch.context.as_mut().unwrap().runtime_epoch = Uuid::new_v4().to_string();
    assert_eq!(
        decision::check(database, native, BFF_ID, wrong_epoch)
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    execute(
        database,
        native,
        owner,
        Command::SetWorkspaceRole(SetWorkspaceRole {
            workspace_uid: uid.clone(),
            human_id: identities[2].0.clone(),
            role: WorkspaceRole::Viewer as i32,
            enabled: true,
            scope: None,
        }),
    )
    .await;
    assert!(
        read(
            database,
            native,
            &identities[2],
            &uid,
            Action::WorkspaceMetadataRead
        )
        .await
        .unwrap()
        .allowed
    );
    assert!(
        !read(database, native, &identities[2], &uid, Action::FilesWrite)
            .await
            .unwrap()
            .allowed
    );
    let roster_context = |identity: &(String, String)| {
        let mut context = stream.context.clone().unwrap();
        context.actor = Some(Actor {
            identity: Some(Identity::HumanId(identity.0.clone())),
        });
        context.session_id = identity.1.clone();
        context.trace_id = Uuid::new_v4().to_string();
        async move {
            context.deadline_unix_ms = database.state().await.unwrap().now_ms + 10_000;
            context
        }
    };
    let roster = service
        .list_access(rpc(ListAccessRequest {
            context: Some(roster_context(owner).await),
            resource: Some(policy::workspace(&uid)),
            ..Default::default()
        }))
        .await
        .unwrap()
        .into_inner();
    assert_eq!(roster.workspace_state, "active");
    assert_eq!(roster.entries.len(), 2);
    assert!(
        roster
            .entries
            .iter()
            .any(|entry| entry.role == "owner" && entry.github_id == "1")
    );
    assert!(
        roster
            .entries
            .iter()
            .any(|entry| entry.role == "viewer" && entry.github_id == "3")
    );
    assert_eq!(roster.quotas.len(), 1);
    assert_eq!(roster.quotas[0].used_workspaces, 1);
    assert_eq!(roster.quotas[0].used_bytes, HOME_BYTES);
    let denied = service
        .list_access(rpc(ListAccessRequest {
            context: Some(roster_context(&identities[2]).await),
            resource: Some(policy::workspace(&uid)),
            ..Default::default()
        }))
        .await
        .unwrap_err();
    assert_eq!(denied.code(), Code::PermissionDenied);
    assert!(
        denied.metadata().contains_key("x-ofz-audit-receipt"),
        "roster denials must be audited"
    );
    let platform = service
        .list_access(rpc(ListAccessRequest {
            context: Some(roster_context(owner).await),
            resource: Some(policy::platform()),
            ..Default::default()
        }))
        .await
        .unwrap()
        .into_inner();
    assert_eq!(platform.entries.len(), 6);
    assert_eq!(platform.quotas.len(), 4);
    assert!(
        platform
            .entries
            .iter()
            .all(|entry| !entry.github_id.is_empty())
    );
    let denied = service
        .read_audit(rpc(ReadAuditRequest {
            context: Some(roster_context(&identities[2]).await),
            ..Default::default()
        }))
        .await
        .unwrap_err();
    assert_eq!(
        denied.code(),
        Code::PermissionDenied,
        "workspace visibility does not grant platform audit reading"
    );
    assert!(denied.metadata().contains_key("x-ofz-audit-receipt"));
    execute(
        database,
        native,
        owner,
        Command::SetMembership(SetMembership {
            human_id: identities[1].0.clone(),
            github_id: "2".into(),
            role: PlatformRole::Auditor as i32,
            enabled: true,
        }),
    )
    .await;
    let audit = service
        .read_audit(rpc(ReadAuditRequest {
            context: Some(roster_context(&identities[1]).await),
            limit: 200,
            ..Default::default()
        }))
        .await
        .unwrap()
        .into_inner();
    assert!(!audit.receipts.is_empty());
    assert!(
        audit
            .receipts
            .windows(2)
            .all(|pair| pair[0].sequence < pair[1].sequence)
    );
    for audit_read in [false, true] {
        let auditor = &identities[2];
        execute(
            database,
            native,
            owner,
            Command::SetMembership(SetMembership {
                human_id: auditor.0.clone(),
                github_id: "3".into(),
                role: PlatformRole::Auditor as i32,
                enabled: true,
            }),
        )
        .await;
        let entered = std::sync::Arc::new(tokio::sync::Notify::new());
        let resume = std::sync::Arc::new(tokio::sync::Notify::new());
        let paused = service
            .clone()
            .with_read_barrier(entered.clone(), resume.clone());
        let context = request(
            database,
            auditor,
            Command::ReserveWorkspace(ReserveWorkspace::default()),
        )
        .await
        .context;
        let read = tokio::spawn(async move {
            if audit_read {
                paused
                    .read_audit(rpc(ReadAuditRequest {
                        context,
                        ..Default::default()
                    }))
                    .await
                    .map(|_| ())
            } else {
                paused
                    .list_access(rpc(ListAccessRequest {
                        context,
                        resource: Some(policy::platform()),
                        ..Default::default()
                    }))
                    .await
                    .map(|_| ())
            }
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), entered.notified())
            .await
            .unwrap();
        execute(
            database,
            native,
            owner,
            Command::SetMembership(SetMembership {
                human_id: auditor.0.clone(),
                github_id: "3".into(),
                role: PlatformRole::Auditor as i32,
                enabled: false,
            }),
        )
        .await;
        resume.notify_one();
        assert_eq!(
            read.await.unwrap().unwrap_err().code(),
            Code::Aborted,
            "roster and audit reads cannot adopt a policy version sampled after authorization"
        );
    }
    let mismatch = request(
        database,
        owner,
        Command::SetMembership(SetMembership {
            human_id: identities[1].0.clone(),
            github_id: "999".into(),
            role: PlatformRole::Member as i32,
            enabled: true,
        }),
    )
    .await;
    let mismatch = commands::execute(database, native, BFF_ID, mismatch)
        .await
        .unwrap_err();
    assert_eq!(
        mismatch.code(),
        Code::InvalidArgument,
        "a numeric GitHub identity cannot be rebound to another human hash: {mismatch}"
    );
    let revoke_admin = request(
        database,
        owner,
        Command::SetMembership(SetMembership {
            human_id: identities[1].0.clone(),
            github_id: "2".into(),
            role: PlatformRole::Administrator as i32,
            enabled: false,
        }),
    )
    .await;
    assert_eq!(
        commands::execute(database, native, BFF_ID, revoke_admin)
            .await
            .unwrap_err()
            .code(),
        Code::FailedPrecondition
    );
}

async fn verify_abandoned_reservation_expiry(
    fixture: &ControlFixture,
    workspace: &WorkspaceFixture,
) {
    let owner = &fixture.identities[0];
    let client = fixture.admin.pool.get().await.unwrap();
    let abandoned: Uuid = client.query_one("UPDATE ofz.reservations SET created_at_ms=ofz.now_ms()-300001 WHERE owner_id=$1 AND state='reserved' RETURNING id", &[&owner.0]).await.unwrap().get(0);
    client
        .execute(
            "UPDATE ofz.reservations SET created_at_ms=ofz.now_ms()-300001 WHERE id=$1",
            &[&Uuid::parse_str(&workspace.reservation_id).unwrap()],
        )
        .await
        .unwrap();
    let usage = client
        .query_one(
            "SELECT used_workspaces,used_bytes FROM ofz.quota_usage WHERE owner_id=$1",
            &[&owner.0],
        )
        .await
        .unwrap();
    assert_eq!(
        usage.get::<_, i64>(0),
        1,
        "abandoned creation must release quota on the database clock"
    );
    assert_eq!(
        usage.get::<_, i64>(1),
        HOME_BYTES as i64,
        "enrolled homes remain counted after the reservation deadline"
    );
    drop(client);
    let context = request(
        &fixture.database,
        owner,
        Command::ReserveWorkspace(ReserveWorkspace::default()),
    )
    .await
    .context;
    let expired = fixture
        .service
        .get_workspace_reservation(rpc_as(
            GetWorkspaceReservationRequest {
                context,
                reservation_id: abandoned.to_string(),
                recovery_generation: 1,
            },
            CONTROLLER_ID,
        ))
        .await
        .unwrap_err();
    assert_eq!(expired.code(), Code::FailedPrecondition);
    assert_eq!(expired.message(), "workspace reservation expired");
    execute(
        &fixture.database,
        &fixture.native,
        owner,
        Command::ReserveWorkspace(ReserveWorkspace {
            reservation_id: Uuid::new_v4().to_string(),
            home_bytes: HOME_BYTES,
        }),
    )
    .await;
    let enrollment = controller_request(
        &fixture.database,
        owner,
        Command::BeginWorkspaceEnrollment(BeginWorkspaceEnrollment {
            reservation_id: abandoned.to_string(),
            workspace_uid: Uuid::new_v4().to_string(),
            owner_id: owner.0.clone(),
        }),
    )
    .await;
    let expired = commands::execute(
        &fixture.database,
        &fixture.native,
        CONTROLLER_ID,
        enrollment,
    )
    .await
    .unwrap_err();
    assert_eq!(expired.code(), Code::FailedPrecondition);
    assert_eq!(expired.message(), "workspace reservation expired");
    assert_eq!(
        runtime_state(&fixture.service, &fixture.database, owner, &workspace.uid)
            .await
            .reservation_id,
        workspace.reservation_id
    );
}

async fn verify_concurrent_quota(fixture: &ControlFixture) {
    let ControlFixture {
        admin,
        database,
        native,
        ..
    } = fixture;
    let owner = &fixture.identities[0];
    let owner_session = Uuid::parse_str(&owner.1).unwrap();
    let client = admin.pool.get().await.unwrap();
    let creation_idle: i64 = client
        .query_one(
            "UPDATE ofz.sessions SET idle_deadline_ms=ofz.now_ms()+60000 WHERE id=$1 RETURNING idle_deadline_ms",
            &[&owner_session],
        )
        .await
        .unwrap()
        .get(0);
    drop(client);
    let a = request(
        database,
        owner,
        Command::ReserveWorkspace(ReserveWorkspace {
            reservation_id: Uuid::new_v4().to_string(),
            home_bytes: HOME_BYTES,
        }),
    )
    .await;
    let b = request(
        database,
        owner,
        Command::ReserveWorkspace(ReserveWorkspace {
            reservation_id: Uuid::new_v4().to_string(),
            home_bytes: HOME_BYTES,
        }),
    )
    .await;
    let (a, b) = tokio::join!(
        commands::execute(database, native, BFF_ID, a),
        commands::execute(database, native, BFF_ID, b)
    );
    assert_eq!(
        usize::from(a.is_ok()) + usize::from(b.is_ok()),
        1,
        "concurrent expected-version commands serialize"
    );
    assert!(
        admin
            .pool
            .get()
            .await
            .unwrap()
            .query_one(
                "SELECT idle_deadline_ms FROM ofz.sessions WHERE id=$1",
                &[&owner_session]
            )
            .await
            .unwrap()
            .get::<_, i64>(0)
            > creation_idle + 1_000_000,
        "accepted workspace reservation renews idle time without an MFA requirement"
    );
    let over = request(
        database,
        owner,
        Command::ReserveWorkspace(ReserveWorkspace {
            reservation_id: Uuid::new_v4().to_string(),
            home_bytes: HOME_BYTES,
        }),
    )
    .await;
    assert_eq!(
        commands::execute(database, native, BFF_ID, over)
            .await
            .unwrap_err()
            .code(),
        Code::ResourceExhausted
    );
}

async fn verify_emergency_crash_recovery(fixture: &ControlFixture, workspace: &WorkspaceFixture) {
    let ControlFixture {
        admin,
        database,
        native,
        identities,
        service,
        ..
    } = fixture;
    let owner = &fixture.identities[0];
    let uid = workspace.uid.clone();
    // Crash before native write, after native commit, and after SQL finalize/lost response.
    let mut emergency = EmergencyAccess {
        workspace_uid: uid.clone(),
        human_id: identities[3].0.clone(),
        incident_id: "INC-OFZ-QUALIFICATION".into(),
        custodian_approval_id: String::new(),
        // This grant must remain live through the offboarding sequence over a remote database.
        expires_at_unix_ms: database.state().await.unwrap().now_ms + 600_000,
    };
    let approval = execute(
        database,
        native,
        owner,
        Command::EmergencyAccess(emergency.clone()),
    )
    .await;
    assert!(
        !read(
            database,
            native,
            &identities[3],
            &uid,
            Action::WorkspaceMetadataRead
        )
        .await
        .unwrap()
        .allowed,
        "first custodian cannot activate emergency access alone"
    );
    assert!(
        !workspace_roster(service, database, owner, &uid)
            .await
            .iter()
            .any(|entry| entry.role == "emergency")
    );
    emergency.custodian_approval_id = approval.operation_id;
    let same = request(database, owner, Command::EmergencyAccess(emergency.clone())).await;
    assert_eq!(
        commands::execute(database, native, BFF_ID, same)
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    execute(
        database,
        native,
        &identities[1],
        Command::EmergencyAccess(emergency.clone()),
    )
    .await;
    let entries = workspace_roster(service, database, owner, &uid).await;
    let active = entries
        .iter()
        .find(|entry| entry.role == "emergency")
        .expect("the effective emergency grant must be visible to its owner");
    assert_eq!(active.subject_id, identities[3].0);
    assert_eq!(active.expires_at_unix_ms, emergency.expires_at_unix_ms);
    assert!(
        read(
            database,
            native,
            &identities[3],
            &uid,
            Action::WorkspaceMetadataRead
        )
        .await
        .unwrap()
        .allowed
    );
    let consumed = request(
        database,
        &identities[1],
        Command::EmergencyAccess(emergency),
    )
    .await;
    assert_eq!(
        commands::execute(database, native, BFF_ID, consumed)
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    let repeat_role = Command::SetWorkspaceRole(SetWorkspaceRole {
        workspace_uid: uid.clone(),
        human_id: identities[2].0.clone(),
        role: WorkspaceRole::Viewer as i32,
        enabled: true,
        scope: None,
    });
    execute(database, native, owner, repeat_role.clone()).await;
    execute(database, native, owner, repeat_role).await;
    let controller_administration = request(
        database,
        owner,
        Command::SetMembership(SetMembership {
            human_id: identities[3].0.clone(),
            github_id: "4".into(),
            role: PlatformRole::Operator as i32,
            enabled: true,
        }),
    )
    .await;
    assert_eq!(
        commands::execute(database, native, CONTROLLER_ID, controller_administration)
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied,
        "propagated human context cannot make the controller an administrator"
    );
    for boundary in 0..3 {
        let command = Command::SetWorkspaceRole(SetWorkspaceRole {
            workspace_uid: uid.clone(),
            human_id: identities[3].0.clone(),
            role: WorkspaceRole::Viewer as i32,
            enabled: boundary % 2 == 0,
            scope: None,
        });
        let pending = request(database, owner, command).await;
        let operation = pending.operation_id.clone();
        let expected = pending.expected_version;
        let mut connection = database.command_connection().await.unwrap();
        let state = database.state().await.unwrap();
        let (prepared, _) = prepare(
            database,
            native,
            &connection.client,
            BFF_ID,
            pending.clone(),
            &state,
        )
        .await
        .unwrap();
        persist(
            &mut connection.client,
            BFF_ID,
            &prepared,
            &fingerprint(&pending, BFF_ID).unwrap(),
        )
        .await
        .unwrap();
        if boundary >= 1 {
            native
                .apply(&operation, expected, &prepared.changes)
                .await
                .unwrap();
        }
        if boundary == 2 {
            let (_, revision) = native.applied(&operation).await.unwrap();
            finalize(&mut connection.client, &prepared, &revision, false)
                .await
                .unwrap();
        }
        drop(connection); // drops the actual SQL connection and its advisory lock
        let recovered = commands::execute(database, native, BFF_ID, pending)
            .await
            .unwrap();
        assert_eq!(recovered.version, expected + 1);
        assert_eq!(recovered.recovered_revision, boundary == 1);
        assert_eq!(database.state().await.unwrap().version, expected + 1);
        let conn = admin.pool.get().await.unwrap();
        let count: i64 = conn
            .query_one(
                "SELECT count(*) FROM ofz.audit WHERE receipt->>'operation_id'=$1",
                &[&operation],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(count, 1, "one durable audit receipt per recovered command");
    }
}

async fn verify_delegation_and_journal_integrity(
    fixture: &ControlFixture,
    workspace: &WorkspaceFixture,
) -> String {
    acknowledge_fixture_archive(&fixture.admin).await;
    let ControlFixture {
        admin,
        database,
        native,
        identities,
        ..
    } = fixture;
    let owner = &fixture.identities[0];
    let uid = workspace.uid.clone();
    let grant_id = Uuid::new_v4().to_string();
    let agent_id = Uuid::new_v4().to_string();
    let expiry = database.state().await.unwrap().now_ms + 600_000;
    let grant_command = request(
        database,
        owner,
        Command::CreateGrant(CreateGrant {
            grant_id: grant_id.clone(),
            agent_id: agent_id.clone(),
            workspace_uid: uid.clone(),
            resource: Some(policy::workspace(&uid)),
            actions: vec![Action::WorkspaceMetadataRead as i32],
            scope: Some(ObservationScope {
                max_bytes: 65536,
                max_items: 100,
                ..Default::default()
            }),
            expires_at_unix_ms: expiry,
            proof_key_thumbprint: "q".repeat(43),
        }),
    )
    .await;
    let grant_receipt = commands::execute(database, native, BFF_ID, grant_command.clone())
        .await
        .unwrap();
    assert_eq!(grant_receipt.agent_credential.len(), 43);
    let conn = admin.pool.get().await.unwrap();
    let payload: serde_json::Value = conn
        .query_one(
            "SELECT prepared FROM ofz.commands WHERE operation_id=$1",
            &[&Uuid::parse_str(&grant_receipt.operation_id).unwrap()],
        )
        .await
        .unwrap()
        .get(0);
    assert!(
        !payload
            .to_string()
            .contains(&grant_receipt.agent_credential),
        "the durable intent must not contain a credential"
    );
    drop(conn);
    assert!(
        commands::execute(database, native, BFF_ID, grant_command)
            .await
            .unwrap()
            .agent_credential
            .is_empty(),
        "credentials are not persisted/replayed"
    );
    let mut delegated = CheckRequest {
        context: Some(RequestContext {
            actor: Some(Actor {
                identity: Some(Identity::AgentId(agent_id)),
            }),
            session_id: String::new(),
            grant_id: grant_id.clone(),
            trace_id: String::new(),
            deadline_unix_ms: database.state().await.unwrap().now_ms + 10_000,
            contract_version: crate::CONTRACT_VERSION,
            workspace_uid: uid.clone(),
            origin: "https://proompteng.ai".into(),
            ..Default::default()
        }),
        resource: Some(policy::workspace(&uid)),
        action: Action::WorkspaceMetadataRead as i32,
        target: String::new(),
        stream_receipt_id: String::new(),
    };
    let delegated_decision = decision::check(database, native, BFF_ID, delegated.clone())
        .await
        .unwrap();
    assert!(delegated_decision.allowed);
    assert_eq!(
        delegated_decision.effective_scope,
        Some(ObservationScope {
            max_bytes: 65536,
            max_items: 100,
            ..Default::default()
        }),
        "the caller receives the stored grant scope rather than supplying its own"
    );
    admin
        .pool
        .get()
        .await
        .unwrap()
        .execute(
            "UPDATE ofz.grants SET expires_at_ms=ofz.now_ms()-1 WHERE id=$1",
            &[&Uuid::parse_str(&grant_id).unwrap()],
        )
        .await
        .unwrap();
    assert_eq!(
        decision::check(database, native, BFF_ID, delegated.clone())
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied,
        "SQL deadline is independently enforced"
    );
    admin
        .pool
        .get()
        .await
        .unwrap()
        .execute(
            "UPDATE ofz.grants SET expires_at_ms=$2 WHERE id=$1",
            &[&Uuid::parse_str(&grant_id).unwrap(), &(expiry as i64)],
        )
        .await
        .unwrap();
    execute(
        database,
        native,
        owner,
        Command::RevokeGrant(RevokeGrant {
            grant_id: grant_id.clone(),
        }),
    )
    .await;
    assert_eq!(
        decision::check(database, native, BFF_ID, delegated.clone())
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    // A recovered earlier grant command must not resurrect after its successor revocation.
    let mut connection = database.command_connection().await.unwrap();
    reconcile(database, native, &mut connection.client)
        .await
        .unwrap();
    drop(connection);
    assert!(decision::grant(database, &grant_id).await.unwrap().revoked);
    // Native binding loss fails even if the central grant row is otherwise valid.
    let second = Uuid::new_v4().to_string();
    let c = Command::CreateGrant(CreateGrant {
        grant_id: second.clone(),
        agent_id: match delegated
            .context
            .as_ref()
            .unwrap()
            .actor
            .as_ref()
            .unwrap()
            .identity
            .as_ref()
            .unwrap()
        {
            Identity::AgentId(id) => id.clone(),
            _ => unreachable!(),
        },
        workspace_uid: uid.clone(),
        resource: Some(policy::workspace(&uid)),
        actions: vec![Action::WorkspaceMetadataRead as i32],
        scope: Some(ObservationScope {
            max_bytes: 65536,
            max_items: 100,
            ..Default::default()
        }),
        expires_at_unix_ms: expiry,
        proof_key_thumbprint: "q".repeat(43),
    });
    execute(database, native, owner, c).await;
    delegated.context.as_mut().unwrap().grant_id = second.clone();
    assert!(
        decision::check(database, native, BFF_ID, delegated.clone())
            .await
            .unwrap()
            .allowed
    );
    let state = database.state().await.unwrap();
    native
        .apply(
            &Uuid::new_v4().to_string(),
            state.version,
            &[Update::delete(Relationship::new(
                "agent_grant",
                &second,
                "issuer",
                "human",
                &owner.0,
            ))],
        )
        .await
        .unwrap();
    admin
        .pool
        .get()
        .await
        .unwrap()
        .execute("UPDATE ofz.platform_state SET version=version+1", &[])
        .await
        .unwrap();
    assert!(
        !decision::check(database, native, BFF_ID, delegated.clone())
            .await
            .unwrap()
            .allowed
    );
    // Current parent membership revocation invalidates both human and delegated access.
    execute(
        database,
        native,
        &identities[1],
        Command::SetMembership(SetMembership {
            human_id: identities[2].0.clone(),
            github_id: "3".into(),
            role: PlatformRole::Member as i32,
            enabled: false,
        }),
    )
    .await;
    assert_eq!(
        read(
            database,
            native,
            &identities[2],
            &uid,
            Action::WorkspaceMetadataRead
        )
        .await
        .unwrap_err()
        .code(),
        Code::Unauthenticated
    );
    // An API writer cannot rewrite/delete audit or mutate an existing command payload.
    let client = database.pool.get().await.unwrap();
    assert_eq!(
        client
            .execute("DELETE FROM ofz.audit", &[])
            .await
            .unwrap_err()
            .code()
            .unwrap()
            .code(),
        "42501"
    );
    assert_eq!(
        client
            .execute("UPDATE ofz.audit SET receipt='{}'", &[])
            .await
            .unwrap_err()
            .code()
            .unwrap()
            .code(),
        "42501"
    );
    assert_eq!(
        client
            .execute("UPDATE ofz.commands SET prepared='{}'", &[])
            .await
            .unwrap_err()
            .code()
            .unwrap()
            .code(),
        "42501"
    );
    drop(client);
    second
}

async fn verify_archive_fencing(
    fixture: &ControlFixture,
    workspace: &WorkspaceFixture,
    second: String,
) {
    let ControlFixture {
        admin,
        database,
        native,
        service,
        ..
    } = fixture;
    let owner = &fixture.identities[0];
    let uid = workspace.uid.clone();
    // A live exporter cannot hide an old pending row or a stale durable checkpoint.
    acknowledge_fixture_archive(admin).await;
    let context = request(
        database,
        owner,
        Command::ReserveWorkspace(ReserveWorkspace::default()),
    )
    .await
    .context
    .unwrap();
    let receipt = store::receipt(
        &context,
        BFF_ID,
        policy::platform(),
        Action::AuditRead,
        true,
        "",
        "archive backlog fixture",
    );
    let conn = admin.pool.get().await.unwrap();
    let sequence: i64 = conn.query_one("INSERT INTO ofz.audit(id,receipt,target_hash,created_at_ms) VALUES($1,$2,$3,ofz.now_ms()-61000) RETURNING sequence", &[&Uuid::parse_str(&receipt.id).unwrap(),&store::encode(&receipt).unwrap(),&Sha256::digest(b"").to_vec()]).await.unwrap().get(0);
    conn.execute(
        "INSERT INTO ofz.audit_outbox(audit_sequence) VALUES($1)",
        &[&sequence],
    )
    .await
    .unwrap();
    assert!(
        !database.state().await.unwrap().archive_healthy,
        "fresh exporter heartbeat does not acknowledge an old outbox row"
    );
    assert_eq!(
        read(database, native, owner, &uid, Action::WorkspaceMetadataRead)
            .await
            .unwrap_err()
            .code(),
        Code::Unavailable
    );
    conn.execute(
        "UPDATE ofz.audit_outbox SET acknowledged_at_ms=ofz.now_ms() WHERE audit_sequence=$1",
        &[&sequence],
    )
    .await
    .unwrap();
    assert!(
        !database.state().await.unwrap().archive_healthy,
        "row acknowledgement cannot replace the archive checkpoint"
    );
    conn.execute(
        "UPDATE ofz.archive_state SET acknowledged_sequence=$1,acknowledged_at_ms=ofz.now_ms()",
        &[&sequence],
    )
    .await
    .unwrap();
    assert!(database.state().await.unwrap().archive_healthy);
    assert!(
        read(database, native, owner, &uid, Action::WorkspaceMetadataRead)
            .await
            .unwrap()
            .allowed
    );
    drop(conn);
    acknowledge_fixture_archive(admin).await;
    let checked = std::sync::Arc::new(tokio::sync::Notify::new());
    let resume = std::sync::Arc::new(tokio::sync::Notify::new());
    let paused_native = native
        .clone()
        .with_check_barrier(checked.clone(), resume.clone());
    let (in_flight, ()) = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        tokio::join!(
            read(
                database,
                &paused_native,
                owner,
                &uid,
                Action::WorkspaceMetadataRead
            ),
            async {
                checked.notified().await;
                admin
                    .pool
                    .get()
                    .await
                    .unwrap()
                    .execute("UPDATE ofz.archive_state SET acknowledged_at_ms=0", &[])
                    .await
                    .unwrap();
                resume.notify_one();
            }
        )
    })
    .await
    .expect("native-check race must reach and release its barrier");
    assert_eq!(
        in_flight.unwrap_err().code(),
        Code::DeadlineExceeded,
        "archive loss during a native check cannot return an allowed disclosure"
    );
    acknowledge_fixture_archive(admin).await;
    // Archive loss fences new data access; durable revocation remains available.
    admin
        .pool
        .get()
        .await
        .unwrap()
        .execute("UPDATE ofz.archive_state SET acknowledged_at_ms=0", &[])
        .await
        .unwrap();
    let conn = admin.pool.get().await.unwrap();
    let idle_before: i64 = conn.query_one("UPDATE ofz.sessions SET idle_deadline_ms=ofz.now_ms()+60000 WHERE id=$1 RETURNING idle_deadline_ms", &[&Uuid::parse_str(&owner.1).unwrap()]).await.unwrap().get(0);
    let preflight = service
        .authorize_command(rpc(AuthorizeCommandRequest {
            context: request(
                database,
                owner,
                Command::ReserveWorkspace(ReserveWorkspace::default()),
            )
            .await
            .context,
            action: Action::MembersManage as i32,
            resource: Some(policy::platform()),
        }))
        .await
        .unwrap()
        .into_inner();
    assert!(
        preflight.allowed,
        "permission-only command preflight remains available for revocation during archive loss"
    );
    assert!(!preflight.audit_receipt_id.is_empty());
    assert_eq!(
        conn.query_one(
            "SELECT idle_deadline_ms FROM ofz.sessions WHERE id=$1",
            &[&Uuid::parse_str(&owner.1).unwrap()]
        )
        .await
        .unwrap()
        .get::<_, i64>(0),
        idle_before,
        "preflight cannot extend session activity"
    );
    drop(conn);
    assert_eq!(
        read(database, native, owner, &uid, Action::WorkspaceMetadataRead)
            .await
            .unwrap_err()
            .code(),
        Code::Unavailable
    );
    execute(
        database,
        native,
        owner,
        Command::RevokeGrant(RevokeGrant { grant_id: second }),
    )
    .await;
    assert_eq!(
        decision::workload(
            native,
            "spiffe://proompteng.ai/ns/tengri/sa/nanoagent",
            Action::PolicyCheck
        )
        .await
        .unwrap_err()
        .code(),
        Code::Unauthenticated
    );
    assert_eq!(
        decision::workload(native, OFZ_ID, Action::PolicyCheck)
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    admin
        .pool
        .get()
        .await
        .unwrap()
        .execute(
            "UPDATE ofz.archive_state SET acknowledged_at_ms=ofz.now_ms()",
            &[],
        )
        .await
        .unwrap();
    let disconnected = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = disconnected.local_addr().unwrap();
    drop(disconnected);
    let absent = Native::new(
        &format!("http://{address}"),
        env::var("OFZ_TEST_NATIVE_KEY_FILE").unwrap().into(),
    )
    .unwrap();
    assert_eq!(
        read(
            database,
            &absent,
            owner,
            &uid,
            Action::WorkspaceMetadataRead
        )
        .await
        .unwrap_err()
        .code(),
        Code::Unavailable,
        "native loss never reuses an allowed decision"
    );
}

async fn verify_guest_maintenance(fixture: &ControlFixture, uid: &str, epoch: &str) {
    let mut context = controller_request(
        &fixture.database,
        &fixture.identities[0],
        Command::ReserveWorkspace(ReserveWorkspace::default()),
    )
    .await
    .context
    .unwrap();
    context.workspace_uid = uid.into();
    context.runtime_epoch = epoch.into();
    let mut request = AuthorizeGuestMaintenanceRequest {
        stream_receipt_id: String::new(),
        context: Some(context.clone()),
        workspace_uid: uid.into(),
        purpose: GuestMaintenancePurpose::Probe as i32,
        terminal_id: String::new(),
    };
    let mut probe_receipt = String::new();
    for (purpose, terminal_id, action) in [
        (
            GuestMaintenancePurpose::Probe,
            "",
            Action::WorkspaceMetadataRead,
        ),
        (
            GuestMaintenancePurpose::TerminalCleanup,
            "terminal-7",
            Action::TerminalControl,
        ),
    ] {
        let mut valid = request.clone();
        valid.purpose = purpose as i32;
        valid.terminal_id = terminal_id.into();
        let decision = fixture
            .service
            .authorize_guest_maintenance(rpc_as(valid, CONTROLLER_ID))
            .await
            .unwrap()
            .into_inner()
            .decision
            .unwrap();
        let state = fixture.database.state().await.unwrap();
        assert!(decision.allowed && !decision.revision.is_empty());
        assert!(
            decision.valid_until_unix_ms > state.now_ms
                && decision.valid_until_unix_ms <= state.now_ms + 2000
        );
        assert_eq!(decision.recovery_generation, state.recovery_generation);
        assert!(decision.effective_scope.is_none());
        let row = fixture
            .admin
            .pool
            .get()
            .await
            .unwrap()
            .query_one(
                "SELECT receipt,target_hash FROM ofz.audit WHERE id=$1",
                &[&Uuid::parse_str(&decision.audit_receipt_id).unwrap()],
            )
            .await
            .unwrap();
        let receipt: AuditReceipt = store::decode(row.get(0)).unwrap();
        if purpose == GuestMaintenancePurpose::Probe {
            probe_receipt = decision.audit_receipt_id.clone();
        }
        assert!(receipt.allowed);
        assert_eq!(receipt.resource, Some(policy::workspace(uid)));
        assert_eq!(receipt.action, action as i32);
        assert_eq!(receipt.workspace_uid, uid);
        assert_eq!(receipt.runtime_epoch, epoch);
        assert_eq!(receipt.workload_id, CONTROLLER_ID);
        assert_eq!(
            row.get::<_, Vec<u8>>(1),
            Sha256::digest(terminal_id.as_bytes()).to_vec()
        );
    }
    request.stream_receipt_id = probe_receipt;
    let mut runtime_context = context.clone();
    runtime_context.runtime_epoch.clear();
    runtime_context.deadline_unix_ms = fixture.database.state().await.unwrap().now_ms + 5000;
    let mut runtime_request = GetWorkspaceStateRequest {
        context: Some(runtime_context),
        workspace_uid: uid.into(),
        stream_receipt_id: String::new(),
    };
    let original = fixture
        .service
        .get_workspace_state(rpc_as(runtime_request.clone(), CONTROLLER_ID))
        .await
        .unwrap()
        .into_inner();
    runtime_request.stream_receipt_id = original.audit_receipt_id.clone();
    let warm_trace = Uuid::new_v4().to_string();
    request.context.as_mut().unwrap().trace_id = warm_trace.clone();
    runtime_request.context.as_mut().unwrap().trace_id = warm_trace.clone();
    let connection = fixture.admin.pool.get().await.unwrap();
    connection.batch_execute(&format!(
        "CREATE FUNCTION ofz.fixture_reject_runtime_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'warm observation attempted an audit write'; END $$; CREATE TRIGGER fixture_reject_runtime_audit AFTER INSERT ON ofz.audit FOR EACH ROW WHEN (NEW.receipt->>'trace_id'='{warm_trace}') EXECUTE FUNCTION ofz.fixture_reject_runtime_audit();"
    )).await.unwrap();
    for _ in 0..8 {
        let deadline = fixture.database.state().await.unwrap().now_ms + 5000;
        runtime_request.context.as_mut().unwrap().deadline_unix_ms = deadline;
        request.context.as_mut().unwrap().deadline_unix_ms = deadline;
        let state = fixture
            .service
            .get_workspace_state(rpc_as(runtime_request.clone(), CONTROLLER_ID))
            .await
            .expect("runtime observation must not require another audit write")
            .into_inner();
        assert_eq!(state.audit_receipt_id, original.audit_receipt_id);
        assert!(state.runtime_allowed);
        let probe = fixture
            .service
            .authorize_guest_maintenance(rpc_as(request.clone(), CONTROLLER_ID))
            .await
            .expect("health probe must not require another audit write")
            .into_inner()
            .decision
            .unwrap();
        assert_eq!(probe.audit_receipt_id, request.stream_receipt_id);
        assert!(probe.allowed);
    }
    connection.batch_execute("DROP TRIGGER fixture_reject_runtime_audit ON ofz.audit; DROP FUNCTION ofz.fixture_reject_runtime_audit();").await.unwrap();
    drop(connection);
    request.context.as_mut().unwrap().deadline_unix_ms =
        fixture.database.state().await.unwrap().now_ms + 5000;
    let mut cleanup = request.clone();
    cleanup.purpose = GuestMaintenancePurpose::TerminalCleanup as i32;
    cleanup.terminal_id = "terminal-7".into();
    assert_eq!(
        fixture
            .service
            .authorize_guest_maintenance(rpc_as(cleanup, CONTROLLER_ID))
            .await
            .unwrap_err()
            .code(),
        Code::InvalidArgument,
    );
    let mut mismatched = request.clone();
    mismatched.stream_receipt_id = original.audit_receipt_id;
    assert_eq!(
        fixture
            .service
            .authorize_guest_maintenance(rpc_as(mismatched, CONTROLLER_ID))
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied,
    );
    assert_eq!(
        fixture
            .service
            .authorize_guest_maintenance(rpc_as(request.clone(), BFF_ID))
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    let mut forged = request.clone();
    forged.context.as_mut().unwrap().actor = Some(Actor {
        identity: Some(Identity::HumanId(fixture.identities[0].0.clone())),
    });
    assert_eq!(
        fixture
            .service
            .authorize_guest_maintenance(rpc_as(forged, CONTROLLER_ID))
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    for (purpose, terminal_id) in [
        (GuestMaintenancePurpose::Unspecified as i32, ""),
        (999, ""),
        (GuestMaintenancePurpose::Probe as i32, "terminal-7"),
        (GuestMaintenancePurpose::TerminalCleanup as i32, ""),
        (GuestMaintenancePurpose::TerminalCleanup as i32, "../other"),
    ] {
        request.context.as_mut().unwrap().deadline_unix_ms =
            fixture.database.state().await.unwrap().now_ms + 5000;
        let mut invalid = request.clone();
        invalid.purpose = purpose;
        invalid.terminal_id = terminal_id.into();
        assert_eq!(
            fixture
                .service
                .authorize_guest_maintenance(rpc_as(invalid, CONTROLLER_ID))
                .await
                .unwrap_err()
                .code(),
            Code::InvalidArgument
        );
    }
    let mut missing_epoch = request.clone();
    missing_epoch
        .context
        .as_mut()
        .unwrap()
        .runtime_epoch
        .clear();
    assert_eq!(
        fixture
            .service
            .authorize_guest_maintenance(rpc_as(missing_epoch, CONTROLLER_ID))
            .await
            .unwrap_err()
            .code(),
        Code::InvalidArgument
    );
    let mut stale = request.clone();
    stale.context.as_mut().unwrap().runtime_epoch = Uuid::new_v4().to_string();
    assert_eq!(
        fixture
            .service
            .authorize_guest_maintenance(rpc_as(stale, CONTROLLER_ID))
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    let mut different_workspace = request.clone();
    different_workspace.workspace_uid = Uuid::new_v4().to_string();
    assert_eq!(
        fixture
            .service
            .authorize_guest_maintenance(rpc_as(different_workspace, CONTROLLER_ID))
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    let conn = fixture.admin.pool.get().await.unwrap();
    for (fence, unfence) in [
        (
            "UPDATE ofz.workspaces SET running=false WHERE uid=$1",
            "UPDATE ofz.workspaces SET running=true WHERE uid=$1",
        ),
        (
            "UPDATE ofz.workspaces SET state='quarantined' WHERE uid=$1",
            "UPDATE ofz.workspaces SET state='active' WHERE uid=$1",
        ),
    ] {
        let deadline = fixture.database.state().await.unwrap().now_ms + 5000;
        request.context.as_mut().unwrap().deadline_unix_ms = deadline;
        runtime_request.context.as_mut().unwrap().deadline_unix_ms = deadline;
        conn.execute(fence, &[&Uuid::parse_str(uid).unwrap()])
            .await
            .unwrap();
        let observed = fixture
            .service
            .get_workspace_state(rpc_as(runtime_request.clone(), CONTROLLER_ID))
            .await
            .unwrap()
            .into_inner();
        assert!(
            !observed.runtime_allowed,
            "receipt reuse cannot hide runtime fencing"
        );
        assert_eq!(
            fixture
                .service
                .authorize_guest_maintenance(rpc_as(request.clone(), CONTROLLER_ID))
                .await
                .unwrap_err()
                .code(),
            Code::PermissionDenied
        );
        conn.execute(unfence, &[&Uuid::parse_str(uid).unwrap()])
            .await
            .unwrap();
    }
    conn.batch_execute("UPDATE ofz.platform_state SET fenced=true")
        .await
        .unwrap();
    request.context.as_mut().unwrap().deadline_unix_ms =
        fixture.database.state().await.unwrap().now_ms + 5000;
    assert_eq!(
        fixture
            .service
            .authorize_guest_maintenance(rpc_as(request.clone(), CONTROLLER_ID))
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    conn.batch_execute("UPDATE ofz.platform_state SET fenced=false; UPDATE ofz.archive_state SET acknowledged_at_ms=ofz.now_ms()-61000").await.unwrap();
    request.context.as_mut().unwrap().deadline_unix_ms =
        fixture.database.state().await.unwrap().now_ms + 5000;
    assert_eq!(
        fixture
            .service
            .authorize_guest_maintenance(rpc_as(request, CONTROLLER_ID))
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    acknowledge_fixture_archive(&fixture.admin).await;
}

async fn viewer_content_check(
    fixture: &ControlFixture,
    viewer: &(String, String),
    uid: &str,
    epoch: &str,
    action: Action,
    target: &str,
    receipt: &str,
) -> Result<CheckResponse, tonic::Status> {
    let mut context = request(
        &fixture.database,
        viewer,
        Command::ReserveWorkspace(ReserveWorkspace::default()),
    )
    .await
    .context
    .unwrap();
    context.workspace_uid = uid.into();
    context.runtime_epoch = epoch.into();
    decision::check(
        &fixture.database,
        &fixture.native,
        BFF_ID,
        CheckRequest {
            context: Some(context),
            action: action as i32,
            resource: Some(policy::workspace(uid)),
            target: target.into(),
            stream_receipt_id: receipt.into(),
        },
    )
    .await
}

async fn verify_viewer_scope(fixture: &ControlFixture, uid: &str, epoch: &str) {
    acknowledge_fixture_archive(&fixture.admin).await;
    let owner = &fixture.identities[0];
    let human = policy::github_human_id("6").unwrap();
    execute(
        &fixture.database,
        &fixture.native,
        owner,
        Command::SetMembership(SetMembership {
            human_id: human.clone(),
            github_id: "6".into(),
            role: PlatformRole::Member as i32,
            enabled: true,
        }),
    )
    .await;
    let session = Uuid::new_v4();
    let now = fixture.admin.state().await.unwrap().now_ms as i64;
    let credential = URL_SAFE_NO_PAD.encode(Sha256::digest(session.as_bytes()));
    fixture.admin.pool.get().await.unwrap().execute(
        "INSERT INTO ofz.sessions(id,token_hash,human_id,identity_subject,identity_session,operation_id,expires_at_ms,idle_deadline_ms,mfa_at_ms,recovery_generation,github_id,establishment_fingerprint) VALUES($1,$2,$3,$4,$4,$5,$6,$6,$7,1,'6',$2)",
        &[&session,&Sha256::digest(credential.as_bytes()).to_vec(),&human,&Uuid::new_v4().to_string(),&Uuid::new_v4(),&(now+3_600_000),&now],
    ).await.unwrap();
    let viewer = &(human, session.to_string());
    let assignment = |scope| {
        Command::SetWorkspaceRole(SetWorkspaceRole {
            workspace_uid: uid.into(),
            human_id: viewer.0.clone(),
            role: WorkspaceRole::Viewer as i32,
            enabled: true,
            scope,
        })
    };
    let initial = request(&fixture.database, owner, assignment(None)).await;
    let mut connection = fixture.database.command_connection().await.unwrap();
    let (prepared, _) = prepare(
        &fixture.database,
        &fixture.native,
        &connection.client,
        BFF_ID,
        initial.clone(),
        &fixture.database.state().await.unwrap(),
    )
    .await
    .unwrap();
    persist(
        &mut connection.client,
        BFF_ID,
        &prepared,
        &fingerprint(&initial, BFF_ID).unwrap(),
    )
    .await
    .unwrap();
    let revision = fixture
        .native
        .apply(
            &initial.operation_id,
            initial.expected_version,
            &prepared.changes,
        )
        .await
        .unwrap();
    let pending = viewer_content_check(
        fixture,
        viewer,
        uid,
        epoch,
        Action::FilesObserve,
        "/workspace/src/main.rs",
        "",
    )
    .await
    .unwrap();
    assert!(
        !pending.allowed && pending.effective_scope.is_none(),
        "a native Viewer relation without its committed SQL role cannot grant unscoped content: {pending:?}"
    );
    finalize(&mut connection.client, &prepared, &revision, false)
        .await
        .unwrap();
    drop(connection);
    let metadata = read(
        &fixture.database,
        &fixture.native,
        viewer,
        uid,
        Action::WorkspaceMetadataRead,
    )
    .await
    .unwrap();
    assert!(metadata.allowed && metadata.effective_scope.is_none());
    assert_eq!(
        viewer_content_check(
            fixture,
            viewer,
            uid,
            epoch,
            Action::FilesObserve,
            "/workspace/src/main.rs",
            ""
        )
        .await
        .unwrap_err()
        .code(),
        Code::PermissionDenied,
        "a Viewer without an approved scope must remain metadata-only on a running workspace"
    );
    let scope = ObservationScope {
        connector_operations: vec![],
        connector_runtime_epoch: String::new(),
        file_roots: vec!["/workspace/src".into()],
        thread_ids: vec!["thread-approved".into()],
        terminal_ids: vec!["terminal-approved".into()],
        browser_screenshot: false,
        max_bytes: 1024,
        max_items: 20,
    };
    execute(
        &fixture.database,
        &fixture.native,
        owner,
        assignment(Some(scope.clone())),
    )
    .await;
    let allowed = viewer_content_check(
        fixture,
        viewer,
        uid,
        epoch,
        Action::FilesObserve,
        "/workspace/src/main.rs",
        "",
    )
    .await
    .unwrap();
    assert!(allowed.allowed);
    assert_eq!(allowed.effective_scope, Some(scope.clone()));
    for (action, target) in [
        (Action::FilesObserve, "/workspace/private"),
        (Action::FilesObserve, "/workspace/src-other/main.rs"),
        (Action::FilesObserve, "/workspace/src/../private"),
        (Action::FilesObserve, "/workspace/src/.env"),
        (Action::FilesObserve, "/workspace/src/.ssh/key"),
        (Action::CodexObserve, "thread-other"),
        (Action::TerminalObserve, "terminal-other"),
        (Action::BrowserObserve, "screenshot"),
    ] {
        assert_eq!(
            viewer_content_check(fixture, viewer, uid, epoch, action, target, "")
                .await
                .unwrap_err()
                .code(),
            Code::PermissionDenied,
            "unapproved {action:?} {target}"
        );
    }
    for (action, target) in [
        (Action::CodexObserve, "thread-approved"),
        (Action::TerminalObserve, "terminal-approved"),
        (Action::BrowserObserve, "status"),
    ] {
        let decision = viewer_content_check(fixture, viewer, uid, epoch, action, target, "")
            .await
            .unwrap();
        assert!(decision.allowed);
        assert_eq!(decision.effective_scope, Some(scope.clone()));
    }
    for action in [
        Action::FilesWrite,
        Action::TerminalControl,
        Action::CodexControl,
        Action::BrowserControl,
        Action::PreviewAccess,
    ] {
        assert!(
            !viewer_content_check(
                fixture,
                viewer,
                uid,
                epoch,
                action,
                "/workspace/src/main.rs",
                ""
            )
            .await
            .unwrap()
            .allowed,
            "Viewer scope granted {action:?}"
        );
    }
    for (role, enabled) in [
        (WorkspaceRole::Developer, true),
        (WorkspaceRole::Viewer, false),
    ] {
        let invalid = request(
            &fixture.database,
            owner,
            Command::SetWorkspaceRole(SetWorkspaceRole {
                workspace_uid: uid.into(),
                human_id: viewer.0.clone(),
                role: role as i32,
                enabled,
                scope: Some(scope.clone()),
            }),
        )
        .await;
        assert_eq!(
            commands::execute(&fixture.database, &fixture.native, BFF_ID, invalid)
                .await
                .unwrap_err()
                .code(),
            Code::InvalidArgument
        );
    }
    let mut narrower = scope.clone();
    narrower.file_roots = vec!["/workspace/narrow".into()];
    narrower.thread_ids.clear();
    narrower.terminal_ids.clear();
    let narrowing = request(&fixture.database, owner, assignment(Some(narrower.clone()))).await;
    let mut connection = fixture.database.command_connection().await.unwrap();
    let (prepared, _) = prepare(
        &fixture.database,
        &fixture.native,
        &connection.client,
        BFF_ID,
        narrowing.clone(),
        &fixture.database.state().await.unwrap(),
    )
    .await
    .unwrap();
    let mut audit_connection = fixture.admin.pool.get().await.unwrap();
    let audit_lock = audit_connection.transaction().await.unwrap();
    audit_lock
        .batch_execute("LOCK TABLE ofz.audit IN SHARE MODE")
        .await
        .unwrap();
    let mut context = request(
        &fixture.database,
        viewer,
        Command::ReserveWorkspace(ReserveWorkspace::default()),
    )
    .await
    .context
    .unwrap();
    context.workspace_uid = uid.into();
    context.runtime_epoch = epoch.into();
    let trace_id = context.trace_id.clone();
    let database = fixture.database.clone();
    let native = fixture.native.clone();
    let mut in_flight = tokio::spawn(async move {
        decision::check(
            &database,
            &native,
            BFF_ID,
            CheckRequest {
                resource: Some(policy::workspace(&context.workspace_uid)),
                context: Some(context),
                action: Action::FilesObserve as i32,
                target: "/workspace/src/main.rs".into(),
                stream_receipt_id: String::new(),
            },
        )
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        loop {
            if in_flight.is_finished() {
                panic!("content decision ended before its audit write: {:?}", (&mut in_flight).await);
            }
            let blocked: bool = audit_lock.query_one(
                "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE relation='ofz.audit'::regclass AND mode='RowExclusiveLock' AND NOT granted)", &[],
            ).await.unwrap().get(0);
            if blocked { break; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }).await.expect("the content decision must reach its audit write before narrowing");
    persist(
        &mut connection.client,
        BFF_ID,
        &prepared,
        &fingerprint(&narrowing, BFF_ID).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        fixture.database.state().await.unwrap().version,
        narrowing.expected_version
    );
    audit_lock.commit().await.unwrap();
    assert_eq!(
        in_flight.await.unwrap().unwrap_err().code(),
        Code::PermissionDenied,
        "a cached Viewer decision cannot survive restrictive intent committed during its audit write"
    );
    let receipt: AuditReceipt = store::decode(audit_connection.query_one(
        "SELECT receipt FROM ofz.audit WHERE receipt->>'trace_id'=$1 ORDER BY sequence DESC LIMIT 1", &[&trace_id],
    ).await.unwrap().get(0)).unwrap();
    assert!(
        !receipt.allowed,
        "late disclosure denial must leave an immutable denial receipt"
    );
    assert_eq!(
        viewer_content_check(
            fixture,
            viewer,
            uid,
            epoch,
            Action::FilesObserve,
            "/workspace/src/main.rs",
            &allowed.audit_receipt_id
        )
        .await
        .unwrap_err()
        .code(),
        Code::PermissionDenied,
        "a durable narrowing intent must immediately deny the previous target before native finalization"
    );
    let revision = fixture
        .native
        .apply(
            &narrowing.operation_id,
            narrowing.expected_version,
            &prepared.changes,
        )
        .await
        .unwrap();
    finalize(&mut connection.client, &prepared, &revision, false)
        .await
        .unwrap();
    drop(connection);
    assert_eq!(
        viewer_content_check(
            fixture,
            viewer,
            uid,
            epoch,
            Action::FilesObserve,
            "/workspace/src/main.rs",
            &allowed.audit_receipt_id
        )
        .await
        .unwrap_err()
        .code(),
        Code::PermissionDenied,
        "an existing stream retained a removed Viewer target"
    );
    let current = viewer_content_check(
        fixture,
        viewer,
        uid,
        epoch,
        Action::FilesObserve,
        "/workspace/narrow/a",
        "",
    )
    .await
    .unwrap();
    assert!(current.allowed);
    assert_eq!(current.effective_scope, Some(narrower.clone()));
    let roster = workspace_roster(&fixture.service, &fixture.database, owner, uid).await;
    assert_eq!(
        roster
            .into_iter()
            .find(|entry| entry.subject_id == viewer.0)
            .unwrap()
            .scope,
        Some(narrower)
    );
    execute(&fixture.database, &fixture.native, owner, assignment(None)).await;
    assert_eq!(
        viewer_content_check(
            fixture,
            viewer,
            uid,
            epoch,
            Action::FilesObserve,
            "/workspace/narrow/a",
            &current.audit_receipt_id
        )
        .await
        .unwrap_err()
        .code(),
        Code::PermissionDenied,
        "removing a Viewer scope retained content authority"
    );
    assert!(
        read(
            &fixture.database,
            &fixture.native,
            viewer,
            uid,
            Action::WorkspaceMetadataRead
        )
        .await
        .unwrap()
        .allowed
    );
    assert!(
        read(
            &fixture.database,
            &fixture.native,
            owner,
            uid,
            Action::FilesObserve
        )
        .await
        .unwrap()
        .effective_scope
        .is_none()
    );
    acknowledge_fixture_archive(&fixture.admin).await;
}

async fn verify_runtime_transfer(fixture: &ControlFixture, workspace: &WorkspaceFixture) -> String {
    let ControlFixture {
        admin,
        database,
        native,
        identities,
        service,
        ..
    } = fixture;
    let owner = &fixture.identities[0];
    let uid = workspace.uid.clone();
    let runtime_epoch = Uuid::new_v4().to_string();
    execute(
        database,
        native,
        owner,
        Command::SetWorkspaceRuntime(SetWorkspaceRuntime {
            workspace_uid: uid.clone(),
            runtime_epoch: runtime_epoch.clone(),
            running: true,
        }),
    )
    .await;
    let rotation = request(
        database,
        owner,
        Command::SetWorkspaceRuntime(SetWorkspaceRuntime {
            workspace_uid: uid.clone(),
            runtime_epoch: Uuid::new_v4().to_string(),
            running: true,
        }),
    )
    .await;
    assert_eq!(
        commands::execute(database, native, BFF_ID, rotation)
            .await
            .unwrap_err()
            .code(),
        Code::Aborted,
        "a live epoch cannot be replaced without stopping it"
    );
    assert_eq!(
        admin
            .pool
            .get()
            .await
            .unwrap()
            .query_one(
                "SELECT runtime_epoch FROM ofz.workspaces WHERE uid=$1 AND running",
                &[&Uuid::parse_str(&uid).unwrap()]
            )
            .await
            .unwrap()
            .get::<_, Uuid>(0)
            .to_string(),
        runtime_epoch
    );
    execute(
        database,
        native,
        owner,
        Command::SetWorkspaceRuntime(SetWorkspaceRuntime {
            workspace_uid: uid.clone(),
            runtime_epoch: runtime_epoch.clone(),
            running: true,
        }),
    )
    .await;
    assert!(
        read(database, native, owner, &uid, Action::FilesObserve)
            .await
            .unwrap()
            .allowed,
        "live owner can observe files before transfer"
    );
    let live_projection = runtime_state(service, database, owner, &uid).await;
    assert!(live_projection.running && live_projection.runtime_allowed);
    assert_eq!(live_projection.runtime_epoch, runtime_epoch);
    verify_viewer_scope(fixture, &uid, &runtime_epoch).await;
    verify_guest_maintenance(fixture, &uid, &runtime_epoch).await;
    let client = admin.pool.get().await.unwrap();
    let owner_session = Uuid::parse_str(&owner.1).unwrap();
    let short_idle:i64 = client.query_one("UPDATE ofz.sessions SET idle_deadline_ms=ofz.now_ms()+60000 WHERE id=$1 RETURNING idle_deadline_ms", &[&owner_session]).await.unwrap().get(0);
    assert!(
        read(database, native, owner, &uid, Action::FilesObserve)
            .await
            .unwrap()
            .allowed
    );
    assert_eq!(
        client
            .query_one(
                "SELECT idle_deadline_ms FROM ofz.sessions WHERE id=$1",
                &[&owner_session]
            )
            .await
            .unwrap()
            .get::<_, i64>(0),
        short_idle,
        "observation never extends idle timeout"
    );
    let control = read(database, native, owner, &uid, Action::FilesWrite)
        .await
        .unwrap();
    assert!(control.allowed);
    assert!(
        client
            .query_one(
                "SELECT idle_deadline_ms FROM ofz.sessions WHERE id=$1",
                &[&owner_session]
            )
            .await
            .unwrap()
            .get::<_, i64>(0)
            > short_idle + 1_000_000,
        "qualifying control extends idle timeout"
    );
    let mut held = admin.pool.get().await.unwrap();
    let lock = held.transaction().await.unwrap();
    lock.query_one(
        "SELECT id FROM ofz.sessions WHERE id=$1 FOR UPDATE",
        &[&owner_session],
    )
    .await
    .unwrap();
    let activity_client = database.pool.get().await.unwrap();
    let activity = AuditReceipt {
        actor: Some(Actor {
            identity: Some(Identity::HumanId(owner.0.clone())),
        }),
        session_id: owner.1.clone(),
        action: Action::FilesWrite as i32,
        allowed: true,
        ..Default::default()
    };
    let recorded = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        store::record_activity(&**activity_client, &activity),
    )
    .await;
    lock.rollback().await.unwrap();
    assert!(
        matches!(recorded, Ok(Ok(true))),
        "fresh activity must validate without waiting to rewrite the session: {recorded:?}"
    );
    drop(activity_client);
    let short_idle:i64 = client.query_one("UPDATE ofz.sessions SET idle_deadline_ms=ofz.now_ms()+60000 WHERE id=$1 RETURNING idle_deadline_ms", &[&owner_session]).await.unwrap().get(0);
    let mut held = admin.pool.get().await.unwrap();
    let lock = held.transaction().await.unwrap();
    lock.query_one(
        "SELECT id FROM ofz.sessions WHERE id=$1 FOR UPDATE",
        &[&owner_session],
    )
    .await
    .unwrap();
    let concurrent_activity = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        futures::future::join_all((0..8).map(|_| async {
            let client = database.pool.get().await.unwrap();
            store::record_activity(&**client, &activity).await
        })),
    )
    .await;
    lock.rollback().await.unwrap();
    assert!(
        matches!(&concurrent_activity, Ok(results) if results.iter().all(|result| matches!(result, Ok(true)))),
        "parallel activity must validate without queuing behind an idle refresh: {concurrent_activity:?}"
    );
    assert_eq!(
        client
            .query_one(
                "SELECT idle_deadline_ms FROM ofz.sessions WHERE id=$1",
                &[&owner_session],
            )
            .await
            .unwrap()
            .get::<_, i64>(0),
        short_idle,
        "a busy session row skips only the optional idle refresh"
    );
    let mut context = request(
        database,
        owner,
        Command::ReserveWorkspace(ReserveWorkspace::default()),
    )
    .await
    .context
    .unwrap();
    context.workspace_uid = uid.clone();
    context.runtime_epoch = client
        .query_one(
            "SELECT runtime_epoch FROM ofz.workspaces WHERE uid=$1",
            &[&Uuid::parse_str(&uid).unwrap()],
        )
        .await
        .unwrap()
        .get::<_, Uuid>(0)
        .to_string();
    assert!(
        decision::check(
            database,
            native,
            BFF_ID,
            CheckRequest {
                context: Some(context),
                action: Action::FilesWrite as i32,
                resource: Some(policy::workspace(&uid)),
                target: String::new(),
                stream_receipt_id: control.audit_receipt_id,
            }
        )
        .await
        .unwrap()
        .allowed
    );
    assert_eq!(
        client
            .query_one(
                "SELECT idle_deadline_ms FROM ofz.sessions WHERE id=$1",
                &[&owner_session]
            )
            .await
            .unwrap()
            .get::<_, i64>(0),
        short_idle,
        "stream rechecks never extend idle timeout"
    );
    drop(client);
    let mut transfer = request(
        database,
        owner,
        Command::TransferWorkspace(TransferWorkspace {
            workspace_uid: uid.clone(),
            next_owner_id: identities[1].0.clone(),
        }),
    )
    .await;
    transfer.client_request_hash = vec![0x48; 32];
    let transfer_context = transfer.context.clone();
    let transfer_operation = transfer.operation_id.clone();
    let mut connection = database.command_connection().await.unwrap();
    let (prepared, _) = prepare(
        database,
        native,
        &connection.client,
        BFF_ID,
        transfer.clone(),
        &database.state().await.unwrap(),
    )
    .await
    .unwrap();
    let entered = std::sync::Arc::new(tokio::sync::Notify::new());
    let resume = std::sync::Arc::new(tokio::sync::Notify::new());
    let paused = service
        .clone()
        .with_read_barrier(entered.clone(), resume.clone());
    let mut runtime_context = controller_request(
        database,
        owner,
        Command::ReserveWorkspace(ReserveWorkspace::default()),
    )
    .await
    .context
    .unwrap();
    runtime_context.workspace_uid = uid.clone();
    let runtime_uid = uid.clone();
    let in_flight = tokio::spawn(async move {
        paused
            .get_workspace_state(rpc_as(
                GetWorkspaceStateRequest {
                    stream_receipt_id: String::new(),
                    context: Some(runtime_context),
                    workspace_uid: runtime_uid,
                },
                CONTROLLER_ID,
            ))
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), entered.notified())
        .await
        .unwrap();
    persist(
        &mut connection.client,
        BFF_ID,
        &prepared,
        &fingerprint(&transfer, BFF_ID).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        database.state().await.unwrap().version,
        transfer.expected_version,
        "restrictive intent is durable before policy version advances"
    );
    resume.notify_one();
    assert_eq!(
        in_flight.await.unwrap().unwrap_err().code(),
        Code::Aborted,
        "a workspace read cannot disclose cached authority after restrictive intent commits"
    );
    assert!(
        !read(database, native, owner, &uid, Action::FilesObserve)
            .await
            .unwrap()
            .allowed,
        "intent fences the guest before native write"
    );
    native
        .apply(
            &transfer.operation_id,
            transfer.expected_version,
            &prepared.changes,
        )
        .await
        .unwrap();
    drop(connection);
    assert!(
        !read(database, native, &identities[1], &uid, Action::FilesObserve)
            .await
            .unwrap()
            .allowed,
        "new owner cannot access retained content after native write and before SQL recovery"
    );
    commands::recover(database, native).await.unwrap();
    let recovered = commands::execute(database, native, BFF_ID, transfer)
        .await
        .unwrap();
    assert!(recovered.recovered_revision);
    let mut replay = crate::proto::GetCommandRequest {
        context: transfer_context,
        operation_id: transfer_operation,
        client_request_hash: vec![0x48; 32],
    };
    replay.context.as_mut().unwrap().deadline_unix_ms =
        database.state().await.unwrap().now_ms + 2000;
    assert_eq!(
        commands::get(database, native, BFF_ID, replay.clone())
            .await
            .unwrap()
            .receipt
            .unwrap(),
        recovered
    );
    replay.client_request_hash = vec![0x49; 32];
    assert_eq!(
        commands::get(database, native, BFF_ID, replay)
            .await
            .unwrap_err()
            .code(),
        tonic::Code::AlreadyExists
    );

    assert!(
        !read(database, native, owner, &uid, Action::WorkspaceMetadataRead)
            .await
            .unwrap()
            .allowed
    );
    assert!(
        read(
            database,
            native,
            &identities[1],
            &uid,
            Action::WorkspaceMetadataRead
        )
        .await
        .unwrap()
        .allowed
    );
    assert!(
        !read(database, native, &identities[1], &uid, Action::FilesObserve)
            .await
            .unwrap()
            .allowed,
        "transfer quarantines retained content until clean recovery"
    );
    runtime_epoch
}

async fn verify_audit_write_pressure(
    admin: &Database,
    database: &Database,
    owner: &(String, String),
    uid: &str,
) {
    let context = request(
        database,
        owner,
        Command::ReserveWorkspace(ReserveWorkspace::default()),
    )
    .await
    .context
    .unwrap();
    let receipts: Vec<_> = (0..12)
        .map(|_| {
            store::receipt(
                &context,
                CONTROLLER_ID,
                policy::workspace(uid),
                Action::WorkspaceMetadataRead,
                true,
                "",
                "audit write pressure",
            )
        })
        .collect();
    let warm = futures::future::join_all((0..12).map(|_| database.pool.get())).await;
    assert!(warm.iter().all(Result::is_ok));
    drop(warm);
    let mut held = admin.pool.get().await.unwrap();
    let lock = held.transaction().await.unwrap();
    lock.batch_execute(
        "CREATE FUNCTION ofz.fixture_block_audit_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.receipt->>'reason'='audit write pressure' THEN PERFORM pg_advisory_xact_lock(726635522922); END IF; RETURN NEW; END $$;
         CREATE CONSTRAINT TRIGGER fixture_block_audit_commit AFTER INSERT ON ofz.audit DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ofz.fixture_block_audit_commit();",
    )
    .await
    .unwrap();
    lock.commit().await.unwrap();
    let lock = held.transaction().await.unwrap();
    lock.batch_execute("SELECT pg_advisory_xact_lock(726635522922)")
        .await
        .unwrap();
    let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(13));
    let writers: Vec<_> = receipts
        .iter()
        .map(|receipt| {
            let database = database.clone();
            let receipt = receipt.clone();
            let barrier = barrier.clone();
            tokio::spawn(async move {
                barrier.wait().await;
                database.audit(&receipt, "").await
            })
        })
        .collect();
    barrier.wait().await;
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let read = tokio::time::timeout(std::time::Duration::from_millis(300), database.state()).await;
    let pending = writers.iter().all(|writer| !writer.is_finished());
    lock.rollback().await.unwrap();
    for writer in writers {
        writer.await.unwrap().unwrap();
    }
    assert!(
        pending,
        "durable audit writes must wait for the database commit"
    );
    assert!(
        matches!(read, Ok(Ok(_))),
        "audit writes starved fresh authorization reads: {read:?}"
    );
    let ids: Vec<_> = receipts
        .iter()
        .map(|receipt| Uuid::parse_str(&receipt.id).unwrap())
        .collect();
    let client = admin.pool.get().await.unwrap();
    client.batch_execute("DROP TRIGGER fixture_block_audit_commit ON ofz.audit; DROP FUNCTION ofz.fixture_block_audit_commit();").await.unwrap();
    let committed = client.query_one("SELECT count(*)::integer,count(DISTINCT pg_xact_commit_timestamp(xmin))::integer FROM ofz.audit WHERE id=ANY($1)", &[&ids]).await.unwrap();
    assert_eq!(committed.get::<_, i32>(0), 12);
    assert!(
        (1..=2).contains(&committed.get::<_, i32>(1)),
        "concurrent audit receipts must share durable commits"
    );
    let good = store::receipt(
        &context,
        CONTROLLER_ID,
        policy::workspace(uid),
        Action::WorkspaceMetadataRead,
        true,
        "",
        "audit failure isolation",
    );
    let mut expired = store::receipt(
        &context,
        CONTROLLER_ID,
        policy::workspace(uid),
        Action::FilesWrite,
        true,
        "",
        "audit failure isolation",
    );
    expired.session_id = Uuid::new_v4().to_string();
    let (accepted, rejected) =
        tokio::join!(database.audit(&good, ""), database.audit(&expired, ""));
    assert_eq!(accepted.unwrap(), good.id);
    assert_eq!(rejected.unwrap_err().code(), Code::Unauthenticated);
    let count: i64 = client
        .query_one(
            "SELECT count(*) FROM ofz.audit WHERE id=ANY($1)",
            &[&vec![
                Uuid::parse_str(&good.id).unwrap(),
                Uuid::parse_str(&expired.id).unwrap(),
            ]],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(
        count, 1,
        "one invalid audit must roll back only its own receipt"
    );
}

async fn verify_offboarding(fixture: &ControlFixture, workspace: &WorkspaceFixture) {
    let ControlFixture {
        admin,
        database,
        native,
        identities,
        ..
    } = fixture;
    let uid = workspace.uid.clone();
    let revoked = &identities[3];
    let credential = URL_SAFE_NO_PAD.encode(Sha256::digest(
        Uuid::parse_str(&revoked.1).unwrap().as_bytes(),
    ));
    let revoke = RevokeSessionRequest {
        credential: credential.clone(),
        operation_id: Uuid::new_v4().to_string(),
        origin: "https://proompteng.ai".into(),
    };
    let original = crate::sessions::revoke(database, native, BFF_ID, revoke.clone())
        .await
        .unwrap();
    assert_eq!(
        admin
            .pool
            .get()
            .await
            .unwrap()
            .query_one(
                "SELECT (receipt->>'action')::integer FROM ofz.audit WHERE id=$1",
                &[&Uuid::parse_str(&original.audit_receipt_id).unwrap()]
            )
            .await
            .unwrap()
            .get::<_, i32>(0),
        Action::SessionRevoke as i32,
        "logout receipt uses the catalogued revocation action"
    );
    let retried = crate::sessions::revoke(database, native, BFF_ID, revoke.clone())
        .await
        .unwrap();
    assert_eq!(
        original, retried,
        "lost logout response has one immutable receipt"
    );
    assert_eq!(
        crate::sessions::inspect(
            database,
            native,
            BFF_ID,
            InspectSessionRequest {
                session_id: credential
            }
        )
        .await
        .unwrap_err()
        .code(),
        Code::Unauthenticated
    );
    let other = URL_SAFE_NO_PAD.encode(Sha256::digest(
        Uuid::parse_str(&identities[1].1).unwrap().as_bytes(),
    ));
    assert_eq!(
        crate::sessions::revoke(
            database,
            native,
            BFF_ID,
            RevokeSessionRequest {
                credential: other,
                ..revoke
            }
        )
        .await
        .unwrap_err()
        .code(),
        Code::AlreadyExists,
        "logout operation ID cannot be reused for another session"
    );
    assert!(
        native
            .check(&[crate::native::Check::new(
                "workspace",
                &uid,
                "control_guest",
                "human",
                &identities[3].0
            )])
            .await
            .unwrap()
            .0,
        "the emergency relationship is still effective before offboarding"
    );
    execute(
        database,
        native,
        &identities[1],
        Command::SetMembership(SetMembership {
            human_id: identities[3].0.clone(),
            github_id: "4".into(),
            role: PlatformRole::Member as i32,
            enabled: false,
        }),
    )
    .await;
    assert_eq!(
        admin
            .pool
            .get()
            .await
            .unwrap()
            .query_one(
                "SELECT count(*) FROM ofz.emergency_access WHERE human_id=$1",
                &[&identities[3].0]
            )
            .await
            .unwrap()
            .get::<_, i64>(0),
        0,
        "offboarding removes emergency authority from the durable projection"
    );
    execute(
        database,
        native,
        &identities[1],
        Command::SetMembership(SetMembership {
            human_id: identities[3].0.clone(),
            github_id: "4".into(),
            role: PlatformRole::Member as i32,
            enabled: true,
        }),
    )
    .await;
    assert!(
        !native
            .check(&[crate::native::Check::new(
                "workspace",
                &uid,
                "control_guest",
                "human",
                &identities[3].0
            )])
            .await
            .unwrap()
            .0,
        "readmission must not restore the old emergency relationship"
    );
}

async fn verify_journal_loss(fixture: &ControlFixture, workspace: &WorkspaceFixture) {
    let ControlFixture {
        admin,
        database,
        native,
        identities,
        ..
    } = fixture;
    let uid = workspace.uid.clone();
    let conn = admin.pool.get().await.unwrap();
    let counts=conn.query_one("SELECT (SELECT count(*) FROM ofz.commands),(SELECT count(*) FROM ofz.audit),(SELECT count(*) FROM ofz.audit_outbox)", &[]).await.map_err(sql_error).unwrap();
    assert_eq!(counts.get::<_, i64>(1), counts.get::<_, i64>(2));
    let no_pending: i64 = conn
        .query_one("SELECT count(*) FROM ofz.commands WHERE state=1", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(no_pending, 0);
    drop(conn);
    let bad_config: Config = env::var("OFZ_TEST_DSN").unwrap().parse().unwrap();
    let bad_tls = MakeRustlsConnect::new(
        ClientConfig::builder()
            .with_root_certificates(RootCertStore::empty())
            .with_no_client_auth(),
    );
    let untrusted = Database::new(bad_config, bad_tls).unwrap();
    assert_eq!(
        untrusted.verify_schema().await.unwrap_err().code(),
        Code::Unavailable,
        "database CA verification cannot be bypassed"
    );
    let mut lost_journal = request(
        database,
        &identities[1],
        Command::ReserveWorkspace(ReserveWorkspace::default()),
    )
    .await
    .context
    .unwrap();
    lost_journal.workspace_uid = uid.clone();
    database.pool.close();
    assert_eq!(
        decision::check(
            database,
            native,
            BFF_ID,
            CheckRequest {
                context: Some(lost_journal),
                resource: Some(policy::workspace(&uid)),
                action: Action::WorkspaceMetadataRead as i32,
                target: String::new(),
                stream_receipt_id: String::new()
            }
        )
        .await
        .unwrap_err()
        .code(),
        Code::Unavailable,
        "journal loss fails closed"
    );
    println!(
        "PASS: TLS database, roles, durable crash recovery at three boundaries, replay, concurrent quota, parent revocation, proof-bound grant storage, archive fencing; {} commands / {} immutable receipts",
        counts.get::<_, i64>(0),
        counts.get::<_, i64>(1)
    );
}
