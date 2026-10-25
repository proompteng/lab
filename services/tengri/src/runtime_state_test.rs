use std::{path::Path, sync::Arc, time::Duration};

use futures::future::join_all;
use sha2::{Digest, Sha256};
use tonic::Code;
use uuid::Uuid;

use crate::{auth::Principal, control::Database, ofz::proto::Action, tickets::TicketStore};

impl Database {
    async fn consume_nonce(&self, key: &[u8], expires_at_ms: i64) -> Result<(), tonic::Status> {
        let mut client = self.connection().await?;
        let tx = client
            .transaction()
            .await
            .map_err(crate::control::sql_error)?;
        let consumed: bool = tx
            .query_one(
                "SELECT tengri.consume_nonce($1,$2)",
                &[&key, &expires_at_ms],
            )
            .await
            .map_err(crate::control::sql_error)?
            .get(0);
        if !consumed {
            return Err(tonic::Status::unauthenticated("request nonce already used"));
        }
        tx.commit().await.map_err(crate::control::sql_error)?;
        let now: i64 = client
            .query_one("SELECT tengri.now_ms()", &[])
            .await
            .map_err(crate::control::sql_error)?
            .get(0);
        if expires_at_ms <= now {
            return Err(tonic::Status::unauthenticated(
                "request nonce deadline expired",
            ));
        }
        Ok(())
    }
}

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
async fn runtime_shared_state_independent_capabilities_do_not_wait_for_another_commit() {
    let (database, a, _) = fixture().await;
    let owner = principal(Action::TerminalControl);
    let mut held = database.connection().await.unwrap();
    let tx = held.transaction().await.unwrap();
    // Reproduce the lock retained by an in-flight ticket transaction in the failing release.
    tx.batch_execute("SELECT pg_advisory_xact_lock(726635522922)")
        .await
        .unwrap();
    let outcome = tokio::time::timeout(
        Duration::from_millis(500),
        a.issue_terminal(&owner, "agent", "terminal"),
    )
    .await;
    tx.rollback().await.unwrap();
    assert!(
        matches!(outcome, Ok(Ok(_))),
        "an independent Terminal launch must not wait for another capability commit: {outcome:?}"
    );
}

#[tokio::test]
#[ignore = "requires disposable shared TLS PostgreSQL from test-runtime.sh"]
async fn runtime_shared_state_expiry_cleanup_skips_uncommitted_capabilities() {
    let (database, a, b) = fixture().await;
    let owner = principal(Action::TerminalControl);
    a.issue_terminal(&owner, "agent", "old").await.unwrap();
    let mut held = database.connection().await.unwrap();
    held.batch_execute("UPDATE tengri.tickets SET expires_at_ms=tengri.now_ms()-1")
        .await
        .unwrap();
    let tx = held.transaction().await.unwrap();
    tx.batch_execute("DELETE FROM tengri.tickets")
        .await
        .unwrap();
    let outcome = tokio::time::timeout(
        Duration::from_millis(500),
        b.issue_terminal(&owner, "agent", "new"),
    )
    .await;
    tx.rollback().await.unwrap();
    assert!(
        matches!(outcome, Ok(Ok(_))),
        "expiry cleanup must skip a row waiting for another transaction's commit: {outcome:?}"
    );
}

#[tokio::test]
#[ignore = "requires disposable shared TLS PostgreSQL from test-runtime.sh"]
async fn runtime_shared_state_parallel_workspace_issuance_cannot_exceed_its_quota() {
    let (_, a, b) = fixture().await;
    let owner = principal(Action::TerminalControl);
    let issue_batch = || {
        join_all((0..16).map(|index| {
            let owner = &owner;
            let store = if index % 2 == 0 { &a } else { &b };
            async move {
                store
                    .issue_terminal(owner, "agent", &index.to_string())
                    .await
            }
        }))
    };
    let admitted = issue_batch().await;
    assert!(
        admitted.iter().all(Result::is_ok),
        "initial concurrent launches failed: {:?}",
        admitted
            .iter()
            .filter_map(|result| result.as_ref().err())
            .collect::<Vec<_>>()
    );
    let results = issue_batch().await;
    assert!(results.iter().all(Result::is_err));
    assert!(
        results
            .iter()
            .filter_map(|result| result.as_ref().err())
            .all(|error| error.code() == Code::ResourceExhausted)
    );
    assert_eq!(a.stats().await.unwrap().pending, 16);
}

#[tokio::test]
#[ignore = "requires disposable shared TLS PostgreSQL from test-runtime.sh"]
async fn runtime_shared_state_replay_guard_tolerates_clock_lead_without_expiry_grace() {
    let (database, _, _) = fixture().await;
    let client = database.connection().await.unwrap();
    let nonce = Sha256::digest(Uuid::new_v4().as_bytes()).to_vec();
    let accepted: bool = client
        .query_one(
            "SELECT tengri.consume_nonce($1,tengri.now_ms()+5500)",
            &[&nonce],
        )
        .await
        .unwrap()
        .get(0);
    assert!(
        accepted,
        "a verified five-second request may lead the database clock by 500 ms"
    );
    let replay: bool = client
        .query_one(
            "SELECT tengri.consume_nonce($1,tengri.now_ms()+5500)",
            &[&nonce],
        )
        .await
        .unwrap()
        .get(0);
    assert!(!replay);
    for offset in [-1_i64, 6500] {
        let nonce = Sha256::digest(Uuid::new_v4().as_bytes()).to_vec();
        let error = client
            .query_one(
                "SELECT tengri.consume_nonce($1,tengri.now_ms()+$2)",
                &[&nonce, &offset],
            )
            .await
            .unwrap_err();
        assert_eq!(
            crate::control::sql_error(error).code(),
            Code::Unauthenticated
        );
    }
}

#[tokio::test]
#[ignore = "requires disposable shared TLS PostgreSQL from test-runtime.sh"]
async fn runtime_shared_state_independent_nonces_do_not_share_a_transaction_lock() {
    let (database, _, _) = fixture().await;
    let mut held = database.connection().await.unwrap();
    let tx = held.transaction().await.unwrap();
    let mut first = Sha256::digest(Uuid::new_v4().as_bytes()).to_vec();
    let mut second = Sha256::digest(Uuid::new_v4().as_bytes()).to_vec();
    first[0] = 0;
    second[0] = 64;
    assert!(
        tx.query_one(
            "SELECT tengri.consume_nonce($1,tengri.now_ms()+5000)",
            &[&first]
        )
        .await
        .unwrap()
        .get::<_, bool>(0)
    );
    let deadline = (crate::ofz::now_ms().unwrap() + 5000) as i64;
    let accepted = tokio::time::timeout(
        Duration::from_millis(500),
        database.consume_nonce(&second, deadline),
    )
    .await;
    tx.rollback().await.unwrap();
    assert!(
        matches!(accepted, Ok(Ok(()))),
        "an unrelated request must not wait for another nonce's commit: {accepted:?}"
    );
    assert_eq!(
        database
            .consume_nonce(&second, deadline)
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
}

#[tokio::test]
#[ignore = "requires disposable shared TLS PostgreSQL from test-runtime.sh"]
async fn runtime_shared_state_nonce_buckets_bound_capacity_without_blocking_other_buckets() {
    let (database, _, _) = fixture().await;
    let mut client = database.connection().await.unwrap();
    let tx = client.transaction().await.unwrap();
    let bucket = vec![255_u8; 32];
    let accepted = tx.query(
        "SELECT tengri.consume_nonce(set_byte($1,31,n),tengri.now_ms()+5000) FROM generate_series(0,127) n", &[&bucket]
    ).await.unwrap();
    assert_eq!(accepted.len(), 128);
    assert!(accepted.iter().all(|row| row.get::<_, bool>(0)));
    let other = vec![0_u8; 32];
    assert!(
        tx.query_one(
            "SELECT tengri.consume_nonce($1,tengri.now_ms()+5000)",
            &[&other]
        )
        .await
        .unwrap()
        .get::<_, bool>(0)
    );
    let full = vec![255_u8; 32];
    let error = tx
        .query_one(
            "SELECT tengri.consume_nonce($1,tengri.now_ms()+5000)",
            &[&full],
        )
        .await
        .unwrap_err();
    assert_eq!(
        crate::control::sql_error(error).code(),
        Code::ResourceExhausted
    );
    tx.rollback().await.unwrap();
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
    let reconnect_started = tokio::time::Instant::now();
    loop {
        match database.consume_nonce(&nonce, deadline).await {
            Err(error) if error.code() == Code::Unauthenticated => break,
            Err(error)
                if error.code() == Code::Unavailable
                    && reconnect_started.elapsed() < Duration::from_secs(2) =>
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            outcome => panic!("replay must remain denied across bounded reconnection: {outcome:?}"),
        }
    }
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
    for _ in 0..database.pool.status().max_size {
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
async fn runtime_shared_state_redeemed_capabilities_survive_a_slow_initial_audit() {
    let (_database, a, b) = fixture().await;
    let mut terminal_owner = principal(Action::TerminalControl);
    terminal_owner.context.deadline_unix_ms = crate::ofz::now_ms().unwrap() + 100;
    let mut editor_owner = terminal_owner.clone();
    editor_owner.action = Action::EditorOpen;
    let terminal = a
        .issue_terminal(&terminal_owner, "agent", "terminal-1")
        .await
        .unwrap();
    let preview = a
        .issue_editor(&editor_owner, "agent", "window-1")
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(terminal_owner.context.deadline_unix_ms < crate::ofz::now_ms().unwrap());
    let terminal = b.consume(&terminal.token).await.unwrap();
    let preview = b.consume_preview(&preview.token).await.unwrap();
    let restored = a
        .preview_session(&preview.id, &preview.token)
        .await
        .unwrap();
    assert_eq!(restored.expires_at, preview.expires_at);
    for (actual, original) in [
        (&terminal.principal, &terminal_owner),
        (&preview.principal, &editor_owner),
        (&restored.principal, &editor_owner),
    ] {
        let mut context = actual.context.clone();
        context.deadline_unix_ms = original.context.deadline_unix_ms;
        assert_eq!(context, original.context);
        assert_eq!(actual.action, original.action);
    }
    tokio::time::sleep(Duration::from_millis(3100)).await;
    for context in [
        &terminal.principal.context,
        &preview.principal.context,
        &restored.principal.context,
    ] {
        assert!(
            context.deadline_unix_ms > crate::ofz::now_ms().unwrap(),
            "a redeemed capability must allow its initial durable audit to finish"
        );
    }
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
    let mut other_session = owner.clone();
    other_session.context.session_id = Uuid::new_v4().to_string();
    let other_pending = a
        .issue_editor(&other_session, "agent", "window-2")
        .await
        .unwrap();
    let mut signout = owner.clone();
    signout.context.workspace_uid.clear();
    signout.context.runtime_epoch.clear();
    b.revoke_desktop_previews(&signout).await.unwrap();
    assert!(a.consume_preview(&other_pending.token).await.is_ok());
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
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::WARN)
        .with_test_writer()
        .try_init();
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
            "ticket issuance failed: {:?}",
            results
                .iter()
                .filter_map(|outcome| outcome.as_ref().err())
                .collect::<Vec<_>>()
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
    let remaining: i64 = a
        .connection()
        .await
        .unwrap()
        .query_one(
            "SELECT expires_at_ms-tengri.now_ms() FROM tengri.runtime_leader WHERE singleton",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert!((55_000..=60_000).contains(&remaining));
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
    assert!(b.renew(second).await.unwrap());
    let remaining: i64 = b
        .connection()
        .await
        .unwrap()
        .query_one(
            "SELECT expires_at_ms-tengri.now_ms() FROM tengri.runtime_leader WHERE singleton",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert!((55_000..=60_000).contains(&remaining));
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
    let nonce = Sha256::digest(Uuid::new_v4().as_bytes()).to_vec();
    supervisor
        .consume_nonce(&nonce, (crate::ofz::now_ms().unwrap() + 2000) as i64)
        .await
        .unwrap();
    assert_eq!(
        b.consume_nonce(&nonce, (crate::ofz::now_ms().unwrap() + 2000) as i64)
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
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
    tokio::time::sleep(crate::leadership::LEASE_DURATION + Duration::from_millis(100)).await;
    assert_eq!(
        supervisor.require_fence(second).await.unwrap_err().code(),
        Code::PermissionDenied
    );
    assert!(!b.renew(second).await.unwrap());
    let third = a.acquire(one).await.unwrap().unwrap();
    assert!(third.generation > second.generation);
    a.release(third).await.unwrap();
}

#[tokio::test]
#[ignore = "requires the synchronous physical fixture from test-database-failover.sh"]
async fn physical_database_promotion_preserves_authority_and_consumed_capabilities() {
    use serde_json::{Value, json};

    async fn native(
        client: &reqwest::Client,
        endpoint: &str,
        path: &str,
        body: Value,
    ) -> Result<Value, reqwest::Error> {
        client
            .post(format!("{endpoint}{path}"))
            .bearer_auth("ofz-policy-fixture")
            .json(&body)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await
    }
    fn relationship(
        kind: &str,
        id: &str,
        relation: &str,
        subject_kind: &str,
        subject: &str,
    ) -> Value {
        json!({"resource":{"objectType":kind,"objectId":id},"relation":relation,
            "subject":{"object":{"objectType":subject_kind,"objectId":subject}}})
    }
    fn check(uid: &str, human: &str) -> Value {
        json!({"consistency":{"fullyConsistent":true},"resource":{"objectType":"workspace","objectId":uid},
            "permission":"view_metadata","subject":{"object":{"objectType":"human","objectId":human}}})
    }
    assert_eq!(
        std::env::var("TENGRI_DATABASE_FAILOVER_FIXTURE").as_deref(),
        Ok("1")
    );
    let (database, a, b) = fixture().await;
    let peer = Database::shared_fixture().await;
    let endpoint = std::env::var("OFZ_TEST_NATIVE_ENDPOINT").unwrap();
    assert!(endpoint.starts_with("http://127.0.0.1:"));
    let native_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .no_proxy()
        .build()
        .unwrap();
    let uid = Uuid::new_v4().to_string();
    let owner = "b".repeat(64);
    let revoked = "c".repeat(64);
    let relationships = [
        relationship("platform", "lab", "member", "human", &owner),
        relationship("platform", "lab", "member", "human", &revoked),
        relationship("workspace", &uid, "platform", "platform", "lab"),
        relationship("workspace", &uid, "owner", "human", &owner),
        relationship("workspace", &uid, "viewer", "human", &revoked),
    ];
    native(
        &native_client,
        &endpoint,
        "/v1/relationships/write",
        json!({"updates":relationships.into_iter().map(|relationship|
        json!({"operation":"OPERATION_TOUCH","relationship":relationship})).collect::<Vec<_>>()}),
    )
    .await
    .unwrap();
    assert_eq!(
        native(
            &native_client,
            &endpoint,
            "/v1/permissions/check",
            check(&uid, &revoked)
        )
        .await
        .unwrap()["permissionship"],
        "PERMISSIONSHIP_HAS_PERMISSION"
    );
    native(
        &native_client,
        &endpoint,
        "/v1/relationships/write",
        json!({"updates":[{"operation":"OPERATION_DELETE",
        "relationship":relationship("workspace", &uid, "viewer", "human", &revoked)}]}),
    )
    .await
    .unwrap();
    assert_eq!(
        native(
            &native_client,
            &endpoint,
            "/v1/permissions/check",
            check(&uid, &revoked)
        )
        .await
        .unwrap()["permissionship"],
        "PERMISSIONSHIP_NO_PERMISSION"
    );

    let terminal_owner = principal(Action::TerminalControl);
    let spent = a
        .issue_terminal(&terminal_owner, "agent", "spent")
        .await
        .unwrap();
    b.consume(&spent.token).await.unwrap();
    let pending = a
        .issue_terminal(&terminal_owner, "agent", "pending")
        .await
        .unwrap();
    let editor_owner = principal(Action::EditorOpen);
    let live_ticket = a
        .issue_editor(&editor_owner, "agent", "live")
        .await
        .unwrap();
    let live_preview = b.consume_preview(&live_ticket.token).await.unwrap();
    let revoked_ticket = a
        .issue_editor(&editor_owner, "agent", "revoked")
        .await
        .unwrap();
    let revoked_preview = b.consume_preview(&revoked_ticket.token).await.unwrap();
    a.revoke_preview_lease(
        &editor_owner,
        "agent",
        &revoked_ticket.id,
        &revoked_ticket.token,
    )
    .await
    .unwrap();
    let fence = database.acquire(Uuid::new_v4()).await.unwrap().unwrap();
    let nonce = Sha256::digest(Uuid::new_v4().as_bytes()).to_vec();
    let deadline = (crate::ofz::now_ms().unwrap() + 5000) as i64;
    database.consume_nonce(&nonce, deadline).await.unwrap();

    let started = tokio::time::Instant::now();
    let output = tokio::time::timeout(
        Duration::from_secs(30),
        tokio::process::Command::new("bash")
            .arg(std::env::var("TENGRI_DATABASE_FAILOVER_COMMAND").unwrap())
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        output.status.success(),
        "physical promotion failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    eprintln!("{}", String::from_utf8_lossy(&output.stdout).trim());
    loop {
        match database.verify_schema().await {
            Ok(()) => break,
            Err(error)
                if error.code() == Code::Unavailable
                    && started.elapsed() < Duration::from_secs(30) =>
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            result => panic!("shared state did not recover on the unchanged client: {result:?}"),
        }
    }
    let now: i64 = database
        .connection()
        .await
        .unwrap()
        .query_one("SELECT tengri.now_ms()", &[])
        .await
        .unwrap()
        .get(0);
    assert!(
        now < deadline,
        "replay proof must run before the original nonce expires"
    );
    assert_eq!(
        database
            .consume_nonce(&nonce, deadline)
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    assert_eq!(
        b.consume(&spent.token).await.unwrap_err().code(),
        Code::Unauthenticated
    );
    b.consume(&pending.token).await.unwrap();
    assert_eq!(
        a.consume(&pending.token).await.unwrap_err().code(),
        Code::Unauthenticated
    );
    let recovered = a
        .preview_session(&live_preview.id, &live_preview.token)
        .await
        .unwrap();
    assert_eq!(
        recovered.principal.context.runtime_epoch,
        editor_owner.context.runtime_epoch
    );
    assert_eq!(
        recovered.principal.context.workspace_uid,
        editor_owner.context.workspace_uid
    );
    assert_eq!(
        recovered.principal.context.session_id,
        editor_owner.context.session_id
    );
    assert_eq!(
        a.preview_session(&revoked_preview.id, &revoked_preview.token)
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    database.require_fence(fence).await.unwrap();
    assert!(peer.acquire(Uuid::new_v4()).await.unwrap().is_none());
    database.release(fence).await.unwrap();
    let (left, right) = tokio::join!(
        database.acquire(Uuid::new_v4()),
        peer.acquire(Uuid::new_v4())
    );
    let (left, right) = (left.unwrap(), right.unwrap());
    assert_eq!(
        usize::from(left.is_some()) + usize::from(right.is_some()),
        1
    );
    let replacement = left.or(right).unwrap();
    assert!(replacement.generation > fence.generation);
    assert_eq!(
        peer.require_fence(fence).await.unwrap_err().code(),
        Code::PermissionDenied
    );
    peer.release(replacement).await.unwrap();
    for (human, expected) in [
        (&owner, "PERMISSIONSHIP_HAS_PERMISSION"),
        (&revoked, "PERMISSIONSHIP_NO_PERMISSION"),
    ] {
        loop {
            match native(
                &native_client,
                &endpoint,
                "/v1/permissions/check",
                check(&uid, human),
            )
            .await
            {
                Ok(value) => {
                    assert_eq!(value["permissionship"], expected);
                    break;
                }
                Err(_) if started.elapsed() < Duration::from_secs(30) => {
                    tokio::time::sleep(Duration::from_millis(10)).await
                }
                Err(error) => {
                    panic!("native policy did not recover after physical promotion: {error}")
                }
            }
        }
    }
    assert!(started.elapsed() < Duration::from_secs(30));
    eprintln!(
        "Physical promotion proof passed in {:?}: unexpired nonce, atomic tickets, previews, fencing and current policy",
        started.elapsed()
    );
}
