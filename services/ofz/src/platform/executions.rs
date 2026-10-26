use super::authorization;
use crate::{
    decision,
    native::Native,
    proto::{self, actor::Identity},
    registry,
    store::{self, Database, sql_error},
};
use tonic::Status;
use uuid::Uuid;

pub async fn record(
    database: &Database,
    peer: &str,
    request: proto::RecordPlatformExecutionRequest,
) -> Result<proto::RecordPlatformExecutionResponse, Status> {
    if !registry::configured()?.has_role(peer, "relay.executor") {
        return Err(Status::permission_denied("connector executor required"));
    }
    let operation = decision::parse_uuid(&request.operation_id)?;
    let authorization = decision::parse_uuid(&request.authorization_receipt_id)?;
    if request.request_hash.len() != 32
        || !matches!(
            request.outcome.as_str(),
            "started" | "succeeded" | "failed" | "withheld"
        )
        || (request.outcome == "started"
            && (request.upstream_status != 0 || !request.result_hash.is_empty()))
        || (request.outcome == "succeeded" && request.result_hash.len() != 32)
        || (!request.result_hash.is_empty() && request.result_hash.len() != 32)
        || request.upstream_status > 599
    {
        return Err(Status::invalid_argument(
            "invalid platform execution outcome",
        ));
    }
    let mut client = database
        .pool
        .get()
        .await
        .map_err(|_| Status::unavailable("execution audit database unavailable"))?;
    let tx = client.transaction().await.map_err(sql_error)?;
    let row = tx
        .query_opt(
            "SELECT receipt FROM ofz.audit WHERE id=$1 AND created_at_ms>ofz.now_ms()-60000",
            &[&authorization],
        )
        .await
        .map_err(sql_error)?
        .ok_or_else(|| Status::permission_denied("recent execution authorization required"))?;
    let mut receipt: proto::AuditReceipt = store::decode(row.get(0))?;
    let state = store::state(&*tx).await?;
    if !receipt.allowed
        || receipt.workload_id != peer
        || receipt.operation_id != operation.to_string()
        || receipt.platform_request_hash != request.request_hash
        || receipt.platform_action.is_empty()
        || receipt.recovery_generation != state.recovery_generation
    {
        return Err(Status::permission_denied(
            "execution outcome differs from its authorization",
        ));
    }
    let previous=tx.query_opt("SELECT authorization_receipt_id,outcome,upstream_status,result_hash,audit_receipt_id FROM ofz.platform_executions WHERE operation_id=$1 FOR UPDATE", &[&operation]).await.map_err(sql_error)?;
    if let Some(row) = &previous {
        if row.get::<_, Uuid>(0) != authorization || request.outcome == "started" {
            return Err(Status::already_exists("execution ID already used"));
        }
        if row.get::<_, String>(1) == request.outcome
            && row.get::<_, i32>(2) == request.upstream_status as i32
            && row.get::<_, Vec<u8>>(3) == request.result_hash
        {
            return Ok(proto::RecordPlatformExecutionResponse {
                audit_receipt_id: row.get::<_, Uuid>(4).to_string(),
            });
        }
        let withheld_after_success = row.get::<_, String>(1) == "succeeded"
            && request.outcome == "withheld"
            && row.get::<_, i32>(2) == request.upstream_status as i32
            && row.get::<_, Vec<u8>>(3) == request.result_hash;
        if !withheld_after_success && row.get::<_, String>(1) != "started" {
            return Err(Status::already_exists("execution already completed"));
        }
    } else if request.outcome != "started" {
        return Err(Status::failed_precondition(
            "execution has no durable start",
        ));
    }
    receipt.id = Uuid::new_v4().to_string();
    receipt.created_at_unix_ms = state.now_ms;
    receipt.reason = format!(
        "connector execution {} (upstream status {})",
        request.outcome, request.upstream_status
    );
    receipt.platform_action = format!("relay.execution.{}", request.outcome);
    receipt.allowed = request.outcome == "started" || request.outcome == "succeeded";
    let target = serde_json::to_string(&(&request.authorization_receipt_id, &request.result_hash))
        .map_err(|_| Status::internal("encode execution audit target"))?;
    store::record_audit(&*tx, &receipt, &target).await?;
    let statement = if request.outcome == "started" {
        "INSERT INTO ofz.platform_executions(operation_id,authorization_receipt_id,outcome,upstream_status,result_hash,audit_receipt_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(operation_id) DO NOTHING"
    } else {
        "UPDATE ofz.platform_executions SET outcome=$3,upstream_status=$4,result_hash=$5,audit_receipt_id=$6 WHERE operation_id=$1 AND authorization_receipt_id=$2"
    };
    let changed = tx
        .execute(
            statement,
            &[
                &operation,
                &authorization,
                &request.outcome,
                &(request.upstream_status as i32),
                &request.result_hash,
                &decision::parse_uuid(&receipt.id)?,
            ],
        )
        .await
        .map_err(sql_error)?;
    if changed != 1 {
        return Err(Status::already_exists("execution ID already used"));
    }
    tx.commit().await.map_err(sql_error)?;
    Ok(proto::RecordPlatformExecutionResponse {
        audit_receipt_id: receipt.id,
    })
}

#[derive(PartialEq, Eq)]
enum Owner {
    Human(String),
    Workload(String),
}

async fn owner(
    connection: &tokio_postgres::Client,
    receipt: &proto::AuditReceipt,
) -> Result<Owner, Status> {
    match receipt
        .actor
        .as_ref()
        .and_then(|actor| actor.identity.as_ref())
    {
        Some(Identity::HumanId(id)) => Ok(Owner::Human(id.clone())),
        Some(Identity::WorkloadId(id)) => Ok(Owner::Workload(id.clone())),
        Some(Identity::AgentId(id)) => {
            let row = connection
                .query_opt(
                    "SELECT issuer_id FROM ofz.platform_delegations WHERE id=$1 AND agent_id=$2 AND client_service=$3",
                    &[&decision::parse_uuid(&receipt.grant_id)?, &decision::parse_uuid(id)?, &receipt.platform_client],
                )
                .await
                .map_err(sql_error)?
                .ok_or_else(|| Status::not_found("execution unavailable"))?;
            Ok(Owner::Human(row.get(0)))
        }
        _ => Err(Status::not_found("execution unavailable")),
    }
}

pub async fn get(
    database: &Database,
    native: &Native,
    peer: &str,
    request: proto::GetPlatformExecutionRequest,
) -> Result<proto::GetPlatformExecutionResponse, Status> {
    if !registry::configured()?.has_role(peer, "relay.executor") {
        return Err(Status::permission_denied("connector executor required"));
    }
    let mut authorization = request
        .authorization
        .ok_or_else(|| Status::invalid_argument("execution lookup authorization required"))?;
    if request.execution_request_hash.len() != 32
        || authorization.request_hash == request.execution_request_hash
        || !authorization.audit_receipt_id.is_empty()
    {
        return Err(Status::invalid_argument(
            "fresh execution lookup authorization required",
        ));
    }
    let decision = authorization::check(database, native, peer, authorization.clone()).await?;
    if !decision.allowed {
        return Err(Status::permission_denied("execution lookup denied"));
    }
    authorization.audit_receipt_id = decision.audit_receipt_id.clone();
    let execution = {
        let connection = database
            .pool
            .get()
            .await
            .map_err(|_| Status::unavailable("execution database unavailable"))?;
        let current = connection
            .query_one(
                "SELECT receipt FROM ofz.audit WHERE id=$1",
                &[&decision::parse_uuid(&decision.audit_receipt_id)?],
            )
            .await
            .map_err(sql_error)?;
        let current: proto::AuditReceipt = store::decode(current.get(0))?;
        let row = connection.query_opt(
            "SELECT e.authorization_receipt_id,e.outcome,e.upstream_status,e.result_hash,e.audit_receipt_id,a.receipt,o.created_at_ms FROM ofz.platform_executions e JOIN ofz.audit a ON a.id=e.authorization_receipt_id JOIN ofz.audit o ON o.id=e.audit_receipt_id WHERE e.operation_id=$1",
            &[&decision::parse_uuid(&authorization.operation_id)?],
        ).await.map_err(sql_error)?.ok_or_else(|| Status::not_found("execution unavailable"))?;
        let original: proto::AuditReceipt = store::decode(row.get(5))?;
        if !original.allowed
            || original.workload_id != peer
            || original.operation_id != authorization.operation_id
            || original.platform_client != current.platform_client
            || original.platform_action != current.platform_action
            || original.platform_resources != current.platform_resources
            || original.platform_request_hash != request.execution_request_hash
            || owner(&connection, &original).await? != owner(&connection, &current).await?
        {
            return Err(Status::not_found("execution unavailable"));
        }
        proto::PlatformExecution {
            operation_id: authorization.operation_id.clone(),
            outcome: row.get(1),
            authorization_receipt_id: row.get::<_, Uuid>(0).to_string(),
            execution_receipt_id: row.get::<_, Uuid>(4).to_string(),
            upstream_status: row.get::<_, i32>(2) as u32,
            result_hash: row.get(3),
            request_hash: original.platform_request_hash,
            updated_at_unix_ms: row.get::<_, i64>(6) as u64,
        }
    };
    let decision = authorization::check(database, native, peer, authorization).await?;
    if !decision.allowed {
        return Err(Status::permission_denied(
            "execution lookup authority changed",
        ));
    }
    Ok(proto::GetPlatformExecutionResponse {
        execution: Some(execution),
        decision: Some(decision),
    })
}
