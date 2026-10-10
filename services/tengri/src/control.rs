use std::{env, path::Path, time::Duration};

use anyhow::{Context, ensure};
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};
use rustls::{ClientConfig, RootCertStore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio_postgres::{
    Config,
    config::{Host, SslMode},
};
use tokio_postgres_rustls::MakeRustlsConnect;
use tonic::Status;
use uuid::Uuid;

const SCHEMA: &[u8] = include_bytes!("../migrations/0001_control.sql");

#[derive(Clone)]
pub struct Database {
    pub pool: Pool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Fence {
    pub owner: Uuid,
    pub generation: i64,
}

impl Fence {
    pub fn validate(self) -> anyhow::Result<Self> {
        ensure!(
            !self.owner.is_nil() && self.generation > 0,
            "invalid controller fence"
        );
        Ok(self)
    }
}

impl Database {
    pub async fn from_environment(role: &str) -> anyhow::Result<Self> {
        Self::connect(
            &env::var("TENGRI_DATABASE_DSN").context("TENGRI_DATABASE_DSN required")?,
            Path::new(&env::var("TENGRI_DATABASE_PASSWORD_FILE")?),
            Path::new(&env::var("TENGRI_DATABASE_CA_FILE")?),
            role,
        )
        .await
    }

    pub async fn connect(
        dsn: &str,
        password_file: &Path,
        ca_file: &Path,
        role: &str,
    ) -> anyhow::Result<Self> {
        ensure!(
            ["tengri_controller", "tengri_supervisor"].contains(&role),
            "invalid control database role"
        );
        let mut config: Config = dsn.parse()?;
        ensure!(
            config.get_user() == Some(role) && config.get_dbname() == Some("tengri_control"),
            "wrong control database identity"
        );
        ensure!(
            config.get_password().is_none() && config.get_ssl_mode() == SslMode::Require,
            "mounted password and database TLS required"
        );
        ensure!(
            matches!(config.get_hosts(), [Host::Tcp(host)] if host.parse::<std::net::IpAddr>().is_err()),
            "one database DNS host required"
        );
        let password = tokio::fs::read_to_string(password_file).await?;
        ensure!(!password.trim_end().is_empty(), "empty database password");
        config
            .password(password.trim_end())
            .application_name(role)
            .connect_timeout(Duration::from_secs(2));
        config.options("-c statement_timeout=2000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=5000 -c search_path=pg_catalog");
        let bytes = tokio::fs::read(ca_file).await?;
        let mut roots = RootCertStore::empty();
        for certificate in rustls_pemfile::certs(&mut bytes.as_slice()) {
            roots.add(certificate?)?;
        }
        ensure!(!roots.is_empty(), "empty database CA");
        let tls = MakeRustlsConnect::new(
            ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth(),
        );
        let manager = Manager::from_config(
            config,
            tls,
            ManagerConfig {
                recycling_method: RecyclingMethod::Fast,
            },
        );
        let pool = Pool::builder(manager)
            .max_size(if role == "tengri_controller" { 12 } else { 2 })
            .wait_timeout(Some(Duration::from_millis(500)))
            .create_timeout(Some(Duration::from_secs(2)))
            .recycle_timeout(Some(Duration::from_secs(2)))
            .runtime(deadpool_postgres::Runtime::Tokio1)
            .build()?;
        Ok(Self { pool })
    }

    #[cfg(test)]
    pub fn unconnected_fixture() -> Self {
        let mut config = Config::new();
        config.host("localhost").port(65534).user("unit-test");
        let tls = MakeRustlsConnect::new(
            ClientConfig::builder()
                .with_root_certificates(RootCertStore::empty())
                .with_no_client_auth(),
        );
        Self {
            pool: Pool::builder(Manager::new(config, tls))
                .max_size(1)
                .runtime(deadpool_postgres::Runtime::Tokio1)
                .build()
                .unwrap(),
        }
    }

    #[cfg(test)]
    pub async fn shared_fixture() -> Self {
        assert_eq!(
            std::env::var("TENGRI_RUNTIME_STATE_FIXTURE").as_deref(),
            Ok("1"),
            "disposable runtime fixture required"
        );
        let database = Self::from_environment("tengri_controller").await.unwrap();
        database.verify_schema().await.unwrap();
        database
    }

    pub async fn connection(&self) -> Result<deadpool_postgres::Object, Status> {
        self.pool
            .get()
            .await
            .map_err(|_| Status::unavailable("shared runtime state unavailable"))
    }

    pub async fn verify_schema(&self) -> Result<(), Status> {
        let client = self.connection().await?;
        let rows = client
            .query("SELECT version,checksum FROM tengri.schema_version", &[])
            .await
            .map_err(sql_error)?;
        if rows.len() != 1
            || rows[0].get::<_, i32>(0) != 1
            || rows[0].get::<_, Vec<u8>>(1) != Sha256::digest(SCHEMA).as_slice()
        {
            return Err(Status::failed_precondition(
                "shared runtime schema mismatch",
            ));
        }
        Ok(())
    }

    pub async fn consume_nonce(&self, key: &[u8], expires_at_ms: i64) -> Result<(), Status> {
        let client = self.connection().await?;
        let consumed: bool = client
            .query_one(
                "SELECT tengri.consume_nonce($1,$2)",
                &[&key, &expires_at_ms],
            )
            .await
            .map_err(sql_error)?
            .get(0);
        if !consumed {
            return Err(Status::unauthenticated("request nonce already used"));
        }
        Ok(())
    }

    pub async fn acquire(&self, owner: Uuid) -> Result<Option<Fence>, Status> {
        let client = self.connection().await?;
        let generation: Option<i64> = client
            .query_one("SELECT tengri.acquire_leadership($1)", &[&owner])
            .await
            .map_err(sql_error)?
            .get(0);
        Ok(generation.map(|generation| Fence { owner, generation }))
    }

    pub async fn renew(&self, fence: Fence) -> Result<bool, Status> {
        let client = self.connection().await?;
        Ok(client
            .query_one(
                "SELECT tengri.renew_leadership($1,$2)",
                &[&fence.owner, &fence.generation],
            )
            .await
            .map_err(sql_error)?
            .get(0))
    }

    pub async fn release(&self, fence: Fence) -> Result<(), Status> {
        let client = self.connection().await?;
        client
            .execute(
                "SELECT tengri.release_leadership($1,$2)",
                &[&fence.owner, &fence.generation],
            )
            .await
            .map_err(sql_error)?;
        Ok(())
    }

    pub async fn require_fence(&self, fence: Fence) -> Result<(), Status> {
        fence
            .validate()
            .map_err(|_| Status::permission_denied("invalid controller fence"))?;
        let client = self.connection().await?;
        let valid: bool = client.query_one("SELECT EXISTS(SELECT 1 FROM tengri.runtime_leader WHERE singleton AND owner=$1 AND generation=$2 AND expires_at_ms>tengri.now_ms())", &[&fence.owner,&fence.generation]).await.map_err(sql_error)?.get(0);
        if !valid {
            return Err(Status::permission_denied(
                "controller leadership expired or changed",
            ));
        }
        Ok(())
    }
}

pub fn sql_error(error: tokio_postgres::Error) -> Status {
    tracing::warn!(
        sqlstate = error.code().map(|c| c.code()),
        "shared runtime database operation failed"
    );
    match error.code().map(|code| code.code()) {
        Some("53300") => Status::resource_exhausted("shared runtime state capacity exhausted"),
        Some("22023") => Status::unauthenticated("invalid shared runtime deadline"),
        _ => Status::unavailable("shared runtime state unavailable"),
    }
}
