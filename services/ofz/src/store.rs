use std::{env, sync::Arc, time::Duration};

use anyhow::{Context, bail};
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};
use rustls::{ClientConfig, RootCertStore};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore},
    task::JoinHandle,
};
use tokio_postgres::{Client, Config, GenericClient, config::SslMode};
use tokio_postgres_rustls::MakeRustlsConnect;
use tonic::Status;
use uuid::Uuid;

use crate::{
    policy,
    proto::{Action, AuditReceipt, RequestContext, actor::Identity},
};

#[derive(Clone)]
pub struct Database {
    pub pool: Pool,
    config: Config,
    tls: MakeRustlsConnect,
    command_slots: Arc<Semaphore>,
}

pub struct CommandConnection {
    pub client: Client,
    task: JoinHandle<()>,
    _permit: OwnedSemaphorePermit,
}

impl Drop for CommandConnection {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub fn sql_error(error: tokio_postgres::Error) -> Status {
    tracing::warn!(
        sqlstate = error.code().map(|c| c.code()),
        "control database operation failed"
    );
    Status::unavailable("authorization control database unavailable")
}

impl Database {
    pub async fn from_environment() -> anyhow::Result<Self> {
        let mut config: Config = env::var("OFZ_DATABASE_DSN")
            .context("OFZ_DATABASE_DSN required")?
            .parse()?;
        if config.get_ssl_mode() != SslMode::Require {
            bail!("database TLS is required");
        }
        if config.get_password().is_some() {
            bail!("database password must use the mounted credential file");
        }
        let password = tokio::fs::read_to_string(env::var("OFZ_DATABASE_PASSWORD_FILE")?).await?;
        config.password(password.trim_end());
        config
            .application_name("ofz-api")
            .connect_timeout(Duration::from_secs(2));
        config.options("-c statement_timeout=2000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=5000 -c search_path=ofz,pg_catalog");
        let mut roots = RootCertStore::empty();
        let bytes = tokio::fs::read(env::var("OFZ_DATABASE_CA_FILE")?).await?;
        for cert in rustls_pemfile::certs(&mut bytes.as_slice()) {
            roots.add(cert?)?;
        }
        if roots.is_empty() {
            bail!("database CA is empty");
        }
        // MakeRustlsConnect validates the configured database DNS name against this CA.
        let tls = MakeRustlsConnect::new(
            ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth(),
        );
        Self::new(config, tls)
    }

    pub fn new(config: Config, tls: MakeRustlsConnect) -> anyhow::Result<Self> {
        let manager = Manager::from_config(
            config.clone(),
            tls.clone(),
            ManagerConfig {
                recycling_method: RecyclingMethod::Verified,
            },
        );
        let pool = Pool::builder(manager)
            .max_size(12)
            .wait_timeout(Some(Duration::from_millis(500)))
            .create_timeout(Some(Duration::from_secs(2)))
            .recycle_timeout(Some(Duration::from_secs(2)))
            .runtime(deadpool_postgres::Runtime::Tokio1)
            .build()?;
        Ok(Self {
            pool,
            config,
            tls,
            command_slots: Arc::new(Semaphore::new(2)),
        })
    }

    pub async fn verify_schema(&self) -> Result<(), Status> {
        let client = self
            .pool
            .get()
            .await
            .map_err(|_| Status::unavailable("control database pool unavailable"))?;
        let row = client
            .query_one("SELECT version,checksum FROM ofz.schema_version", &[])
            .await
            .map_err(sql_error)?;
        if row.get::<_, i32>(0) != 1
            || row.get::<_, Option<Vec<u8>>>(1).as_deref() != Some(migration_checksum().as_slice())
        {
            return Err(Status::failed_precondition(
                "control database schema mismatch",
            ));
        }
        Ok(())
    }

    pub async fn migrate(&self) -> Result<(), Status> {
        let connection = self.command_connection().await?;
        let exists: bool = connection
            .client
            .query_one("SELECT to_regclass('ofz.schema_version') IS NOT NULL", &[])
            .await
            .map_err(sql_error)?
            .get(0);
        if !exists {
            connection
                .client
                .batch_execute(include_str!("../migrations/0001_control.sql"))
                .await
                .map_err(sql_error)?;
        }
        let row = connection
            .client
            .query_one("SELECT version,checksum FROM ofz.schema_version", &[])
            .await
            .map_err(sql_error)?;
        let checksum: Option<Vec<u8>> = row.get(1);
        if row.get::<_, i32>(0) != 1
            || checksum
                .as_ref()
                .is_some_and(|value| *value != migration_checksum())
        {
            return Err(Status::failed_precondition(
                "control schema migration checksum mismatch",
            ));
        }
        if checksum.is_none() {
            connection.client.execute("UPDATE ofz.schema_version SET checksum=$1 WHERE version=1 AND checksum IS NULL", &[&migration_checksum()]).await.map_err(sql_error)?;
        }
        Ok(())
    }

    pub async fn command_connection(&self) -> Result<CommandConnection, Status> {
        let permit = self
            .command_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Status::resource_exhausted("policy command queue full"))?;
        let (client, connection) = self
            .config
            .connect(self.tls.clone())
            .await
            .map_err(sql_error)?;
        let task = tokio::spawn(async move {
            if connection.await.is_err() {
                tracing::warn!("command database connection closed");
            }
        });
        let connection = CommandConnection {
            client,
            task,
            _permit: permit,
        };
        let start = tokio::time::Instant::now();
        loop {
            let row = connection
                .client
                .query_one("SELECT pg_try_advisory_lock(726635522918)", &[])
                .await
                .map_err(sql_error)?;
            if row.get::<_, bool>(0) {
                return Ok(connection);
            }
            if start.elapsed() >= Duration::from_secs(2) {
                return Err(Status::resource_exhausted("policy command queue full"));
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    pub async fn state(&self) -> Result<State, Status> {
        let client = self
            .pool
            .get()
            .await
            .map_err(|_| Status::unavailable("control database pool unavailable"))?;
        state(&**client).await
    }

    pub async fn audit(&self, receipt: &AuditReceipt, target: &str) -> Result<String, Status> {
        let mut client = self
            .pool
            .get()
            .await
            .map_err(|_| Status::unavailable("control database pool unavailable"))?;
        let tx = client.transaction().await.map_err(sql_error)?;
        record_audit(&*tx, receipt, target).await?;
        if !record_activity(&*tx, receipt).await? {
            return Err(Status::unauthenticated("session expired or revoked"));
        }
        tx.commit().await.map_err(sql_error)?;
        Ok(receipt.id.clone())
    }
}

pub async fn record_activity<C: GenericClient + Sync>(
    client: &C,
    receipt: &AuditReceipt,
) -> Result<bool, Status> {
    let action =
        Action::try_from(receipt.action).map_err(|_| Status::internal("invalid audit action"))?;
    let Some(Identity::HumanId(human)) = receipt
        .actor
        .as_ref()
        .and_then(|actor| actor.identity.as_ref())
    else {
        return Ok(true);
    };
    if !receipt.allowed || !policy::requires_mfa(action) {
        return Ok(true);
    }
    let id =
        Uuid::parse_str(&receipt.session_id).map_err(|_| Status::internal("invalid session ID"))?;
    Ok(client.execute("UPDATE ofz.sessions SET idle_deadline_ms=LEAST(expires_at_ms,GREATEST(idle_deadline_ms,ofz.now_ms()+1800000)) WHERE id=$1 AND human_id=$2 AND NOT revoked AND expires_at_ms>ofz.now_ms() AND idle_deadline_ms>ofz.now_ms() AND recovery_generation=(SELECT recovery_generation FROM ofz.platform_state)", &[&id,human]).await.map_err(sql_error)? == 1)
}

#[derive(Clone, Debug)]
pub struct State {
    pub version: u64,
    pub recovery_generation: u64,
    pub fenced: bool,
    pub now_ms: u64,
    pub archive_healthy: bool,
}

pub async fn state<C: GenericClient + Sync>(client: &C) -> Result<State, Status> {
    let row = client.query_one("SELECT p.version,p.recovery_generation,p.fenced,ofz.now_ms(), a.acknowledged_at_ms >= ofz.now_ms()-60000 FROM ofz.platform_state p CROSS JOIN ofz.archive_state a", &[]).await.map_err(sql_error)?;
    Ok(State {
        version: row.get::<_, i64>(0) as u64,
        recovery_generation: row.get::<_, i64>(1) as u64,
        fenced: row.get(2),
        now_ms: row.get::<_, i64>(3) as u64,
        archive_healthy: row.get(4),
    })
}

pub async fn record_audit<C: GenericClient + Sync>(
    client: &C,
    receipt: &AuditReceipt,
    target: &str,
) -> Result<(), Status> {
    let id =
        Uuid::parse_str(&receipt.id).map_err(|_| Status::internal("invalid audit identifier"))?;
    let value =
        serde_json::to_value(receipt).map_err(|_| Status::internal("encode audit receipt"))?;
    let target_hash = Sha256::digest(target.as_bytes()).to_vec();
    let row = client
        .query_one(
            "INSERT INTO ofz.audit(id,receipt,target_hash) SELECT $1,jsonb_set($2,'{recovery_generation}',to_jsonb(recovery_generation)),$3 FROM ofz.platform_state RETURNING sequence",
            &[&id, &value, &target_hash],
        )
        .await
        .map_err(sql_error)?;
    let sequence: i64 = row.get(0);
    client
        .execute(
            "INSERT INTO ofz.audit_outbox(audit_sequence) VALUES($1)",
            &[&sequence],
        )
        .await
        .map_err(sql_error)?;
    Ok(())
}

pub fn receipt(
    context: &RequestContext,
    peer: &str,
    resource: crate::proto::Resource,
    action: crate::proto::Action,
    allowed: bool,
    operation_id: &str,
    reason: &str,
) -> AuditReceipt {
    AuditReceipt {
        id: Uuid::new_v4().to_string(),
        sequence: 0,
        created_at_unix_ms: 0,
        actor: context.actor.clone(),
        workload_id: peer.into(),
        resource: Some(resource),
        action: action.into(),
        allowed,
        operation_id: operation_id.into(),
        trace_id: context.trace_id.clone(),
        reason: reason.into(),
        session_id: context.session_id.clone(),
        grant_id: context.grant_id.clone(),
        workspace_uid: context.workspace_uid.clone(),
        runtime_epoch: context.runtime_epoch.clone(),
        origin: context.origin.clone(),
        recovery_generation: 0,
        policy_command: None,
        revision: String::new(),
    }
}

pub fn encode<T: serde::Serialize>(value: &T) -> Result<Value, Status> {
    serde_json::to_value(value).map_err(|_| Status::internal("encode control record"))
}

pub fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, Status> {
    serde_json::from_value(value).map_err(|_| Status::unavailable("invalid control record"))
}

fn migration_checksum() -> Vec<u8> {
    Sha256::digest(include_bytes!("../migrations/0001_control.sql")).to_vec()
}
