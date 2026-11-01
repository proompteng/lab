use sha2::{Digest, Sha256};
use tonic::Status;
use uuid::Uuid;

use super::catalog;
use crate::{
    native::{Native, Relationship, Update},
    registry,
    store::{self, Database, sql_error},
};

pub fn decode_hash(value: &str) -> Result<Vec<u8>, Status> {
    let value = value.trim();
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(Status::invalid_argument("a SHA-256 digest is required"));
    }
    (0..64)
        .step_by(2)
        .map(|offset| {
            u8::from_str_radix(&value[offset..offset + 2], 16)
                .map_err(|_| Status::invalid_argument("invalid SHA-256 digest"))
        })
        .collect()
}

pub fn registry_hash() -> Result<Vec<u8>, Status> {
    let bytes = serde_json::to_vec(registry::configured()?)
        .map_err(|_| Status::internal("encode service registry"))?;
    Ok(Sha256::digest(bytes).to_vec())
}

pub fn expected_schema_hash() -> Result<Vec<u8>, Status> {
    match std::env::var("OFZ_POLICY_SCHEMA_SHA256_FILE") {
        Ok(path) => decode_hash(
            &std::fs::read_to_string(path)
                .map_err(|_| Status::failed_precondition("policy schema digest is unavailable"))?,
        ),
        Err(std::env::VarError::NotPresent) => {
            decode_hash(include_str!("../../platform/schema.sha256"))
        }
        Err(_) => Err(Status::invalid_argument(
            "invalid policy schema digest path",
        )),
    }
}

struct VerifiedPackage {
    command_pending: bool,
}

async fn verified_package(database: &Database) -> Result<VerifiedPackage, Status> {
    let client = database
        .pool
        .get()
        .await
        .map_err(|_| Status::unavailable("platform database pool unavailable"))?;
    let row = client.query_opt("SELECT catalog_hash,registry_hash,desired_hash,EXISTS(SELECT 1 FROM ofz.platform_commands WHERE NOT completed) FROM ofz.platform_policy_installations WHERE completed AND NOT EXISTS(SELECT 1 FROM ofz.platform_policy_installations WHERE NOT completed) ORDER BY completed_at_ms DESC LIMIT 1", &[])
        .await.map_err(sql_error)?.ok_or_else(|| Status::failed_precondition("platform policies are not onboarded"))?;
    if row.get::<_, Vec<u8>>(0) != catalog::configured()?.checksum()?
        || row.get::<_, Vec<u8>>(1) != registry_hash()?
        || row.get::<_, Vec<u8>>(2) != expected_schema_hash()?
    {
        return Err(Status::failed_precondition(
            "platform policy package mismatch",
        ));
    }
    Ok(VerifiedPackage {
        command_pending: row.get(3),
    })
}

pub async fn verify(database: &Database) -> Result<(), Status> {
    if verified_package(database).await?.command_pending {
        return Err(Status::failed_precondition(
            "platform policy command requires recovery",
        ));
    }
    Ok(())
}

pub(crate) async fn verify_configuration(database: &Database) -> Result<(), Status> {
    verified_package(database).await.map(|_| ())
}

async fn workspace_seed(
    client: &tokio_postgres::Client,
    native: &Native,
) -> Result<Vec<Update>, Status> {
    let members = client.query("SELECT m.human_id,m.role FROM ofz.memberships m WHERE EXISTS (SELECT 1 FROM ofz.memberships admitted WHERE admitted.human_id=m.human_id AND admitted.role=1) AND m.role IN (1,2) ORDER BY m.human_id,m.role", &[]).await.map_err(sql_error)?;
    let mut changes = Vec::new();
    for workspace in &registry::configured()?.workspaces {
        for resource in &workspace.resources {
            if !catalog::configured()?
                .resource(&resource.kind)?
                .workspace_scoped
            {
                return Err(Status::failed_precondition(
                    "workspace resource must use a scoped policy definition",
                ));
            }
        }
        let marker = format!("workspace-enrollment/{}", workspace.id);
        if native.applied(&marker).await?.0 {
            continue;
        }
        changes.push(Update::touch(Relationship::new(
            "platform_workspace",
            &workspace.id,
            "platform",
            "platform",
            "lab",
        )));
        for row in &members {
            let role: i32 = row.get(1);
            if role == 2 || workspace.import_platform_members {
                changes.push(Update::touch(Relationship::new(
                    "platform_workspace",
                    &workspace.id,
                    if role == 2 { "administrator" } else { "member" },
                    "human",
                    &row.get::<_, String>(0),
                )));
            }
        }
        for service in &workspace.initial_clients {
            for identity in &registry::configured()?
                .by_id(service)
                .ok_or_else(|| {
                    Status::failed_precondition("workspace client registration disappeared")
                })?
                .identities
            {
                changes.push(Update::touch(Relationship::new(
                    "platform_workspace",
                    &workspace.id,
                    "client",
                    "workload",
                    &crate::policy::workload_object_id(identity),
                )));
            }
        }
        changes.push(Update::touch(Relationship::new(
            "applied_command",
            &marker,
            "committed",
            "workload",
            &crate::policy::workload_object_id(crate::policy::OFZ_ID),
        )));
    }
    if changes.len() > 512 {
        return Err(Status::failed_precondition(
            "workspace enrollment exceeds its atomic relationship budget",
        ));
    }
    Ok(changes)
}

pub async fn execute(database: &Database, native: &Native) -> Result<String, Status> {
    let catalog_hash = catalog::configured()?.checksum()?;
    let registry_hash = registry_hash()?;
    let extension = match std::env::var("OFZ_POLICY_SCHEMA_FILE") {
        Ok(path) => std::fs::read_to_string(path)
            .map_err(|_| Status::failed_precondition("policy schema is unavailable"))?,
        Err(std::env::VarError::NotPresent) => include_str!("../../platform/schema.zed").to_owned(),
        Err(_) => return Err(Status::invalid_argument("invalid policy schema path")),
    };
    if extension.len() > 1024 * 1024 {
        return Err(Status::invalid_argument(
            "policy schema exceeds its byte budget",
        ));
    }
    let desired_hash = expected_schema_hash()?;
    let schema = format!("{}\n{extension}", crate::SCHEMA);
    let mut connection = database.command_connection().await?;
    let client = &mut connection.client;
    crate::commands::reconcile(database, native, client).await?;
    let identity = client
        .query_one("SELECT current_user,current_database()", &[])
        .await
        .map_err(sql_error)?;
    let owner: String = identity.get(0);
    let correct_owner = owner == "ofz_migrator" || cfg!(test) && owner == "postgres";
    if !correct_owner || identity.get::<_, String>(1) != "ofz_control" {
        return Err(Status::permission_denied(
            "policy onboarding requires the control migration owner",
        ));
    }
    let installed = native.schema_hash().await?;
    let pending = client.query_opt("SELECT operation_id,previous_hash,desired_hash,catalog_hash,registry_hash,schema_text,expected_version,workspace_changes FROM ofz.platform_policy_installations WHERE NOT completed", &[]).await.map_err(sql_error)?;
    let (operation, previous_hash, expected_version, workspace_changes) = if let Some(row) = pending
    {
        if row.get::<_, Vec<u8>>(2) != desired_hash
            || row.get::<_, Vec<u8>>(3) != catalog_hash
            || row.get::<_, Vec<u8>>(4) != registry_hash
            || row.get::<_, String>(5) != schema
        {
            return Err(Status::failed_precondition(
                "another policy package has unfinished onboarding",
            ));
        }
        (
            row.get::<_, Uuid>(0),
            row.get::<_, Vec<u8>>(1),
            row.get::<_, i64>(6),
            store::decode::<Vec<Update>>(row.get(7))?,
        )
    } else {
        let prior = client.query_opt("SELECT desired_hash,catalog_hash,registry_hash,native_revision FROM ofz.platform_policy_installations WHERE completed ORDER BY completed_at_ms DESC LIMIT 1", &[]).await.map_err(sql_error)?;
        if let Some(row) = &prior {
            if installed != row.get::<_, Vec<u8>>(0) {
                return Err(Status::failed_precondition(
                    "installed native schema differs from its policy receipt",
                ));
            }
            if installed == desired_hash
                && row.get::<_, Vec<u8>>(1) == catalog_hash
                && row.get::<_, Vec<u8>>(2) == registry_hash
            {
                return Ok(row.get(3));
            }
        } else {
            let bootstrap = client
                .query_one(
                    "SELECT schema_hash,phase FROM ofz.bootstrap WHERE singleton",
                    &[],
                )
                .await
                .map_err(sql_error)?;
            if bootstrap.get::<_, Option<Vec<u8>>>(0).as_ref() != Some(&installed)
                || bootstrap.get::<_, String>(1) != "active"
            {
                return Err(Status::failed_precondition(
                    "completed bootstrap and its exact native schema are required",
                ));
            }
        }
        let state = store::state(client).await?;
        let operation = Uuid::new_v4();
        let changes = workspace_seed(client, native).await?;
        client.execute("INSERT INTO ofz.platform_policy_installations(operation_id,previous_hash,desired_hash,catalog_hash,registry_hash,expected_version,schema_text,workspace_changes) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", &[&operation,&installed,&desired_hash,&catalog_hash,&registry_hash,&(state.version as i64),&schema,&store::encode(&changes)?]).await.map_err(sql_error)?;
        (operation, installed.clone(), state.version as i64, changes)
    };
    if installed != previous_hash && installed != desired_hash {
        return Err(Status::failed_precondition(
            "native schema changed during policy onboarding",
        ));
    }
    if installed != desired_hash {
        client
            .execute(
                "UPDATE ofz.grants SET revoked=true WHERE resource_kind IN (3,4)",
                &[],
            )
            .await
            .map_err(sql_error)?;
        native.retire_domain_connectors().await?;
        native.write_schema(&schema).await?;
        if native.schema_hash().await? != desired_hash {
            return Err(Status::failed_precondition(
                "installed schema differs from the qualified package digest",
            ));
        }
    }
    let marker = format!("platform-onboarding/{operation}");
    let (applied, mut revision) = native.applied(&marker).await?;
    let state = store::state(client).await?;
    let version = if applied {
        if state.version != expected_version as u64 {
            return Err(Status::failed_precondition(
                "policy command version changed during recovery",
            ));
        }
        expected_version
    } else {
        let version = state.version as i64;
        client.execute("UPDATE ofz.platform_policy_installations SET expected_version=$1 WHERE operation_id=$2 AND NOT completed", &[&version,&operation]).await.map_err(sql_error)?;
        revision = native
            .apply(&marker, state.version, &workspace_changes)
            .await?;
        version
    };
    let tx = client.transaction().await.map_err(sql_error)?;
    for row in tx
        .query(
            "SELECT id,resources,enabled FROM ofz.platform_connections WHERE workspace_id IS NULL",
            &[],
        )
        .await
        .map_err(sql_error)?
    {
        let resources = store::decode::<Vec<crate::proto::PlatformResource>>(row.get(1))?;
        match super::workspaces::resource_workspace_id(&resources)
            .and_then(|id| crate::decision::parse_uuid(&id))
        {
            Ok(workspace) => {
                tx.execute(
                    "UPDATE ofz.platform_connections SET workspace_id=$2 WHERE id=$1",
                    &[&row.get::<_, Uuid>(0), &workspace],
                )
                .await
                .map_err(sql_error)?;
            }
            Err(error) if row.get::<_, bool>(2) => return Err(error),
            Err(_) => {}
        }
    }
    tx.execute("UPDATE ofz.platform_delegations d SET workspace_id=c.workspace_id FROM ofz.platform_connections c WHERE d.connection_id=c.id AND d.workspace_id IS NULL", &[]).await.map_err(sql_error)?;
    tx.batch_execute("LOCK TABLE ofz.platform_executions IN ACCESS EXCLUSIVE MODE")
        .await
        .map_err(sql_error)?;
    for row in tx.query("SELECT e.operation_id,a.receipt FROM ofz.platform_executions e JOIN ofz.audit a ON a.id=e.authorization_receipt_id WHERE e.workspace_id IS NULL", &[]).await.map_err(sql_error)? {
        let receipt = store::decode::<crate::proto::AuditReceipt>(row.get(1))?;
        let mut resources = Vec::new();
        for resource in receipt.platform_resources {
            let (kind, rest) = resource.split_once('/').ok_or_else(|| Status::failed_precondition("historical execution resource is malformed"))?;
            let (id, _) = rest.split_once('#').ok_or_else(|| Status::failed_precondition("historical execution target is malformed"))?;
            resources.push(crate::proto::PlatformResource { kind: kind.into(), id: id.into(), target: String::new() });
        }
        let workspace = crate::decision::parse_uuid(&super::workspaces::resource_workspace_id(&resources)?)?;
        tx.execute("UPDATE ofz.platform_executions SET workspace_id=$2 WHERE operation_id=$1", &[&row.get::<_, Uuid>(0), &workspace]).await.map_err(sql_error)?;
    }
    tx.batch_execute("ALTER TABLE ofz.platform_executions ALTER COLUMN workspace_id SET NOT NULL")
        .await
        .map_err(sql_error)?;

    let context = crate::proto::RequestContext {
        actor: Some(crate::proto::Actor {
            identity: Some(crate::proto::actor::Identity::WorkloadId(format!(
                "postgresql:{owner}"
            ))),
        }),
        trace_id: operation.to_string(),
        contract_version: crate::CONTRACT_VERSION,
        ..Default::default()
    };
    let mut receipt = store::receipt(
        &context,
        &format!("postgresql:{owner}"),
        crate::policy::platform(),
        crate::proto::Action::TargetsManage,
        true,
        &operation.to_string(),
        "reviewed platform policy onboarding",
    );
    receipt.revision = revision.clone();
    receipt.recovery_generation = state.recovery_generation;
    receipt.platform_action = "ofz.policies.onboard".into();
    receipt.platform_request_hash = desired_hash;
    let receipt_id =
        Uuid::parse_str(&receipt.id).map_err(|_| Status::internal("invalid policy receipt"))?;
    let sequence: i64 = tx
        .query_one(
            "INSERT INTO ofz.audit(id,receipt,target_hash) VALUES($1,$2,$3) RETURNING sequence",
            &[
                &receipt_id,
                &store::encode(&receipt)?,
                &Sha256::digest(b"ofz.policies.onboard").to_vec(),
            ],
        )
        .await
        .map_err(sql_error)?
        .get(0);
    tx.execute(
        "INSERT INTO ofz.audit_outbox(audit_sequence) VALUES($1)",
        &[&sequence],
    )
    .await
    .map_err(sql_error)?;
    let changed = tx
        .execute(
            "UPDATE ofz.platform_state SET version=version+1 WHERE singleton AND version=$1",
            &[&version],
        )
        .await
        .map_err(sql_error)?;
    if changed != 1 {
        return Err(Status::aborted("policy version changed"));
    }
    tx.execute("UPDATE ofz.platform_policy_installations SET completed=true,completed_at_ms=ofz.now_ms(),native_revision=$1 WHERE operation_id=$2", &[&revision,&operation]).await.map_err(sql_error)?;
    tx.commit().await.map_err(sql_error)?;
    Ok(revision)
}
