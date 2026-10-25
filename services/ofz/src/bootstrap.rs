use std::{
    fs::OpenOptions,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio_postgres::Client;
use tonic::Status;
use uuid::Uuid;

use crate::{
    decision,
    native::{Check, Native, Relationship, Update},
    policy::{self, BFF_ID, CONNECTOR_BROKER_ID, CONTROLLER_ID, KUBE_BROKER_ID},
    proto::{Action, RequestContext},
    store::{self, Database, State, sql_error},
};

const BOOTSTRAP_AUTHORITY: &str = "postgresql:ofz_control:ofz_migrator";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub operation_id: String,
    pub activation_operation_id: String,
    pub administrator_github_ids: [String; 2],
}

impl Manifest {
    pub fn read(path: &Path) -> anyhow::Result<Self> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(path)?;
        let metadata = file.metadata()?;
        anyhow::ensure!(
            metadata.is_file() && metadata.len() <= 16 * 1024 && metadata.mode() & 0o037 == 0,
            "bootstrap input must be a private bounded regular file"
        );
        let mut bytes = Vec::new();
        file.take(16 * 1024 + 1).read_to_end(&mut bytes)?;
        anyhow::ensure!(
            bytes.len() <= 16 * 1024,
            "bootstrap input exceeds its limit"
        );
        let manifest: Self = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("invalid bootstrap manifest"))?;
        Ok(manifest.validate()?)
    }

    fn validate(mut self) -> Result<Self, Status> {
        decision::parse_uuid(&self.operation_id)?;
        decision::parse_uuid(&self.activation_operation_id)?;
        if self.operation_id == self.activation_operation_id {
            return Err(Status::invalid_argument(
                "distinct bootstrap operation IDs required",
            ));
        }
        for id in &self.administrator_github_ids {
            policy::github_human_id(id)?;
        }
        self.administrator_github_ids.sort();
        if self.administrator_github_ids[0] == self.administrator_github_ids[1] {
            return Err(Status::invalid_argument(
                "two distinct initial administrators required",
            ));
        }
        Ok(self)
    }

    fn fingerprint(&self) -> Result<Vec<u8>, Status> {
        let mut hash = Sha256::new();
        hash.update(b"ofz-platform-bootstrap-v1\0");
        hash.update(crate::SCHEMA.as_bytes());
        hash.update(
            serde_json::to_vec(self).map_err(|_| Status::internal("encode bootstrap manifest"))?,
        );
        Ok(hash.finalize().to_vec())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Bootstrap,
    Activate,
}

impl Operation {
    fn previous_version(self) -> u64 {
        match self {
            Self::Bootstrap => 0,
            Self::Activate => 1,
        }
    }

    fn id(self, manifest: &Manifest) -> &str {
        match self {
            Self::Bootstrap => &manifest.operation_id,
            Self::Activate => &manifest.activation_operation_id,
        }
    }

    fn native_id(self, manifest: &Manifest) -> String {
        let prefix = match self {
            Self::Bootstrap => "bootstrap",
            Self::Activate => "activation",
        };
        format!("{prefix}_{}", self.id(manifest))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub operation_id: String,
    pub audit_receipt_id: String,
    pub policy_version: u64,
    pub revision: String,
    pub source_schema_sha256: String,
    pub installed_schema_sha256: String,
    pub committed_fenced: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub receipt: Receipt,
    pub current_policy_version: u64,
    pub current_recovery_generation: u64,
    pub current_platform_fenced: bool,
    pub current_archive_healthy: bool,
}

struct Record {
    manifest: Manifest,
    fingerprint: Vec<u8>,
    schema_hash: Option<Vec<u8>>,
    bootstrap_audit_id: Uuid,
    activation_audit_id: Uuid,
    phase: String,
    bootstrap_receipt: Option<serde_json::Value>,
    activation_receipt: Option<serde_json::Value>,
}

async fn owner(client: &Client) -> Result<(), Status> {
    let owns: bool = client.query_one(
        "SELECT current_user='ofz_migrator' AND current_database()='ofz_control' AND nspowner=current_user::regrole FROM pg_namespace WHERE nspname='ofz'",
        &[],
    ).await.map_err(sql_error)?.get(0);
    if !owns {
        return Err(Status::permission_denied(
            "authorization schema owner required",
        ));
    }
    Ok(())
}

async fn load(client: &Client) -> Result<Option<Record>, Status> {
    client.query_opt("SELECT manifest,fingerprint,schema_hash,bootstrap_audit_id,activation_audit_id,phase,bootstrap_receipt,activation_receipt FROM ofz.bootstrap WHERE singleton", &[])
        .await.map_err(sql_error)?.map(|row| Ok(Record {
            manifest: store::decode(row.get(0))?, fingerprint: row.get(1), schema_hash: row.get(2),
            bootstrap_audit_id: row.get(3), activation_audit_id: row.get(4), phase: row.get(5),
            bootstrap_receipt: row.get(6), activation_receipt: row.get(7),
        })).transpose()
}

async fn prepare(
    client: &Client,
    manifest: &Manifest,
    operation: Operation,
) -> Result<Record, Status> {
    let fingerprint = manifest.fingerprint()?;
    if load(client).await?.is_none() {
        if operation != Operation::Bootstrap {
            return Err(Status::failed_precondition("platform bootstrap required"));
        }
        let state = store::state(client).await?;
        expected_state(&state, operation)?;
        let empty: bool = client.query_one("SELECT NOT EXISTS(SELECT 1 FROM ofz.humans) AND NOT EXISTS(SELECT 1 FROM ofz.sessions) AND NOT EXISTS(SELECT 1 FROM ofz.reservations) AND NOT EXISTS(SELECT 1 FROM ofz.workspaces) AND NOT EXISTS(SELECT 1 FROM ofz.grants) AND NOT EXISTS(SELECT 1 FROM ofz.commands) AND (SELECT minimum_administrators=2 FROM ofz.platform_state)", &[]).await.map_err(sql_error)?.get(0);
        if !empty {
            return Err(Status::failed_precondition(
                "bootstrap requires an empty fenced authorization platform",
            ));
        }
        client.execute("INSERT INTO ofz.bootstrap(fingerprint,manifest,bootstrap_audit_id,activation_audit_id,phase) VALUES($1,$2,$3,$4,'initializing')", &[&fingerprint,&serde_json::to_value(manifest).map_err(|_| Status::internal("encode bootstrap manifest"))?,&Uuid::new_v4(),&Uuid::new_v4()]).await.map_err(sql_error)?;
    }
    let record = load(client)
        .await?
        .ok_or_else(|| Status::internal("missing bootstrap intent"))?;
    let completed = record.phase == "active"
        && record.bootstrap_receipt.is_some()
        && record.activation_receipt.is_some();
    if record.manifest.clone().validate()? != *manifest
        || (!completed && record.fingerprint != fingerprint)
    {
        return Err(Status::already_exists(
            "platform bound to a different bootstrap manifest or schema",
        ));
    }
    Ok(record)
}

fn expected_state(state: &State, operation: Operation) -> Result<(), Status> {
    if state.version != operation.previous_version()
        || !state.fenced
        || state.recovery_generation != 1
    {
        return Err(Status::failed_precondition(
            "bootstrap platform state changed",
        ));
    }
    Ok(())
}

fn changes(manifest: &Manifest) -> Result<Vec<Update>, Status> {
    let mut changes = Vec::new();
    for id in &manifest.administrator_github_ids {
        let human = policy::github_human_id(id)?;
        for relation in ["member", "administrator"] {
            changes.push(Update::touch(Relationship::new(
                "platform", "lab", relation, "human", &human,
            )));
        }
    }
    for (role, id) in [
        ("bff", BFF_ID),
        ("controller", CONTROLLER_ID),
        ("kube_broker", KUBE_BROKER_ID),
        ("connector_broker", CONNECTOR_BROKER_ID),
    ] {
        changes.push(Update::touch(Relationship::new(
            "platform",
            "lab",
            role,
            "workload",
            &policy::workload_object_id(id),
        )));
    }
    Ok(changes)
}

async fn archive_ready<C: tokio_postgres::GenericClient + Sync>(
    client: &C,
    bootstrap_audit_id: Uuid,
    exclude: Option<Uuid>,
) -> Result<(), Status> {
    let state = store::state(client).await?;
    let ready: bool = client.query_one("SELECT EXISTS(SELECT 1 FROM ofz.audit a CROSS JOIN ofz.archive_state s WHERE a.id=$1 AND a.sequence<=s.acknowledged_sequence) AND NOT EXISTS(SELECT 1 FROM ofz.audit a LEFT JOIN ofz.audit_outbox o ON o.audit_sequence=a.sequence CROSS JOIN ofz.archive_state s WHERE a.id IS DISTINCT FROM $2 AND (o.acknowledged_at_ms IS NULL OR a.sequence>s.acknowledged_sequence))", &[&bootstrap_audit_id,&exclude]).await.map_err(sql_error)?.get(0);
    if !state.archive_healthy || !ready {
        return Err(Status::failed_precondition(
            "independent archive must acknowledge bootstrap and prior audit receipts",
        ));
    }
    Ok(())
}

async fn initial_authority<C: tokio_postgres::GenericClient + Sync>(
    client: &C,
    native: &Native,
    manifest: &Manifest,
) -> Result<(), Status> {
    let humans = manifest
        .administrator_github_ids
        .iter()
        .map(|id| policy::github_human_id(id))
        .collect::<Result<Vec<_>, _>>()?;
    let ready: bool = client.query_one("SELECT count(*)=4 AND (SELECT minimum_administrators=2 FROM ofz.platform_state) FROM ofz.memberships WHERE human_id=ANY($1) AND role IN (1,2)", &[&humans]).await.map_err(sql_error)?.get(0);
    let expected = changes(manifest)?
        .into_iter()
        .map(|update| update.relationship)
        .collect::<Vec<_>>();
    let checks = expected
        .iter()
        .map(|relationship| Check {
            resource: relationship.resource.clone(),
            permission: relationship.relation.clone(),
            subject: relationship.subject.clone(),
        })
        .collect::<Vec<_>>();
    if !ready || !native.check(&checks).await?.0 || !native.platform_matches(&expected).await? {
        return Err(Status::failed_precondition(
            "initial administrator and workload authority changed",
        ));
    }
    Ok(())
}

async fn apply_native(
    client: &Client,
    native: &Native,
    record: &mut Record,
    operation: Operation,
) -> Result<String, Status> {
    expected_state(&store::state(client).await?, operation)?;
    if operation == Operation::Bootstrap && record.schema_hash.is_none() {
        let hash = native.install_schema().await?;
        client.execute("UPDATE ofz.bootstrap SET schema_hash=$1 WHERE singleton AND phase='initializing' AND schema_hash IS NULL", &[&hash]).await.map_err(sql_error)?;
        record.schema_hash = Some(hash);
    }
    let hash = record
        .schema_hash
        .as_ref()
        .ok_or_else(|| Status::failed_precondition("installed bootstrap schema required"))?;
    if native.schema_hash().await? != *hash {
        return Err(Status::failed_precondition(
            "installed authorization schema changed",
        ));
    }
    if operation == Operation::Activate {
        if !matches!(record.phase.as_str(), "initialized" | "activating") {
            return Err(Status::failed_precondition(
                "completed platform bootstrap required",
            ));
        }
        archive_ready(client, record.bootstrap_audit_id, None).await?;
        initial_authority(client, native, &record.manifest).await?;
        client.execute("UPDATE ofz.bootstrap SET phase='activating' WHERE singleton AND phase='initialized'", &[]).await.map_err(sql_error)?;
    }
    let id = operation.native_id(&record.manifest);
    let (applied, revision) = native.applied(&id).await?;
    if applied {
        return Ok(revision);
    }
    native
        .apply(
            &id,
            operation.previous_version(),
            &if operation == Operation::Bootstrap {
                changes(&record.manifest)?
            } else {
                Vec::new()
            },
        )
        .await
}

async fn finalize(
    client: &mut Client,
    native: &Native,
    record: &Record,
    operation: Operation,
    revision: String,
) -> Result<Receipt, Status> {
    let tx = client.transaction().await.map_err(sql_error)?;
    let state = store::state(&tx).await?;
    expected_state(&state, operation)?;
    let hash = record
        .schema_hash
        .as_ref()
        .ok_or_else(|| Status::internal("missing installed bootstrap schema"))?;
    if native.schema_hash().await? != *hash {
        return Err(Status::failed_precondition(
            "installed authorization schema changed",
        ));
    }
    if operation == Operation::Bootstrap {
        for id in &record.manifest.administrator_github_ids {
            let human = policy::github_human_id(id)?;
            tx.execute(
                "INSERT INTO ofz.humans(id,github_id) VALUES($1,$2)",
                &[&human, id],
            )
            .await
            .map_err(sql_error)?;
            tx.execute(
                "INSERT INTO ofz.memberships(human_id,role) VALUES($1,1),($1,2)",
                &[&human],
            )
            .await
            .map_err(sql_error)?;
        }
    } else {
        archive_ready(&tx, record.bootstrap_audit_id, None).await?;
        initial_authority(&tx, native, &record.manifest).await?;
    }
    let audit_id = if operation == Operation::Bootstrap {
        record.bootstrap_audit_id
    } else {
        record.activation_audit_id
    };
    let context = RequestContext {
        contract_version: crate::CONTRACT_VERSION,
        actor: Some(decision::workload_actor(BOOTSTRAP_AUTHORITY)),
        trace_id: operation.id(&record.manifest).into(),
        ..Default::default()
    };
    let mut audit = store::receipt(
        &context,
        BOOTSTRAP_AUTHORITY,
        policy::platform(),
        Action::PolicyCommand,
        true,
        operation.id(&record.manifest),
        &format!(
            "platform {operation:?} manifest {:x}",
            Sha256::digest(&record.fingerprint)
        ),
    );
    audit.id = audit_id.to_string();
    audit.created_at_unix_ms = state.now_ms;
    audit.revision = revision.clone();
    store::record_audit(&tx, &audit, "platform/bootstrap").await?;
    if operation == Operation::Activate {
        initial_authority(&tx, native, &record.manifest).await?;
        tx.query_one(
            "SELECT singleton FROM ofz.archive_state WHERE singleton FOR SHARE",
            &[],
        )
        .await
        .map_err(sql_error)?;
        archive_ready(&tx, record.bootstrap_audit_id, Some(audit_id)).await?;
    }
    let fenced = operation == Operation::Bootstrap;
    let updated = tx.execute("UPDATE ofz.platform_state SET version=$1,fenced=$2 WHERE version=$3 AND fenced AND recovery_generation=1", &[&((state.version+1) as i64),&fenced,&(state.version as i64)]).await.map_err(sql_error)?;
    if updated != 1 {
        return Err(Status::aborted("bootstrap platform state changed"));
    }
    let receipt = Receipt {
        operation_id: operation.id(&record.manifest).into(),
        audit_receipt_id: audit_id.to_string(),
        policy_version: state.version + 1,
        revision,
        source_schema_sha256: format!("{:x}", Sha256::digest(crate::SCHEMA.as_bytes())),
        installed_schema_sha256: hash.iter().map(|byte| format!("{byte:02x}")).collect(),
        committed_fenced: fenced,
    };
    let value =
        serde_json::to_value(&receipt).map_err(|_| Status::internal("encode bootstrap receipt"))?;
    let statement = if operation == Operation::Bootstrap {
        "UPDATE ofz.bootstrap SET phase='initialized',bootstrap_receipt=$1 WHERE singleton AND phase='initializing'"
    } else {
        "UPDATE ofz.bootstrap SET phase='active',activation_receipt=$1 WHERE singleton AND phase='activating'"
    };
    if tx.execute(statement, &[&value]).await.map_err(sql_error)? != 1 {
        return Err(Status::aborted("bootstrap intent changed"));
    }
    tx.commit().await.map_err(sql_error)?;
    Ok(receipt)
}

pub async fn execute(
    database: &Database,
    native: &Native,
    operation: Operation,
    manifest: Manifest,
) -> Result<Report, Status> {
    let manifest = manifest.validate()?;
    database.verify_schema().await?;
    let mut connection = database.command_connection().await?;
    owner(&connection.client).await?;
    let mut record = prepare(&connection.client, &manifest, operation).await?;
    let existing = if operation == Operation::Bootstrap {
        record.bootstrap_receipt.clone()
    } else {
        record.activation_receipt.clone()
    };
    let receipt = if let Some(value) = existing {
        store::decode(value)?
    } else {
        let revision = apply_native(&connection.client, native, &mut record, operation).await?;
        finalize(&mut connection.client, native, &record, operation, revision).await?
    };
    let current = store::state(&connection.client).await?;
    Ok(Report {
        receipt,
        current_policy_version: current.version,
        current_recovery_generation: current.recovery_generation,
        current_platform_fenced: current.fenced,
        current_archive_healthy: current.archive_healthy,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::{ClientConfig, RootCertStore};
    use std::{env, fs, os::unix::fs::PermissionsExt, time::Duration};
    use tokio_postgres::Config;
    use tokio_postgres_rustls::MakeRustlsConnect;

    fn manifest() -> Manifest {
        Manifest {
            operation_id: Uuid::new_v4().to_string(),
            activation_operation_id: Uuid::new_v4().to_string(),
            administrator_github_ids: ["1".into(), "2".into()],
        }
    }

    #[test]
    fn manifest_requires_two_canonical_distinct_accounts_and_operations() {
        for ids in [
            ["1", "1"],
            ["0", "2"],
            ["01", "2"],
            ["-1", "2"],
            ["1", "222222222222222222222"],
        ] {
            let mut value = manifest();
            value.administrator_github_ids = ids.map(String::from);
            assert!(value.validate().is_err());
        }
        let mut value = manifest();
        value.activation_operation_id = value.operation_id.clone();
        assert!(value.validate().is_err());
        let value = manifest().validate().unwrap();
        let mut reversed = value.clone();
        reversed.administrator_github_ids.reverse();
        assert_eq!(
            value.fingerprint().unwrap(),
            reversed.validate().unwrap().fingerprint().unwrap()
        );
        for operation in [Operation::Bootstrap, Operation::Activate] {
            assert!(decision::parse_uuid(&operation.native_id(&value)).is_err());
        }
    }

    #[test]
    fn manifest_file_is_private_regular_bounded_and_strict() {
        let directory = env::temp_dir().join(format!("ofz-bootstrap-input-{}", Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("manifest.json");
        fs::write(&path, serde_json::to_vec(&manifest()).unwrap()).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(Manifest::read(&path).is_ok());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(Manifest::read(&path).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        fs::write(&path, vec![b' '; 16 * 1024 + 1]).unwrap();
        assert!(Manifest::read(&path).is_err());
        let mut value = serde_json::to_value(manifest()).unwrap();
        value["legacyOwner"] = serde_json::json!("1");
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(Manifest::read(&path).is_err());
        assert!(Manifest::read(&directory).is_err());
        fs::remove_dir_all(directory).unwrap();
    }

    async fn fixture() -> (Database, Database, Database, Database, Native) {
        rustls::crypto::aws_lc_rs::default_provider()
            .install_default()
            .ok();
        let config: Config = env::var("OFZ_TEST_DSN")
            .expect("run test-control.sh bootstrap")
            .parse()
            .unwrap();
        let mut roots = RootCertStore::empty();
        let bytes = fs::read(env::var("OFZ_TEST_CA_FILE").unwrap()).unwrap();
        for cert in rustls_pemfile::certs(&mut bytes.as_slice()) {
            roots.add(cert.unwrap()).unwrap();
        }
        let tls = MakeRustlsConnect::new(
            ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth(),
        );
        let root = Database::new(config.clone(), tls.clone()).unwrap();
        root.pool.get().await.unwrap().batch_execute("CREATE ROLE ofz_migrator LOGIN PASSWORD 'bootstrap-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; CREATE ROLE ofz_api LOGIN PASSWORD 'bootstrap-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; CREATE ROLE ofz_archiver LOGIN PASSWORD 'bootstrap-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; GRANT CREATE ON DATABASE ofz_control TO ofz_migrator;").await.unwrap();
        let databases = ["ofz_migrator", "ofz_api", "ofz_archiver"].map(|role| {
            let mut role_config = config.clone();
            role_config
                .user(role)
                .password("bootstrap-fixture")
                .application_name("ofz-bootstrap-fixture");
            Database::new(role_config, tls.clone()).unwrap()
        });
        let [owner, api, archiver] = databases;
        let created = std::sync::Arc::new(tokio::sync::Notify::new());
        let resume = std::sync::Arc::new(tokio::sync::Notify::new());
        let interrupted_owner = owner
            .clone()
            .with_migration_barrier(created.clone(), resume);
        let interrupted = tokio::spawn(async move { interrupted_owner.migrate().await });
        tokio::time::timeout(Duration::from_secs(5), created.notified())
            .await
            .expect("migration did not reach checksum boundary");
        assert!(
            root.pool
                .get()
                .await
                .unwrap()
                .query_one("SELECT to_regclass('ofz.schema_version') IS NULL", &[])
                .await
                .unwrap()
                .get::<_, bool>(0)
        );
        interrupted.abort();
        assert!(interrupted.await.unwrap_err().is_cancelled());
        owner.migrate().await.unwrap();
        owner.migrate().await.unwrap();
        let checksum: Vec<u8> = owner
            .pool
            .get()
            .await
            .unwrap()
            .query_one("SELECT checksum FROM ofz.schema_version", &[])
            .await
            .unwrap()
            .get(0);
        root.pool.get().await.unwrap().batch_execute("ALTER TABLE ofz.schema_version ALTER COLUMN checksum DROP NOT NULL; UPDATE ofz.schema_version SET checksum=NULL").await.unwrap();
        assert_eq!(
            owner.migrate().await.unwrap_err().code(),
            tonic::Code::FailedPrecondition
        );
        assert!(
            owner
                .pool
                .get()
                .await
                .unwrap()
                .query_one("SELECT checksum IS NULL FROM ofz.schema_version", &[])
                .await
                .unwrap()
                .get::<_, bool>(0)
        );
        owner
            .pool
            .get()
            .await
            .unwrap()
            .execute("UPDATE ofz.schema_version SET checksum=$1", &[&checksum])
            .await
            .unwrap();
        root.pool
            .get()
            .await
            .unwrap()
            .batch_execute("ALTER TABLE ofz.schema_version ALTER COLUMN checksum SET NOT NULL")
            .await
            .unwrap();
        let native = Native::new(
            &env::var("OFZ_TEST_NATIVE_ENDPOINT").unwrap(),
            env::var("OFZ_TEST_NATIVE_KEY_FILE").unwrap().into(),
        )
        .unwrap();
        (root, owner, api, archiver, native)
    }

    async fn acknowledge(archiver: &Database) {
        archiver.pool.get().await.unwrap().batch_execute("BEGIN; UPDATE ofz.audit_outbox SET acknowledged_at_ms=ofz.now_ms(),archive_receipt='bootstrap-control-fixture-only'; UPDATE ofz.archive_state SET acknowledged_sequence=coalesce((SELECT max(sequence) FROM ofz.audit),0),acknowledged_at_ms=ofz.now_ms(); COMMIT;").await.unwrap();
    }

    async fn write_fixture_relationship(update: Update) {
        let response = reqwest::Client::new()
            .post(format!(
                "{}/v1/relationships/write",
                env::var("OFZ_TEST_NATIVE_ENDPOINT").unwrap()
            ))
            .bearer_auth("ofz-policy-fixture")
            .json(&serde_json::json!({"updates": [update]}))
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
    }

    async fn cli(role: &str, operation: &str, manifest: &Manifest) -> std::process::Output {
        let directory = env::temp_dir().join(format!("ofz-bootstrap-cli-{}", Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let input = directory.join("manifest.json");
        let password = directory.join("password");
        fs::write(&input, serde_json::to_vec(manifest).unwrap()).unwrap();
        fs::write(&password, b"bootstrap-fixture").unwrap();
        for path in [&input, &password] {
            fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        }
        let dsn = env::var("OFZ_TEST_DSN").unwrap();
        assert!(dsn.contains("user=postgres"));
        let mut command = std::process::Command::new(
            env::var("OFZ_BOOTSTRAP_CLI_FIXTURE")
                .expect("test-control.sh bootstrap builds the real CLI"),
        );
        command
            .arg(operation)
            .arg(&input)
            .env(
                "OFZ_DATABASE_DSN",
                dsn.replace("user=postgres", &format!("user={role}")),
            )
            .env("OFZ_DATABASE_PASSWORD_FILE", &password)
            .env(
                "OFZ_DATABASE_CA_FILE",
                env::var("OFZ_TEST_CA_FILE").unwrap(),
            )
            .env(
                "OFZ_SPICEDB_ENDPOINT",
                env::var("OFZ_TEST_NATIVE_ENDPOINT").unwrap(),
            )
            .env(
                "OFZ_SPICEDB_KEY_FILE",
                env::var("OFZ_TEST_NATIVE_KEY_FILE").unwrap(),
            );
        let output = tokio::task::spawn_blocking(move || command.output())
            .await
            .unwrap()
            .unwrap();
        fs::remove_dir_all(directory).unwrap();
        output
    }

    async fn wait_for_audit_insert(root: &Database) {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let blocked: bool = root.pool.get().await.unwrap().query_one("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='ofz_migrator' AND wait_event_type='Lock' AND query LIKE 'INSERT INTO ofz.audit(%')", &[]).await.unwrap().get(0);
                if blocked { break; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.expect("activation did not reach the audit insertion barrier");
    }

    #[tokio::test]
    #[ignore = "requires isolated real TLS PostgreSQL and SpiceDB; run test-control.sh bootstrap"]
    async fn real_bootstrap_activation_and_interrupted_retries() {
        let (root, database, api, archiver, native) = fixture().await;
        let manifest = manifest();
        let legacy = reqwest::Client::new()
            .post(format!(
                "{}/v1/schema/write",
                env::var("OFZ_TEST_NATIVE_ENDPOINT").unwrap()
            ))
            .bearer_auth("ofz-policy-fixture")
            .json(&serde_json::json!({"schema":"definition retired_user {}"}))
            .send()
            .await
            .unwrap();
        assert!(legacy.status().is_success());
        let legacy_hash = native.schema_hash().await.unwrap();
        assert!(
            !cli("ofz_api", "bootstrap", &manifest)
                .await
                .status
                .success()
        );
        assert_eq!(
            execute(&api, &native, Operation::Bootstrap, manifest.clone())
                .await
                .err()
                .unwrap()
                .code(),
            tonic::Code::PermissionDenied
        );
        assert!(
            load(&database.pool.get().await.unwrap())
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            execute(&database, &native, Operation::Activate, manifest.clone())
                .await
                .err()
                .unwrap()
                .code(),
            tonic::Code::FailedPrecondition
        );

        let unapproved = policy::github_human_id("3").unwrap();
        api.pool
            .get()
            .await
            .unwrap()
            .execute(
                "INSERT INTO ofz.humans(id,github_id) VALUES($1,'3')",
                &[&unapproved],
            )
            .await
            .unwrap();
        assert_eq!(
            execute(&database, &native, Operation::Bootstrap, manifest.clone())
                .await
                .err()
                .unwrap()
                .code(),
            tonic::Code::FailedPrecondition
        );
        database
            .pool
            .get()
            .await
            .unwrap()
            .execute("DELETE FROM ofz.humans WHERE id=$1", &[&unapproved])
            .await
            .unwrap();
        assert_eq!(native.schema_hash().await.unwrap(), legacy_hash);

        let connection = database.command_connection().await.unwrap();
        owner(&connection.client).await.unwrap();
        let mut record = prepare(&connection.client, &manifest, Operation::Bootstrap)
            .await
            .unwrap();
        apply_native(
            &connection.client,
            &native,
            &mut record,
            Operation::Bootstrap,
        )
        .await
        .unwrap();
        assert_eq!(store::state(&connection.client).await.unwrap().version, 0);
        assert_ne!(record.schema_hash.as_ref().unwrap(), &legacy_hash);
        assert!(store::state(&connection.client).await.unwrap().fenced);
        drop(connection);

        let immutable_error = api
            .pool
            .get()
            .await
            .unwrap()
            .execute("UPDATE ofz.bootstrap SET manifest=manifest", &[])
            .await
            .unwrap_err();
        assert_eq!(
            immutable_error.code(),
            Some(&tokio_postgres::error::SqlState::INSUFFICIENT_PRIVILEGE)
        );
        let mut tampered = manifest.clone();
        tampered.administrator_github_ids = ["3".into(), "4".into()];
        database
            .pool
            .get()
            .await
            .unwrap()
            .execute(
                "UPDATE ofz.bootstrap SET manifest=$1",
                &[&serde_json::to_value(&tampered).unwrap()],
            )
            .await
            .unwrap();
        assert_eq!(
            execute(&database, &native, Operation::Bootstrap, manifest.clone())
                .await
                .err()
                .unwrap()
                .code(),
            tonic::Code::AlreadyExists
        );
        database
            .pool
            .get()
            .await
            .unwrap()
            .execute(
                "UPDATE ofz.bootstrap SET manifest=$1",
                &[&serde_json::to_value(&manifest).unwrap()],
            )
            .await
            .unwrap();

        let changed_schema = reqwest::Client::new().post(format!("{}/v1/schema/write",env::var("OFZ_TEST_NATIVE_ENDPOINT").unwrap()))
            .bearer_auth("ofz-policy-fixture").json(&serde_json::json!({"schema":format!("{}\ndefinition unreviewed_bootstrap_type {{}}",crate::SCHEMA)})).send().await.unwrap();
        assert!(changed_schema.status().is_success());
        assert_eq!(
            execute(&database, &native, Operation::Bootstrap, manifest.clone())
                .await
                .err()
                .unwrap()
                .code(),
            tonic::Code::FailedPrecondition
        );
        assert!(database.state().await.unwrap().fenced);
        native.install_schema().await.unwrap();
        let initialized_cli = cli("ofz_migrator", "bootstrap", &manifest).await;
        assert!(
            initialized_cli.status.success(),
            "{}",
            String::from_utf8_lossy(&initialized_cli.stderr)
        );
        let cli_report: serde_json::Value =
            serde_json::from_slice(&initialized_cli.stdout).unwrap();

        let bootstrapped = execute(&database, &native, Operation::Bootstrap, manifest.clone())
            .await
            .unwrap();
        assert_eq!(bootstrapped.receipt.policy_version, 1);
        assert_eq!(
            serde_json::from_value::<Receipt>(cli_report["receipt"].clone()).unwrap(),
            bootstrapped.receipt
        );
        assert!(bootstrapped.current_platform_fenced);
        assert!(!bootstrapped.current_archive_healthy);
        assert_eq!(
            bootstrapped.receipt,
            execute(&database, &native, Operation::Bootstrap, manifest.clone())
                .await
                .unwrap()
                .receipt
        );
        let mut previous_build = Sha256::new();
        previous_build.update(b"ofz-platform-bootstrap-v1\0");
        previous_build.update(b"previous reviewed compiled schema");
        previous_build.update(serde_json::to_vec(&manifest).unwrap());
        let historical_fingerprint = previous_build.finalize().to_vec();
        let client = database.pool.get().await.unwrap();
        client
            .execute(
                "UPDATE ofz.bootstrap SET fingerprint=$1 WHERE singleton",
                &[&historical_fingerprint],
            )
            .await
            .unwrap();
        for operation in [Operation::Bootstrap, Operation::Activate] {
            assert_eq!(
                execute(&database, &native, operation, manifest.clone())
                    .await
                    .err()
                    .unwrap()
                    .code(),
                tonic::Code::AlreadyExists
            );
        }
        client
            .execute(
                "UPDATE ofz.bootstrap SET fingerprint=$1 WHERE singleton",
                &[&manifest.fingerprint().unwrap()],
            )
            .await
            .unwrap();
        drop(client);
        let mut changed = manifest.clone();
        changed.administrator_github_ids = ["3".into(), "4".into()];
        assert_eq!(
            execute(&database, &native, Operation::Bootstrap, changed)
                .await
                .err()
                .unwrap()
                .code(),
            tonic::Code::AlreadyExists
        );
        assert_eq!(
            execute(&database, &native, Operation::Activate, manifest.clone())
                .await
                .err()
                .unwrap()
                .code(),
            tonic::Code::FailedPrecondition
        );
        acknowledge(&archiver).await;

        let surplus = [
            Relationship::new("platform", "lab", "administrator", "human", &unapproved),
            Relationship::new(
                "platform",
                "lab",
                "kube_broker",
                "workload",
                &policy::workload_object_id(BFF_ID),
            ),
            Relationship::new("platform", "retired", "member", "human", &unapproved),
        ];
        for relationship in &surplus {
            write_fixture_relationship(Update::touch(relationship.clone())).await;
            assert_eq!(
                execute(&database, &native, Operation::Activate, manifest.clone())
                    .await
                    .err()
                    .expect("surplus native authority must keep activation fenced")
                    .code(),
                tonic::Code::FailedPrecondition
            );
            assert!(database.state().await.unwrap().fenced);
            assert_eq!(database.state().await.unwrap().version, 1);
            assert!(
                !native
                    .applied(&Operation::Activate.native_id(&manifest))
                    .await
                    .unwrap()
                    .0
            );
            write_fixture_relationship(Update::delete(relationship.clone())).await;
        }

        let second = policy::github_human_id("2").unwrap();
        database
            .pool
            .get()
            .await
            .unwrap()
            .execute(
                "DELETE FROM ofz.memberships WHERE human_id=$1 AND role=2",
                &[&second],
            )
            .await
            .unwrap();
        assert_eq!(
            execute(&database, &native, Operation::Activate, manifest.clone())
                .await
                .err()
                .unwrap()
                .code(),
            tonic::Code::FailedPrecondition
        );
        database
            .pool
            .get()
            .await
            .unwrap()
            .execute(
                "INSERT INTO ofz.memberships(human_id,role) VALUES($1,2)",
                &[&second],
            )
            .await
            .unwrap();

        let mut lock_client = root.pool.get().await.unwrap();
        let lock = lock_client.transaction().await.unwrap();
        lock.batch_execute("LOCK TABLE ofz.audit IN SHARE MODE")
            .await
            .unwrap();
        let pending_database = database.clone();
        let pending_native = native.clone();
        let pending_manifest = manifest.clone();
        let activation = tokio::spawn(async move {
            execute(
                &pending_database,
                &pending_native,
                Operation::Activate,
                pending_manifest,
            )
            .await
        });
        wait_for_audit_insert(&root).await;
        archiver
            .pool
            .get()
            .await
            .unwrap()
            .batch_execute("UPDATE ofz.archive_state SET acknowledged_at_ms=0")
            .await
            .unwrap();
        lock.commit().await.unwrap();
        assert_eq!(
            activation.await.unwrap().err().unwrap().code(),
            tonic::Code::FailedPrecondition
        );
        assert!(database.state().await.unwrap().fenced);
        assert_eq!(database.state().await.unwrap().version, 1);
        assert!(
            native
                .applied(&Operation::Activate.native_id(&manifest))
                .await
                .unwrap()
                .0
        );
        assert_eq!(
            database
                .pool
                .get()
                .await
                .unwrap()
                .query_one("SELECT count(*) FROM ofz.audit", &[])
                .await
                .unwrap()
                .get::<_, i64>(0),
            1
        );
        assert_eq!(
            execute(&database, &native, Operation::Activate, manifest.clone())
                .await
                .err()
                .unwrap()
                .code(),
            tonic::Code::FailedPrecondition
        );

        acknowledge(&archiver).await;
        for added in [None, Some(surplus[1].clone())] {
            let checked = std::sync::Arc::new(tokio::sync::Notify::new());
            let resume = std::sync::Arc::new(tokio::sync::Notify::new());
            let barrier_native = native
                .clone()
                .with_check_barrier(checked.clone(), resume.clone());
            let mut connection = database.command_connection().await.unwrap();
            let record = load(&connection.client).await.unwrap().unwrap();
            let revision = native
                .applied(&Operation::Activate.native_id(&manifest))
                .await
                .unwrap()
                .1;
            let late_activation = tokio::spawn(async move {
                finalize(
                    &mut connection.client,
                    &barrier_native,
                    &record,
                    Operation::Activate,
                    revision,
                )
                .await
            });
            for pass in 0..2 {
                tokio::time::timeout(Duration::from_secs(5), checked.notified())
                    .await
                    .expect("activation did not reach its authority check");
                if pass == 1 {
                    if let Some(relationship) = &added {
                        write_fixture_relationship(Update::touch(relationship.clone())).await;
                    } else {
                        archiver
                            .pool
                            .get()
                            .await
                            .unwrap()
                            .batch_execute("UPDATE ofz.archive_state SET acknowledged_at_ms=0")
                            .await
                            .unwrap();
                    }
                }
                resume.notify_one();
            }
            assert_eq!(
                late_activation.await.unwrap().err().unwrap().code(),
                tonic::Code::FailedPrecondition
            );
            assert!(database.state().await.unwrap().fenced);
            assert_eq!(database.state().await.unwrap().version, 1);
            if let Some(relationship) = added {
                write_fixture_relationship(Update::delete(relationship)).await;
            }
            acknowledge(&archiver).await;
        }
        let activated = execute(&database, &native, Operation::Activate, manifest.clone())
            .await
            .unwrap();
        assert_eq!(activated.receipt.policy_version, 2);
        assert!(!activated.current_platform_fenced);
        assert_eq!(
            activated.receipt,
            execute(&database, &native, Operation::Activate, manifest.clone())
                .await
                .unwrap()
                .receipt
        );
        let installed_schema = native.schema_hash().await.unwrap();
        database
            .pool
            .get()
            .await
            .unwrap()
            .execute(
                "UPDATE ofz.bootstrap SET fingerprint=$1 WHERE singleton AND phase='active'",
                &[&historical_fingerprint],
            )
            .await
            .unwrap();
        for (operation, command, original) in [
            (Operation::Bootstrap, "bootstrap", &bootstrapped.receipt),
            (Operation::Activate, "activate", &activated.receipt),
        ] {
            let replay = execute(&database, &native, operation, manifest.clone())
                .await
                .unwrap();
            assert_eq!(&replay.receipt, original);
            assert_eq!(replay.current_policy_version, 2);
            assert!(!replay.current_platform_fenced);
            let replay_cli = cli("ofz_migrator", command, &manifest).await;
            assert!(
                replay_cli.status.success(),
                "{}",
                String::from_utf8_lossy(&replay_cli.stderr)
            );
            let report: serde_json::Value = serde_json::from_slice(&replay_cli.stdout).unwrap();
            assert_eq!(report["receipt"], serde_json::to_value(original).unwrap());
        }
        assert_eq!(native.schema_hash().await.unwrap(), installed_schema);
        let mut changed_administrators = manifest.clone();
        changed_administrators.administrator_github_ids = ["3".into(), "4".into()];
        let mut changed_operations = manifest.clone();
        changed_operations.operation_id = Uuid::new_v4().to_string();
        for changed in [changed_administrators, changed_operations] {
            for operation in [Operation::Bootstrap, Operation::Activate] {
                assert_eq!(
                    execute(&database, &native, operation, changed.clone())
                        .await
                        .err()
                        .unwrap()
                        .code(),
                    tonic::Code::AlreadyExists
                );
            }
        }
        let audit = database
            .pool
            .get()
            .await
            .unwrap()
            .query_one(
                "SELECT receipt FROM ofz.audit WHERE id=$1",
                &[&decision::parse_uuid(&activated.receipt.audit_receipt_id).unwrap()],
            )
            .await
            .unwrap()
            .get::<_, serde_json::Value>(0);
        assert_eq!(audit["workload_id"], BOOTSTRAP_AUTHORITY);
        assert_eq!(
            database
                .pool
                .get()
                .await
                .unwrap()
                .query_one("SELECT count(*) FROM ofz.audit", &[])
                .await
                .unwrap()
                .get::<_, i64>(0),
            2
        );

        assert!(!native.applied(&manifest.operation_id).await.unwrap().0);
        let first = policy::github_human_id("1").unwrap();
        native
            .apply(
                &manifest.operation_id,
                2,
                &[Update::delete(Relationship::new(
                    "platform",
                    "lab",
                    "administrator",
                    "human",
                    &first,
                ))],
            )
            .await
            .unwrap();
        database
            .pool
            .get()
            .await
            .unwrap()
            .execute(
                "DELETE FROM ofz.memberships WHERE human_id=$1 AND role=2",
                &[&first],
            )
            .await
            .unwrap();
        database
            .pool
            .get()
            .await
            .unwrap()
            .batch_execute(
                "UPDATE ofz.platform_state SET version=3,fenced=true,recovery_generation=2",
            )
            .await
            .unwrap();
        let replay = execute(&database, &native, Operation::Activate, manifest.clone())
            .await
            .unwrap();
        assert_eq!(replay.receipt, activated.receipt);
        assert!(replay.current_platform_fenced);
        assert_eq!(replay.current_recovery_generation, 2);
        let replay_cli = cli("ofz_migrator", "activate", &manifest).await;
        assert!(
            replay_cli.status.success(),
            "{}",
            String::from_utf8_lossy(&replay_cli.stderr)
        );
        let cli_report: serde_json::Value = serde_json::from_slice(&replay_cli.stdout).unwrap();
        assert_eq!(cli_report["currentPlatformFenced"], true);
        assert_eq!(cli_report["currentRecoveryGeneration"], 2);
        assert_eq!(
            execute(&database, &native, Operation::Bootstrap, manifest)
                .await
                .unwrap()
                .receipt,
            bootstrapped.receipt
        );
        assert!(
            !native
                .check(&[Check::new(
                    "platform",
                    "lab",
                    "administrator",
                    "human",
                    &first
                )])
                .await
                .unwrap()
                .0
        );
        assert_eq!(
            database
                .pool
                .get()
                .await
                .unwrap()
                .query_one("SELECT count(*) FROM ofz.audit", &[])
                .await
                .unwrap()
                .get::<_, i64>(0),
            2
        );
        println!(
            "PASS: owner-only two-administrator bootstrap; interrupted native write recovery; immutable retries; archive-gated activation; exact native platform relationships; in-flight archive and surplus-authority failure; marker domain separation; recovery/offboarding replay stays fenced"
        );
    }
}
