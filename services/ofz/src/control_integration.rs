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
    api_config.user("ofz_api").password("ofz-test-only");
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
    native
        .apply(&Uuid::new_v4().to_string(), 0, &relationships)
        .await
        .unwrap();
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
        command: Some(command),
    }
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

#[tokio::test]
#[ignore = "requires the disposable TLS PostgreSQL and SpiceDB from test-control.sh"]
async fn control_integration_durability_authority_and_quota() {
    let (admin, database, native, identities) = setup().await;
    let owner = &identities[0];
    let service = Service::new(
        database.clone(),
        native.clone(),
        Issuer::new(
            "https://identity.invalid/realms/tengri".into(),
            "tengri-bff".into(),
        )
        .unwrap(),
    );
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
    let recovered = sessions::establish(&database, &native, &issuer, BFF_ID, retry_request.clone())
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
        sessions::establish(&database, &native, &issuer, BFF_ID, collision)
            .await
            .unwrap_err()
            .code(),
        Code::AlreadyExists
    );
    let mut collision = retry_request.clone();
    collision.credential = URL_SAFE_NO_PAD.encode([9_u8; 32]);
    assert_eq!(
        sessions::establish(&database, &native, &issuer, BFF_ID, collision)
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
        sessions::establish(&database, &native, &issuer, BFF_ID, retry_request)
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
        &database,
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
            &database,
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
    let reservation = Uuid::new_v4().to_string();
    let first = request(
        &database,
        owner,
        Command::ReserveWorkspace(ReserveWorkspace {
            reservation_id: reservation.clone(),
            home_bytes: HOME_BYTES,
        }),
    )
    .await;
    let receipt = commands::execute(&database, &native, BFF_ID, first.clone())
        .await
        .unwrap();
    let replay = commands::execute(&database, &native, BFF_ID, first.clone())
        .await
        .unwrap();
    assert_eq!(receipt, replay);
    let mut conflict = first.clone();
    conflict.reason = "different command under same operation ID".into();
    assert_eq!(
        commands::execute(&database, &native, BFF_ID, conflict)
            .await
            .unwrap_err()
            .code(),
        Code::AlreadyExists
    );
    let mut stale = first.clone();
    stale.operation_id = Uuid::new_v4().to_string();
    assert_eq!(
        commands::execute(&database, &native, BFF_ID, stale)
            .await
            .unwrap_err()
            .code(),
        Code::Aborted
    );
    let uid = Uuid::new_v4().to_string();
    let mut enroll = request(
        &database,
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
    assert_eq!(
        commands::execute(&database, &native, BFF_ID, enroll.clone())
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
        commands::execute(&database, &native, CONTROLLER_ID, enroll.clone())
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
    acknowledge_fixture_archive(&admin).await;
    commands::execute(&database, &native, CONTROLLER_ID, enroll)
        .await
        .unwrap();
    assert!(
        read(
            &database,
            &native,
            owner,
            &uid,
            Action::WorkspaceMetadataRead
        )
        .await
        .unwrap()
        .allowed
    );
    assert!(
        !read(
            &database,
            &native,
            &identities[1],
            &uid,
            Action::WorkspaceMetadataRead
        )
        .await
        .unwrap()
        .allowed,
        "platform administration grants no content access"
    );
    let open = read(
        &database,
        &native,
        owner,
        &uid,
        Action::WorkspaceMetadataRead,
    )
    .await
    .unwrap();
    let mut stream_context = request(
        &database,
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
        decision::check(&database, &native, BFF_ID, stream.clone())
            .await
            .unwrap()
            .allowed
    );
    let mut wrong_origin = stream.clone();
    wrong_origin.context.as_mut().unwrap().origin = "https://other.example".into();
    assert_eq!(
        decision::check(&database, &native, BFF_ID, wrong_origin)
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    let mut wrong_epoch = stream.clone();
    wrong_epoch.context.as_mut().unwrap().runtime_epoch = Uuid::new_v4().to_string();
    assert_eq!(
        decision::check(&database, &native, BFF_ID, wrong_epoch)
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    execute(
        &database,
        &native,
        owner,
        Command::SetWorkspaceRole(SetWorkspaceRole {
            workspace_uid: uid.clone(),
            human_id: identities[2].0.clone(),
            role: WorkspaceRole::Viewer as i32,
            enabled: true,
        }),
    )
    .await;
    assert!(
        read(
            &database,
            &native,
            &identities[2],
            &uid,
            Action::WorkspaceMetadataRead
        )
        .await
        .unwrap()
        .allowed
    );
    assert!(
        !read(&database, &native, &identities[2], &uid, Action::FilesWrite)
            .await
            .unwrap()
            .allowed
    );
    let service = Service::new(
        database.clone(),
        native.clone(),
        Issuer::new(
            "https://auth.fixture.invalid/realms/tengri".into(),
            "tengri-bff".into(),
        )
        .unwrap(),
    );
    let roster_context = |identity: &(String, String)| {
        let mut context = stream.context.clone().unwrap();
        context.actor = Some(Actor {
            identity: Some(Identity::HumanId(identity.0.clone())),
        });
        context.session_id = identity.1.clone();
        context.trace_id = Uuid::new_v4().to_string();
        context
    };
    let roster = service
        .list_access(rpc(ListAccessRequest {
            context: Some(roster_context(owner)),
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
            context: Some(roster_context(&identities[2])),
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
            context: Some(roster_context(owner)),
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
            context: Some(roster_context(&identities[2])),
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
        &database,
        &native,
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
            context: Some(roster_context(&identities[1])),
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
            &database,
            &native,
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
            &database,
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
            &database,
            &native,
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
        &database,
        owner,
        Command::SetMembership(SetMembership {
            human_id: identities[1].0.clone(),
            github_id: "999".into(),
            role: PlatformRole::Member as i32,
            enabled: true,
        }),
    )
    .await;
    assert_eq!(
        commands::execute(&database, &native, BFF_ID, mismatch)
            .await
            .unwrap_err()
            .code(),
        Code::InvalidArgument,
        "a numeric GitHub identity cannot be rebound to another human hash"
    );
    let revoke_admin = request(
        &database,
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
        commands::execute(&database, &native, BFF_ID, revoke_admin)
            .await
            .unwrap_err()
            .code(),
        Code::FailedPrecondition
    );
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
        &database,
        owner,
        Command::ReserveWorkspace(ReserveWorkspace {
            reservation_id: Uuid::new_v4().to_string(),
            home_bytes: HOME_BYTES,
        }),
    )
    .await;
    let b = request(
        &database,
        owner,
        Command::ReserveWorkspace(ReserveWorkspace {
            reservation_id: Uuid::new_v4().to_string(),
            home_bytes: HOME_BYTES,
        }),
    )
    .await;
    let (a, b) = tokio::join!(
        commands::execute(&database, &native, BFF_ID, a),
        commands::execute(&database, &native, BFF_ID, b)
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
        &database,
        owner,
        Command::ReserveWorkspace(ReserveWorkspace {
            reservation_id: Uuid::new_v4().to_string(),
            home_bytes: HOME_BYTES,
        }),
    )
    .await;
    assert_eq!(
        commands::execute(&database, &native, BFF_ID, over)
            .await
            .unwrap_err()
            .code(),
        Code::ResourceExhausted
    );
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
        &database,
        &native,
        owner,
        Command::EmergencyAccess(emergency.clone()),
    )
    .await;
    assert!(
        !read(
            &database,
            &native,
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
        !workspace_roster(&service, &database, owner, &uid)
            .await
            .iter()
            .any(|entry| entry.role == "emergency")
    );
    emergency.custodian_approval_id = approval.operation_id;
    let same = request(
        &database,
        owner,
        Command::EmergencyAccess(emergency.clone()),
    )
    .await;
    assert_eq!(
        commands::execute(&database, &native, BFF_ID, same)
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    execute(
        &database,
        &native,
        &identities[1],
        Command::EmergencyAccess(emergency.clone()),
    )
    .await;
    let entries = workspace_roster(&service, &database, owner, &uid).await;
    let active = entries
        .iter()
        .find(|entry| entry.role == "emergency")
        .expect("the effective emergency grant must be visible to its owner");
    assert_eq!(active.subject_id, identities[3].0);
    assert_eq!(active.expires_at_unix_ms, emergency.expires_at_unix_ms);
    assert!(
        read(
            &database,
            &native,
            &identities[3],
            &uid,
            Action::WorkspaceMetadataRead
        )
        .await
        .unwrap()
        .allowed
    );
    let consumed = request(
        &database,
        &identities[1],
        Command::EmergencyAccess(emergency),
    )
    .await;
    assert_eq!(
        commands::execute(&database, &native, BFF_ID, consumed)
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
    });
    execute(&database, &native, owner, repeat_role.clone()).await;
    execute(&database, &native, owner, repeat_role).await;
    let controller_administration = request(
        &database,
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
        commands::execute(&database, &native, CONTROLLER_ID, controller_administration)
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
        });
        let pending = request(&database, owner, command).await;
        let operation = pending.operation_id.clone();
        let expected = pending.expected_version;
        let mut connection = database.command_connection().await.unwrap();
        let state = database.state().await.unwrap();
        let (prepared, _) = prepare(
            &database,
            &native,
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
        let recovered = commands::execute(&database, &native, BFF_ID, pending)
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
    let grant_id = Uuid::new_v4().to_string();
    let agent_id = Uuid::new_v4().to_string();
    let expiry = database.state().await.unwrap().now_ms + 600_000;
    let grant_command = request(
        &database,
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
    let grant_receipt = commands::execute(&database, &native, BFF_ID, grant_command.clone())
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
        commands::execute(&database, &native, BFF_ID, grant_command)
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
    assert!(
        decision::check(&database, &native, BFF_ID, delegated.clone())
            .await
            .unwrap()
            .allowed
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
        decision::check(&database, &native, BFF_ID, delegated.clone())
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
        &database,
        &native,
        owner,
        Command::RevokeGrant(RevokeGrant {
            grant_id: grant_id.clone(),
        }),
    )
    .await;
    assert_eq!(
        decision::check(&database, &native, BFF_ID, delegated.clone())
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    // A recovered earlier grant command must not resurrect after its successor revocation.
    let mut connection = database.command_connection().await.unwrap();
    reconcile(&database, &native, &mut connection.client)
        .await
        .unwrap();
    drop(connection);
    assert!(decision::grant(&database, &grant_id).await.unwrap().revoked);
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
    execute(&database, &native, owner, c).await;
    delegated.context.as_mut().unwrap().grant_id = second.clone();
    assert!(
        decision::check(&database, &native, BFF_ID, delegated.clone())
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
        !decision::check(&database, &native, BFF_ID, delegated.clone())
            .await
            .unwrap()
            .allowed
    );
    // Current parent membership revocation invalidates both human and delegated access.
    execute(
        &database,
        &native,
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
            &database,
            &native,
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
    // A live exporter cannot hide an old pending row or a stale durable checkpoint.
    acknowledge_fixture_archive(&admin).await;
    let context = request(
        &database,
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
        read(
            &database,
            &native,
            owner,
            &uid,
            Action::WorkspaceMetadataRead
        )
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
        read(
            &database,
            &native,
            owner,
            &uid,
            Action::WorkspaceMetadataRead
        )
        .await
        .unwrap()
        .allowed
    );
    drop(conn);
    acknowledge_fixture_archive(&admin).await;
    let checked = std::sync::Arc::new(tokio::sync::Notify::new());
    let resume = std::sync::Arc::new(tokio::sync::Notify::new());
    let paused_native = native
        .clone()
        .with_check_barrier(checked.clone(), resume.clone());
    let (in_flight, ()) = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        tokio::join!(
            read(
                &database,
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
    acknowledge_fixture_archive(&admin).await;
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
                &database,
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
        read(
            &database,
            &native,
            owner,
            &uid,
            Action::WorkspaceMetadataRead
        )
        .await
        .unwrap_err()
        .code(),
        Code::Unavailable
    );
    execute(
        &database,
        &native,
        owner,
        Command::RevokeGrant(RevokeGrant { grant_id: second }),
    )
    .await;
    assert_eq!(
        decision::workload(
            &native,
            "spiffe://proompteng.ai/ns/tengri/sa/nanoagent",
            Action::PolicyCheck
        )
        .await
        .unwrap_err()
        .code(),
        Code::Unauthenticated
    );
    assert_eq!(
        decision::workload(&native, OFZ_ID, Action::PolicyCheck)
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
            &database,
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
    let runtime_epoch = Uuid::new_v4().to_string();
    execute(
        &database,
        &native,
        owner,
        Command::SetWorkspaceRuntime(SetWorkspaceRuntime {
            workspace_uid: uid.clone(),
            runtime_epoch: runtime_epoch.clone(),
            running: true,
        }),
    )
    .await;
    let rotation = request(
        &database,
        owner,
        Command::SetWorkspaceRuntime(SetWorkspaceRuntime {
            workspace_uid: uid.clone(),
            runtime_epoch: Uuid::new_v4().to_string(),
            running: true,
        }),
    )
    .await;
    assert_eq!(
        commands::execute(&database, &native, BFF_ID, rotation)
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
        &database,
        &native,
        owner,
        Command::SetWorkspaceRuntime(SetWorkspaceRuntime {
            workspace_uid: uid.clone(),
            runtime_epoch: runtime_epoch.clone(),
            running: true,
        }),
    )
    .await;
    assert!(
        read(&database, &native, owner, &uid, Action::FilesObserve)
            .await
            .unwrap()
            .allowed,
        "live owner can observe files before transfer"
    );
    let client = admin.pool.get().await.unwrap();
    let owner_session = Uuid::parse_str(&owner.1).unwrap();
    let short_idle:i64 = client.query_one("UPDATE ofz.sessions SET idle_deadline_ms=ofz.now_ms()+60000 WHERE id=$1 RETURNING idle_deadline_ms", &[&owner_session]).await.unwrap().get(0);
    assert!(
        read(&database, &native, owner, &uid, Action::FilesObserve)
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
    let control = read(&database, &native, owner, &uid, Action::FilesWrite)
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
    let short_idle:i64 = client.query_one("UPDATE ofz.sessions SET idle_deadline_ms=ofz.now_ms()+60000 WHERE id=$1 RETURNING idle_deadline_ms", &[&owner_session]).await.unwrap().get(0);
    let mut context = request(
        &database,
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
            &database,
            &native,
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
    let transfer = request(
        &database,
        owner,
        Command::TransferWorkspace(TransferWorkspace {
            workspace_uid: uid.clone(),
            next_owner_id: identities[1].0.clone(),
        }),
    )
    .await;
    let mut connection = database.command_connection().await.unwrap();
    let (prepared, _) = prepare(
        &database,
        &native,
        &connection.client,
        BFF_ID,
        transfer.clone(),
        &database.state().await.unwrap(),
    )
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
    assert!(
        !read(&database, &native, owner, &uid, Action::FilesObserve)
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
        !read(
            &database,
            &native,
            &identities[1],
            &uid,
            Action::FilesObserve
        )
        .await
        .unwrap()
        .allowed,
        "new owner cannot access retained content after native write and before SQL recovery"
    );
    commands::recover(&database, &native).await.unwrap();
    let recovered = commands::execute(&database, &native, BFF_ID, transfer)
        .await
        .unwrap();
    assert!(recovered.recovered_revision);
    assert!(
        !read(
            &database,
            &native,
            owner,
            &uid,
            Action::WorkspaceMetadataRead
        )
        .await
        .unwrap()
        .allowed
    );
    assert!(
        read(
            &database,
            &native,
            &identities[1],
            &uid,
            Action::WorkspaceMetadataRead
        )
        .await
        .unwrap()
        .allowed
    );
    assert!(
        !read(
            &database,
            &native,
            &identities[1],
            &uid,
            Action::FilesObserve
        )
        .await
        .unwrap()
        .allowed,
        "transfer quarantines retained content until clean recovery"
    );
    let revoked = &identities[3];
    let credential = URL_SAFE_NO_PAD.encode(Sha256::digest(
        Uuid::parse_str(&revoked.1).unwrap().as_bytes(),
    ));
    let revoke = RevokeSessionRequest {
        credential: credential.clone(),
        operation_id: Uuid::new_v4().to_string(),
        origin: "https://proompteng.ai".into(),
    };
    let original = crate::sessions::revoke(&database, &native, BFF_ID, revoke.clone())
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
    let retried = crate::sessions::revoke(&database, &native, BFF_ID, revoke.clone())
        .await
        .unwrap();
    assert_eq!(
        original, retried,
        "lost logout response has one immutable receipt"
    );
    assert_eq!(
        crate::sessions::inspect(
            &database,
            &native,
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
            &database,
            &native,
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
        &database,
        &native,
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
        &database,
        &native,
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
        &database,
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
            &database,
            &native,
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
