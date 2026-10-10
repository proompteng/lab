use std::{path::Path, sync::Arc, time::Duration};

use futures::future::join_all;
use sha2::{Digest, Sha256};
use tonic::Code;
use uuid::Uuid;

use crate::{
    auth::{Authenticator, Principal, signed_fixture_request},
    control::Database,
    grpc::proto::GetAgentRequest,
    ofz::proto::Action,
    tickets::TicketStore,
};

async fn fixture() -> (Arc<Database>, TicketStore, TicketStore) {
    let first = Arc::new(Database::shared_fixture().await);
    let second = Arc::new(Database::shared_fixture().await);
    first
        .connection()
        .await
        .unwrap()
        .batch_execute("DELETE FROM tengri.tickets; DELETE FROM tengri.previews")
        .await
        .unwrap();
    let a = TicketStore::new("https://tengri.proompteng.ai".into(), first.clone()).unwrap();
    let b = TicketStore::new("https://tengri.proompteng.ai".into(), second).unwrap();
    (first, a, b)
}

fn principal(action: Action) -> Principal {
    Principal::fixture(&"a".repeat(64), &Uuid::new_v4().to_string(), action)
}

#[tokio::test]
#[ignore = "requires disposable shared TLS PostgreSQL from test-runtime.sh"]
async fn runtime_shared_state_backend_reconnection_does_not_forget_an_accepted_nonce() {
    let (database, _, _) = fixture().await;
    let other = Database::shared_fixture().await;
    let nonce = Sha256::digest(Uuid::new_v4().as_bytes()).to_vec();
    let deadline = (crate::ofz::now_ms().unwrap() + 5000) as i64;
    database.consume_nonce(&nonce, deadline).await.unwrap();
    let victim = database.connection().await.unwrap();
    let pid: i32 = victim
        .query_one("SELECT pg_backend_pid()", &[])
        .await
        .unwrap()
        .get(0);
    let killed: bool = other
        .connection()
        .await
        .unwrap()
        .query_one("SELECT pg_terminate_backend($1)", &[&pid])
        .await
        .unwrap()
        .get(0);
    assert!(killed);
    assert!(victim.query_one("SELECT 1", &[]).await.is_err());
    drop(victim);
    assert_eq!(
        database
            .consume_nonce(&nonce, deadline)
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    let fresh = Sha256::digest(Uuid::new_v4().as_bytes()).to_vec();
    database
        .consume_nonce(&fresh, (crate::ofz::now_ms().unwrap() + 5000) as i64)
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "requires disposable shared TLS PostgreSQL from test-runtime.sh"]
async fn runtime_shared_state_one_use_redemption_is_atomic_across_replicas() {
    let (database, a, b) = fixture().await;
    let owner = principal(Action::TerminalControl);
    let ticket = a
        .issue_terminal(&owner, "agent", "terminal-1")
        .await
        .unwrap();
    let row = database
        .connection()
        .await
        .unwrap()
        .query_one("SELECT token_hash,payload FROM tengri.tickets", &[])
        .await
        .unwrap();
    assert_eq!(
        row.get::<_, Vec<u8>>(0),
        Sha256::digest(ticket.token.as_bytes()).to_vec()
    );
    assert!(
        !row.get::<_, serde_json::Value>(1)
            .to_string()
            .contains(&ticket.token)
    );
    let attempts = join_all((0..12).map(|index| {
        let store = if index % 2 == 0 { a.clone() } else { b.clone() };
        let token = ticket.token.clone();
        async move { store.consume(&token).await }
    }))
    .await;
    assert_eq!(attempts.iter().filter(|result| result.is_ok()).count(), 1);
    for result in attempts.into_iter().filter(Result::is_err) {
        assert_eq!(result.unwrap_err().code(), Code::Unauthenticated);
    }
    assert_eq!(b.stats().await.unwrap().pending, 0);
    assert_eq!(
        a.consume("malformed").await.unwrap_err().code(),
        Code::Unauthenticated
    );
    let pending = a
        .issue_terminal(&owner, "agent", "terminal-2")
        .await
        .unwrap();
    let mut connections = Vec::new();
    for _ in 0..12 {
        connections.push(database.connection().await.unwrap());
    }
    let started = tokio::time::Instant::now();
    assert_eq!(
        a.consume(&pending.token).await.unwrap_err().code(),
        Code::Unavailable
    );
    assert!(started.elapsed() < Duration::from_secs(1));
    drop(connections);
    assert!(b.consume(&pending.token).await.is_ok());
    assert_eq!(
        a.consume(&pending.token).await.unwrap_err().code(),
        Code::Unauthenticated
    );
}

#[tokio::test]
#[ignore = "requires disposable shared TLS PostgreSQL from test-runtime.sh"]
async fn runtime_shared_state_preview_rotation_revocation_and_identity_isolation() {
    let (database, a, b) = fixture().await;
    let owner = principal(Action::EditorOpen);
    let first = a.issue_editor(&owner, "agent", "window-1").await.unwrap();
    let session = b.consume_preview(&first.token).await.unwrap();
    assert_eq!(
        a.consume_preview(&first.token).await.unwrap_err().code(),
        Code::Unauthenticated
    );
    assert_eq!(
        a.preview_session(&session.id, &session.token)
            .await
            .unwrap()
            .principal
            .context
            .session_id,
        owner.context.session_id
    );
    let stored = database
        .connection()
        .await
        .unwrap()
        .query_one(
            "SELECT payload FROM tengri.previews WHERE id=$1",
            &[&session.id],
        )
        .await
        .unwrap()
        .get::<_, serde_json::Value>(0)
        .to_string();
    assert!(!stored.contains(&first.token));
    assert!(!stored.contains(&session.token));
    let second = b.issue_editor(&owner, "agent", "window-1").await.unwrap();
    assert_eq!(second.id, first.id);
    let replacement = a.consume_preview(&second.token).await.unwrap();
    assert_ne!(replacement.token, session.token);
    assert_eq!(
        b.preview_session(&session.id, &session.token)
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    a.revoke_preview_lease(&owner, "agent", &first.id, &first.token)
        .await
        .unwrap();
    assert!(
        b.preview_session(&replacement.id, &replacement.token)
            .await
            .is_ok()
    );
    for field in ["session", "workspace", "owner"] {
        let mut foreign = owner.clone();
        match field {
            "session" => foreign.context.session_id = Uuid::new_v4().to_string(),
            "workspace" => foreign.context.workspace_uid = Uuid::new_v4().to_string(),
            _ => {
                foreign.owner_hash = "b".repeat(64);
                foreign.context.actor.as_mut().unwrap().identity = Some(
                    crate::ofz::proto::actor::Identity::HumanId(foreign.owner_hash.clone()),
                );
            }
        }
        b.revoke_preview_lease(&foreign, "agent", &second.id, &second.token)
            .await
            .unwrap();
        assert!(
            a.preview_session(&replacement.id, &replacement.token)
                .await
                .is_ok(),
            "foreign {field}"
        );
        let foreign_ticket = a.issue_editor(&foreign, "agent", "window-1").await.unwrap();
        assert_ne!(foreign_ticket.id, first.id);
    }
    b.revoke_preview_lease(&owner, "agent", &second.id, &second.token)
        .await
        .unwrap();
    assert_eq!(
        a.preview_session(&replacement.id, &replacement.token)
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    let pending = a.issue_editor(&owner, "agent", "window-2").await.unwrap();
    b.revoke_desktop_previews(&owner).await.unwrap();
    assert_eq!(
        a.consume_preview(&pending.token).await.unwrap_err().code(),
        Code::Unauthenticated
    );
    let mut next_epoch = owner.clone();
    next_epoch.context.runtime_epoch = Uuid::new_v4().to_string();
    assert_ne!(
        a.issue_editor(&next_epoch, "agent", "window-1")
            .await
            .unwrap()
            .id,
        first.id
    );
}

#[tokio::test]
#[ignore = "requires disposable shared TLS PostgreSQL from test-runtime.sh"]
async fn runtime_shared_state_capacity_expiry_and_workspace_cleanup_are_global() {
    let (database, a, b) = fixture().await;
    let owners = (0..8)
        .map(|_| principal(Action::PreviewAccess))
        .collect::<Vec<_>>();
    for _ in 0..16 {
        let results = join_all(owners.iter().enumerate().map(|(index, owner)| {
            let store = if index % 2 == 0 { &a } else { &b };
            store.issue_preview(owner, "agent", 3000, "/", "")
        }))
        .await;
        assert!(
            results.iter().all(Result::is_ok),
            "ticket issuance failed: {results:?}"
        );
    }
    assert_eq!(b.stats().await.unwrap().pending, 128);
    let extra = principal(Action::PreviewAccess);
    assert_eq!(
        a.issue_preview(&extra, "agent", 3000, "/", "")
            .await
            .unwrap_err()
            .code(),
        Code::ResourceExhausted
    );
    b.remove_agent(&owners[0].context.workspace_uid)
        .await
        .unwrap();
    assert_eq!(a.stats().await.unwrap().pending, 112);
    let ticket = a
        .issue_preview(&extra, "agent", 3000, "/", "")
        .await
        .unwrap();
    database
        .connection()
        .await
        .unwrap()
        .execute(
            "UPDATE tengri.tickets SET expires_at_ms=tengri.now_ms()-1 WHERE token_hash=$1",
            &[&Sha256::digest(ticket.token.as_bytes()).to_vec()],
        )
        .await
        .unwrap();
    assert_eq!(
        b.consume_preview(&ticket.token).await.unwrap_err().code(),
        Code::Unauthenticated
    );
    database
        .connection()
        .await
        .unwrap()
        .batch_execute("DELETE FROM tengri.tickets; DELETE FROM tengri.previews")
        .await
        .unwrap();
    let mut sessions = Vec::new();
    for owner in owners.iter().take(6) {
        for _ in 0..16 {
            let ticket = a
                .issue_preview(owner, "agent", 3000, "/", "")
                .await
                .unwrap();
            sessions.push(b.consume_preview(&ticket.token).await.unwrap());
        }
        let overflow = b
            .issue_preview(owner, "agent", 3000, "/", "")
            .await
            .unwrap();
        assert_eq!(
            a.consume_preview(&overflow.token).await.unwrap_err().code(),
            Code::ResourceExhausted
        );
    }
    assert_eq!(a.stats().await.unwrap().previews, 96);
    let blocked = a
        .issue_preview(&extra, "agent", 3000, "/", "")
        .await
        .unwrap();
    assert_eq!(
        b.consume_preview(&blocked.token).await.unwrap_err().code(),
        Code::ResourceExhausted
    );
    let expired = sessions.pop().unwrap();
    database
        .connection()
        .await
        .unwrap()
        .execute(
            "UPDATE tengri.previews SET expires_at_ms=tengri.now_ms()-1 WHERE id=$1",
            &[&expired.id],
        )
        .await
        .unwrap();
    assert_eq!(
        a.preview_session(&expired.id, &expired.token)
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    // The capacity failure rolled redemption back, retaining the exact one-use ticket.
    let recovered = a.consume_preview(&blocked.token).await.unwrap();
    assert_eq!(b.stats().await.unwrap().previews, 96);
    b.remove_agent(&extra.context.workspace_uid).await.unwrap();
    assert_eq!(
        a.preview_session(&recovered.id, &recovered.token)
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
}

#[tokio::test]
#[ignore = "requires disposable shared TLS PostgreSQL from test-runtime.sh"]
async fn runtime_shared_state_signed_nonce_is_shared_and_payload_bound() {
    let first = Arc::new(Database::shared_fixture().await);
    let second = Arc::new(Database::shared_fixture().await);
    let a = Authenticator::fixture(first, "https://proompteng.ai".into());
    let b = Authenticator::fixture(second, "https://proompteng.ai".into());
    let owner = principal(Action::WorkspaceMetadataRead);
    let path = "/proompteng.runtime.v1.MicroVMControlPlane/GetAgent";
    let request = signed_fixture_request(GetAgentRequest { id: "agent".into() }, &owner, path);
    let mut changed = tonic::Request::new(GetAgentRequest {
        id: "another".into(),
    });
    *changed.metadata_mut() = request.metadata().clone();
    assert_eq!(
        a.authorize(&changed, path).await.unwrap_err().code(),
        Code::Unauthenticated
    );
    assert_eq!(
        a.authorize(&request, path)
            .await
            .unwrap()
            .context
            .session_id,
        owner.context.session_id
    );
    assert_eq!(
        b.authorize(&request, path).await.unwrap_err().code(),
        Code::Unauthenticated
    );
    let fresh = signed_fixture_request(GetAgentRequest { id: "agent".into() }, &owner, path);
    assert!(b.authorize(&fresh, path).await.is_ok());
    let mut duplicated =
        signed_fixture_request(GetAgentRequest { id: "agent".into() }, &owner, path);
    let nonce = duplicated.metadata().get("x-tengri-nonce").unwrap().clone();
    duplicated.metadata_mut().append("x-tengri-nonce", nonce);
    assert_eq!(
        a.authorize(&duplicated, path).await.unwrap_err().code(),
        Code::Unauthenticated
    );
}

#[tokio::test]
#[ignore = "requires disposable shared TLS PostgreSQL from test-runtime.sh"]
async fn runtime_shared_state_leadership_cas_expiry_and_supervisor_permissions() {
    let a = Database::shared_fixture().await;
    let b = Database::shared_fixture().await;
    let one = Uuid::new_v4();
    let two = Uuid::new_v4();
    let (left, right) = tokio::join!(a.acquire(one), b.acquire(two));
    let left = left.unwrap();
    let right = right.unwrap();
    assert_eq!(
        usize::from(left.is_some()) + usize::from(right.is_some()),
        1
    );
    let first = left.or(right).unwrap();
    assert!(a.require_fence(first).await.is_ok());
    let wrong = crate::control::Fence {
        owner: Uuid::new_v4(),
        ..first
    };
    assert!(!b.renew(wrong).await.unwrap());
    b.release(wrong).await.unwrap();
    assert!(a.require_fence(first).await.is_ok());
    a.release(first).await.unwrap();
    let second = b.acquire(two).await.unwrap().unwrap();
    assert!(second.generation > first.generation);
    assert_eq!(
        a.require_fence(first).await.unwrap_err().code(),
        Code::PermissionDenied
    );
    assert!(!a.renew(first).await.unwrap());
    a.release(first).await.unwrap();
    assert!(b.require_fence(second).await.is_ok());
    let dsn = std::env::var("TENGRI_DATABASE_DSN")
        .unwrap()
        .replace("user=tengri_controller", "user=tengri_supervisor");
    let supervisor = Database::connect(
        &dsn,
        Path::new(&std::env::var("TENGRI_DATABASE_PASSWORD_FILE").unwrap()),
        Path::new(&std::env::var("TENGRI_DATABASE_CA_FILE").unwrap()),
        "tengri_supervisor",
    )
    .await
    .unwrap();
    supervisor.verify_schema().await.unwrap();
    assert!(supervisor.require_fence(second).await.is_ok());
    assert!(supervisor.acquire(Uuid::new_v4()).await.is_err());
    let client = supervisor.connection().await.unwrap();
    for query in [
        "SELECT * FROM tengri.tickets",
        "DELETE FROM tengri.previews",
        "UPDATE tengri.runtime_leader SET expires_at_ms=0",
    ] {
        assert_eq!(
            client
                .batch_execute(query)
                .await
                .unwrap_err()
                .code()
                .unwrap()
                .code(),
            "42501"
        );
    }
    tokio::time::sleep(Duration::from_millis(15_100)).await;
    assert_eq!(
        supervisor.require_fence(second).await.unwrap_err().code(),
        Code::PermissionDenied
    );
    assert!(!b.renew(second).await.unwrap());
    let third = a.acquire(one).await.unwrap().unwrap();
    assert!(third.generation > second.generation);
    a.release(third).await.unwrap();
}
