use super::*;
use crate::{auth::Principal, authz::WorkspaceAuthorization, identity::WorkloadIdentity};
use proto::{
    CompleteWorkspaceRemoval, EnrollWorkspace, RemoveWorkspace, ReserveWorkspace,
    SetWorkspaceRuntime,
};

async fn human_command(
    client: &Client,
    context: &RequestContext,
    command: Command,
) -> CommandReceipt {
    let state = client.state().await.unwrap();
    let mut context = context.clone();
    context.deadline_unix_ms = now_ms().unwrap() + 5000;
    client
        .rpc
        .clone()
        .execute_command(request(
            ExecuteCommandRequest {
                context: Some(context),
                operation_id: uuid::Uuid::new_v4().to_string(),
                expected_version: state.version,
                reason: "isolated runtime wire qualification".into(),
                command: Some(command),
                ..Default::default()
            },
            COMMAND_TIMEOUT,
        ))
        .await
        .unwrap()
        .into_inner()
        .receipt
        .unwrap()
}

async fn controller_metadata_roundtrip(
    authorization: WorkspaceAuthorization,
    identity: WorkloadIdentity,
    principal: &Principal,
    reservation_id: &str,
    uid: &str,
) {
    use crate::{
        activity::ActivityTracker,
        auth::{Authenticator, deterministic_agent_id, signed_fixture_request},
        crd::{MicroVM, MicroVMArchitecture, MicroVMDesiredState, MicroVMResources, MicroVMSpec},
        gateway::PreviewOrigin,
        grpc::{
            ControlPlane, ControlPlaneConfig,
            proto::{
                CreateAgentRequest, ListAgentsRequest,
                micro_vm_control_plane_server::MicroVmControlPlane,
            },
        },
    };
    use kube::client::Body;
    use std::sync::Arc;

    let database = Arc::new(crate::control::Database::shared_fixture().await);
    let (service, mut kube) = tower_test::mock::pair::<http::Request<Body>, http::Response<Body>>();
    let client = kube::Client::new(service, "tengri");
    let control = ControlPlane::new(
        client.clone(),
        ControlPlaneConfig {
            identity,
            authorization,
            namespace: "tengri".into(),
            default_image: format!("registry.example/nanoagent@sha256:{}", "b".repeat(64)),
            architecture: MicroVMArchitecture::Amd64,
            database: database.clone(),
            auth: Authenticator::fixture(database, "https://proompteng.ai".into()),
            public_url: "https://tengri.proompteng.ai".into(),
            preview_origin: PreviewOrigin::parse(
                "https://tengri-{session}.proompteng.ai".into(),
                "https://tengri.proompteng.ai".into(),
            )
            .unwrap(),
        },
        ActivityTracker::new(client, "tengri".into()),
    )
    .unwrap();
    let id = deterministic_agent_id(&principal.owner_hash, reservation_id);
    let mut agent = MicroVM::new(
        &id,
        MicroVMSpec {
            reservation_id: reservation_id.into(),
            runtime_epoch: String::new(),
            policy_version: 0,
            display_name: "Wire workspace".into(),
            owner_hash: principal.owner_hash.clone(),
            desired_state: MicroVMDesiredState::Sleeping,
            image: format!("registry.example/nanoagent@sha256:{}", "b".repeat(64)),
            architecture: MicroVMArchitecture::Amd64,
            resources: MicroVMResources::default(),
            power: Default::default(),
            created_at: chrono::Utc::now().to_rfc3339(),
            idle_deadline: chrono::Utc::now().to_rfc3339(),
            slot: None,
        },
    );
    agent.metadata.uid = Some(uid.into());
    let mut inaccessible = agent.clone();
    inaccessible.metadata.name = Some("unregistered-workspace".into());
    inaccessible.metadata.uid = Some(uuid::Uuid::new_v4().to_string());
    let mut submission = principal.clone();
    submission.context.workspace_uid.clear();
    submission.context.runtime_epoch.clear();
    submission.context.deadline_unix_ms = now_ms().unwrap() + 5000;
    let request = signed_fixture_request(
        ListAgentsRequest {},
        &submission,
        "/proompteng.runtime.v1.MicroVMControlPlane/ListAgents",
    );
    let listing = tokio::spawn({
        let control = control.clone();
        async move { control.list_agents(request).await }
    });
    let (request, response) = kube.next_request().await.unwrap();
    assert_eq!(request.method(), http::Method::GET);
    response.send_response(
        http::Response::builder()
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::to_vec(&serde_json::json!({
                    "apiVersion": "runtime.proompteng.ai/v1alpha1", "kind": "MicroVMList",
                    "metadata": {}, "items": [inaccessible, agent.clone()]
                }))
                .unwrap(),
            ))
            .unwrap(),
    );
    let listed = listing.await.unwrap().unwrap().into_inner();
    assert_eq!(listed.agents.len(), 1);
    assert_eq!(listed.agents[0].id, id);

    submission.context.deadline_unix_ms = now_ms().unwrap() + 5000;
    let create = CreateAgentRequest {
        display_name: agent.spec.display_name.clone(),
        reservation_id: reservation_id.into(),
    };
    let request = signed_fixture_request(
        create.clone(),
        &submission,
        "/proompteng.runtime.v1.MicroVMControlPlane/CreateAgent",
    );
    let creation = tokio::spawn({
        let control = control.clone();
        async move { control.create_agent(request).await }
    });
    let (request, response) = kube.next_request().await.unwrap();
    assert!(request.uri().path().ends_with(&id));
    tokio::time::sleep(Duration::from_millis(5100)).await;
    assert!(submission.context.deadline_unix_ms < now_ms().unwrap());
    let agent_response = || {
        http::Response::builder()
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&agent).unwrap()))
            .unwrap()
    };
    response.send_response(agent_response());
    let (_, response) = kube.next_request().await.unwrap();
    response.send_response(agent_response());
    assert_eq!(creation.await.unwrap().unwrap().into_inner().id, id);
    let expired = signed_fixture_request(
        create,
        &submission,
        "/proompteng.runtime.v1.MicroVMControlPlane/CreateAgent",
    );
    assert_eq!(
        control.create_agent(expired).await.unwrap_err().code(),
        tonic::Code::Unauthenticated,
    );
}

#[tokio::test]
#[ignore = "requires real Ofz, PostgreSQL, SpiceDB, SPIFFE and a passkey session; run Ofz identity fixture"]
async fn ofz_wire_runtime_lifecycle_and_authority() {
    assert_eq!(std::env::var("TENGRI_OFZ_WIRE_FIXTURE").as_deref(), Ok("1"));
    crate::install_rustls_crypto_provider().unwrap();
    let endpoint = std::env::var("SPIFFE_ENDPOINT_SOCKET").unwrap();
    let identity = WorkloadIdentity::from_endpoint(
        endpoint.clone(),
        "proompteng.ai".parse().unwrap(),
        "tengri",
    )
    .await
    .unwrap();
    let bff_identity = WorkloadIdentity::from_endpoint_with_id(
        endpoint,
        "proompteng.ai".parse().unwrap(),
        "spiffe://proompteng.ai/ns/proompteng/sa/proompteng"
            .parse()
            .unwrap(),
    )
    .await
    .unwrap();
    let target = std::env::var("OFZ_GRPC_ENDPOINT").unwrap();
    let controller = Client::new(&target, &identity).unwrap();
    let bff = Client::new(&target, &bff_identity).unwrap();
    let state = controller.state().await.unwrap();
    assert!(!state.fenced && state.archive_healthy);
    let human = std::env::var("TENGRI_OFZ_FIXTURE_HUMAN").unwrap();
    let mut context = RequestContext {
        actor: Some(Actor {
            identity: Some(Identity::HumanId(human.clone())),
        }),
        session_id: std::env::var("TENGRI_OFZ_FIXTURE_SESSION").unwrap(),
        trace_id: uuid::Uuid::new_v4().to_string(),
        deadline_unix_ms: now_ms().unwrap() + 5000,
        origin: "https://proompteng.ai".into(),
        contract_version: 1,
        ..Default::default()
    };
    let reservation_id = uuid::Uuid::new_v4().to_string();
    human_command(
        &bff,
        &context,
        Command::ReserveWorkspace(ReserveWorkspace {
            reservation_id: reservation_id.clone(),
            home_bytes: 32 * 1024 * 1024 * 1024,
        }),
    )
    .await;
    let mut principal = Principal {
        owner_hash: human.clone(),
        context: context.clone(),
        recovery_generation: state.recovery_generation,
        action: Action::WorkspaceCreate,
    };
    let reserved = controller
        .reservation(&principal, &reservation_id)
        .await
        .unwrap();
    assert_eq!(reserved.state, "reserved");
    assert!(reserved.workspace_uid.is_empty());
    assert!(bff.reservation(&principal, &reservation_id).await.is_err());
    let uid = uuid::Uuid::new_v4().to_string();
    let home = uuid::Uuid::new_v4().to_string();
    let enroll_id = operation_id(&uid, "enroll");
    let enroll = EnrollWorkspace {
        workspace_uid: uid.clone(),
        owner_id: human.clone(),
        home_uid: home.clone(),
        home_bytes: 32 * 1024 * 1024 * 1024,
        reservation_id: reservation_id.clone(),
    };
    let enrolled = controller
        .command(&enroll_id, Command::EnrollWorkspace(enroll.clone()))
        .await
        .unwrap();
    assert_eq!(
        controller
            .command(&enroll_id, Command::EnrollWorkspace(enroll.clone()))
            .await
            .unwrap(),
        enrolled
    );
    let mut changed = enroll;
    changed.home_uid = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        controller
            .command(&enroll_id, Command::EnrollWorkspace(changed))
            .await
            .unwrap_err()
            .code(),
        tonic::Code::AlreadyExists
    );
    let projection = controller.workspace_state(&uid).await.unwrap();
    assert_eq!(projection.home_uid, home);
    assert_eq!(projection.owner_id, human);
    assert_eq!(projection.reservation_id, reservation_id);
    assert!(!projection.runtime_allowed && !projection.running);
    assert!(bff.workspace_state(&uid).await.is_err());
    principal.context.deadline_unix_ms = now_ms().unwrap() + 5000;
    let reserved = controller
        .reservation(&principal, &reservation_id)
        .await
        .unwrap();
    assert_eq!(reserved.state, "enrolled");
    assert_eq!(reserved.workspace_uid, uid);
    Box::pin(controller_metadata_roundtrip(
        WorkspaceAuthorization::new(controller.clone()),
        identity.clone(),
        &principal,
        &reservation_id,
        &uid,
    ))
    .await;
    let epoch = uuid::Uuid::new_v4().to_string();
    context.workspace_uid = uid.clone();
    context.runtime_epoch = epoch.clone();
    let started = human_command(
        &bff,
        &context,
        Command::SetWorkspaceRuntime(SetWorkspaceRuntime {
            workspace_uid: uid.clone(),
            runtime_epoch: epoch.clone(),
            running: true,
        }),
    )
    .await;
    let projection = controller.workspace_state(&uid).await.unwrap();
    assert!(projection.runtime_allowed && projection.running);
    assert_eq!(projection.runtime_epoch, epoch);
    assert_eq!(projection.policy_version, started.version);
    assert_eq!(
        started.runtime_intent.as_ref().unwrap().runtime_epoch,
        epoch
    );
    principal.context = context.clone();
    principal.context.deadline_unix_ms = now_ms().unwrap() + 5000;
    principal.action = Action::FilesObserve;
    let authorization = WorkspaceAuthorization::new(controller.clone());
    let access = authorization.access(&principal, &uid, &epoch, "").unwrap();
    access.require().await.unwrap();
    let database = std::sync::Arc::new(crate::control::Database::shared_fixture().await);
    let tickets =
        crate::tickets::TicketStore::new("https://tengri.proompteng.ai".into(), database.clone())
            .unwrap();
    let mut preview_principal = principal.clone();
    preview_principal.action = Action::PreviewAccess;
    authorization
        .access(&preview_principal, &uid, &context.runtime_epoch, "")
        .unwrap()
        .require()
        .await
        .unwrap();
    let issued = tickets
        .issue_preview(&preview_principal, "wire-workspace", 3000, "/", "")
        .await
        .unwrap();
    database.connection().await.unwrap().execute("UPDATE tengri.tickets SET payload=jsonb_set(payload,'{principal,context,deadline_unix_ms}','0') WHERE workspace_uid=$1", &[&uuid::Uuid::parse_str(&uid).unwrap()]).await.unwrap();
    let preview = tickets.consume_preview(&issued.token).await.unwrap();
    authorization
        .access(&preview.principal, &uid, &context.runtime_epoch, "")
        .unwrap()
        .require()
        .await
        .unwrap();
    database.connection().await.unwrap().execute("UPDATE tengri.previews SET payload=jsonb_set(payload,'{principal,context,deadline_unix_ms}','0') WHERE workspace_uid=$1", &[&uuid::Uuid::parse_str(&uid).unwrap()]).await.unwrap();
    let reloaded = tickets
        .preview_session(&preview.id, &preview.token)
        .await
        .unwrap();
    let preview_access = authorization
        .access(&reloaded.principal, &uid, &context.runtime_epoch, "")
        .unwrap();
    preview_access.require().await.unwrap();
    let mut expired_submission = preview_principal;
    expired_submission.context.deadline_unix_ms = now_ms().unwrap() - 1;
    assert!(
        authorization
            .access(&expired_submission, &uid, &context.runtime_epoch, "")
            .unwrap()
            .require()
            .await
            .is_err()
    );
    let mut previous_generation = principal.clone();
    previous_generation.recovery_generation += 1;
    assert!(
        authorization
            .access(&previous_generation, &uid, &epoch, "")
            .unwrap()
            .require()
            .await
            .is_err()
    );
    use futures::StreamExt;
    let source = futures::stream::once(async { Ok::<(), tonic::Status>(()) })
        .chain(futures::stream::pending());
    let mut guarded = access.guard_stream(source);
    assert!(guarded.next().await.unwrap().is_ok());
    let stop = Command::SetWorkspaceRuntime(SetWorkspaceRuntime {
        workspace_uid: uid.clone(),
        runtime_epoch: epoch,
        running: false,
    });
    controller
        .command(&operation_id(&uid, "wire-stop"), stop)
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(3), guarded.next())
            .await
            .expect("stream must close within three seconds after a committed stop")
            .unwrap()
            .is_err()
    );
    context.deadline_unix_ms = now_ms().unwrap() + 5000;
    let recovered = bff
        .rpc
        .clone()
        .get_command(request(
            GetCommandRequest {
                context: Some(context.clone()),
                operation_id: started.operation_id.clone(),
                ..Default::default()
            },
            COMMAND_TIMEOUT,
        ))
        .await
        .unwrap()
        .into_inner()
        .receipt
        .unwrap();
    assert_eq!(
        recovered, started,
        "original runtime intent remains immutable after stop"
    );
    assert!(
        !controller
            .workspace_state(&uid)
            .await
            .unwrap()
            .runtime_allowed
    );
    assert!(
        access.require().await.is_err(),
        "old access cannot survive a committed runtime stop"
    );
    assert!(
        preview_access.require().await.is_err(),
        "a live preview must lose Ofz authority after stop"
    );
    tickets.remove_agent(&uid).await.unwrap();
    human_command(
        &bff,
        &context,
        Command::RemoveWorkspace(RemoveWorkspace {
            workspace_uid: uid.clone(),
        }),
    )
    .await;
    assert_eq!(
        controller.workspace_state(&uid).await.unwrap().state,
        "removing"
    );
    let complete = Command::CompleteWorkspaceRemoval(CompleteWorkspaceRemoval {
        workspace_uid: uid.clone(),
        home_uid: home,
        reservation_id,
    });
    let completed = controller
        .command(&operation_id(&uid, "removed"), complete.clone())
        .await
        .unwrap();
    assert_eq!(
        controller
            .command(&operation_id(&uid, "removed"), complete)
            .await
            .unwrap(),
        completed
    );
    assert_eq!(
        controller.workspace_state(&uid).await.unwrap().state,
        "removed"
    );
    context.workspace_uid.clear();
    context.runtime_epoch.clear();
    let cancelled = uuid::Uuid::new_v4().to_string();
    human_command(
        &bff,
        &context,
        Command::ReserveWorkspace(ReserveWorkspace {
            reservation_id: cancelled.clone(),
            home_bytes: 32 * 1024 * 1024 * 1024,
        }),
    )
    .await;
    let cancellation = Command::ReleaseReservation(proto::ReleaseReservation {
        reservation_id: cancelled.clone(),
    });
    let cancellation_id = operation_id(&cancelled, "cancel");
    let receipt = controller
        .command(&cancellation_id, cancellation.clone())
        .await
        .unwrap();
    assert_eq!(
        controller
            .command(&cancellation_id, cancellation)
            .await
            .unwrap(),
        receipt
    );
    assert_eq!(
        controller
            .command(
                &operation_id(&cancelled, "enroll"),
                Command::EnrollWorkspace(EnrollWorkspace {
                    workspace_uid: uuid::Uuid::new_v4().to_string(),
                    owner_id: human,
                    home_uid: uuid::Uuid::new_v4().to_string(),
                    home_bytes: 32 * 1024 * 1024 * 1024,
                    reservation_id: cancelled,
                })
            )
            .await
            .unwrap_err()
            .code(),
        tonic::Code::FailedPrecondition
    );
    println!(
        "PASS: real controller Ofz mTLS, passkey session, reservation, enrollment, immutable runtime receipt recovery, collision denial, versioned runtime intent, SQL preview redemption, generation denial, bounded stream revocation, exact-home quota release and cancellation fencing"
    );
}
