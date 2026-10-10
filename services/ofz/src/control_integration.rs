use std::env;

use rustls::{ClientConfig, RootCertStore};
use sha2::{Digest, Sha256};
use tokio_postgres::Config;
use tokio_postgres_rustls::MakeRustlsConnect;
use tonic::Code;
use uuid::Uuid;

use crate::{
    commands::{self, *},
    decision,
    native::{Native, Relationship, Update},
    policy::{self, BFF_ID, CONTROLLER_ID, OFZ_ID},
    proto::{actor::Identity, execute_command_request::Command, *},
    store::{Database, sql_error},
};

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
        conn.execute("INSERT INTO ofz.sessions(id,token_hash,human_id,identity_subject,identity_session,operation_id,expires_at_ms,idle_deadline_ms,mfa_at_ms,recovery_generation) VALUES($1,$2,$3,$4,$4,$5,$6,$6,$7,1)", &[&session,&Sha256::digest(session.as_bytes()).to_vec(),&human,&Uuid::new_v4().to_string(),&Uuid::new_v4(),&((now+3_600_000) as i64),&(now as i64)]).await.unwrap();
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
    if action == Action::FilesObserve {
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
    let revoke_admin = request(
        &database,
        owner,
        Command::SetMembership(SetMembership {
            human_id: identities[1].0.clone(),
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
        expires_at_unix_ms: database.state().await.unwrap().now_ms + 30_000,
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
    let expiry = database.state().await.unwrap().now_ms + 60_000;
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
    // Archive loss fences new data access; durable revocation remains available.
    admin
        .pool
        .get()
        .await
        .unwrap()
        .execute("UPDATE ofz.archive_state SET acknowledged_at_ms=0", &[])
        .await
        .unwrap();
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
            runtime_epoch,
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
