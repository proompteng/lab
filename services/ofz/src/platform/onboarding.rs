use sha2::{Digest, Sha256};
use tonic::Status;
use uuid::Uuid;

use super::catalog;
use crate::{
    native::Native,
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

pub async fn verify(database: &Database) -> Result<(), Status> {
    let client = database
        .pool
        .get()
        .await
        .map_err(|_| Status::unavailable("platform database pool unavailable"))?;
    let row = client.query_opt("SELECT catalog_hash,registry_hash,desired_hash FROM ofz.platform_policy_installations WHERE completed AND NOT EXISTS(SELECT 1 FROM ofz.platform_policy_installations WHERE NOT completed) AND NOT EXISTS(SELECT 1 FROM ofz.platform_commands WHERE NOT completed) ORDER BY completed_at_ms DESC LIMIT 1", &[])
        .await.map_err(sql_error)?.ok_or_else(|| Status::failed_precondition("platform policies are not onboarded"))?;
    if row.get::<_, Vec<u8>>(0) != catalog::configured()?.checksum()?
        || row.get::<_, Vec<u8>>(1) != registry_hash()?
        || row.get::<_, Vec<u8>>(2) != expected_schema_hash()?
    {
        return Err(Status::failed_precondition(
            "platform policy package mismatch",
        ));
    }
    Ok(())
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
    let pending = client.query_opt("SELECT operation_id,previous_hash,desired_hash,catalog_hash,registry_hash,schema_text,expected_version FROM ofz.platform_policy_installations WHERE NOT completed", &[]).await.map_err(sql_error)?;
    let (operation, previous_hash, expected_version) = if let Some(row) = pending {
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
        client.execute("INSERT INTO ofz.platform_policy_installations(operation_id,previous_hash,desired_hash,catalog_hash,registry_hash,expected_version,schema_text) VALUES($1,$2,$3,$4,$5,$6,$7)", &[&operation,&installed,&desired_hash,&catalog_hash,&registry_hash,&(state.version as i64),&schema]).await.map_err(sql_error)?;
        (operation, installed.clone(), state.version as i64)
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
        revision = native.apply(&marker, state.version, &[]).await?;
        version
    };
    let tx = client.transaction().await.map_err(sql_error)?;
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
