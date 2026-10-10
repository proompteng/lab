use std::sync::Arc;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tonic::{Request, Response, Status};

use crate::{
    commands, decision,
    native::Native,
    policy,
    proto::{self, Action, authorization_service_server::AuthorizationService},
    sessions::{self, Issuer},
    store::{self, Database, sql_error},
    transport,
};

#[derive(Clone)]
pub struct Service {
    database: Database,
    native: Native,
    issuer: Issuer,
    capacity: Arc<Semaphore>,
    #[cfg(test)]
    read_barrier: Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>,
}

impl Service {
    pub fn new(database: Database, native: Native, issuer: Issuer) -> Self {
        Self {
            database,
            native,
            issuer,
            capacity: Arc::new(Semaphore::new(128)),
            #[cfg(test)]
            read_barrier: None,
        }
    }
    #[cfg(test)]
    pub(crate) fn with_read_barrier(
        mut self,
        entered: Arc<tokio::sync::Notify>,
        resume: Arc<tokio::sync::Notify>,
    ) -> Self {
        self.read_barrier = Some((entered, resume));
        self
    }
    fn acquire(&self) -> Result<OwnedSemaphorePermit, Status> {
        self.capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| Status::resource_exhausted("authorization API overloaded"))
    }

    async fn require_access(
        &self,
        peer: &str,
        context: proto::RequestContext,
        action: Action,
        resource: proto::Resource,
    ) -> Result<proto::CheckResponse, Status> {
        let result = decision::check(
            &self.database,
            &self.native,
            peer,
            proto::CheckRequest {
                context: Some(context),
                action: action as i32,
                resource: Some(resource),
                ..Default::default()
            },
        )
        .await?;
        if !result.allowed {
            let mut error = Status::permission_denied("access denied");
            error.metadata_mut().insert(
                "x-ofz-audit-receipt",
                result
                    .audit_receipt_id
                    .parse()
                    .map_err(|_| Status::internal("invalid audit ID"))?,
            );
            return Err(error);
        }
        #[cfg(test)]
        if let Some((entered, resume)) = &self.read_barrier {
            entered.notify_one();
            resume.notified().await;
        }
        Ok(result)
    }

    async fn finish_read(
        &self,
        decision: &proto::CheckResponse,
        version: u64,
    ) -> Result<(), Status> {
        let state = self.database.state().await?;
        if state.version != version {
            return Err(Status::aborted("policy changed while reading"));
        }
        if state.now_ms >= decision.valid_until_unix_ms
            || state.recovery_generation != decision.recovery_generation
            || state.fenced
        {
            return Err(Status::deadline_exceeded("authorization decision expired"));
        }
        if !state.archive_healthy {
            return Err(Status::unavailable("protected access fenced"));
        }
        Ok(())
    }
}

fn context<T>(value: Option<T>) -> Result<T, Status> {
    value.ok_or_else(|| Status::unauthenticated("context required"))
}

#[tonic::async_trait]
impl AuthorizationService for Service {
    async fn check(
        &self,
        request: Request<proto::CheckRequest>,
    ) -> Result<Response<proto::CheckResponse>, Status> {
        let _capacity = self.acquire()?;
        let peer = transport::peer(&request)?;
        decision::check(&self.database, &self.native, &peer, request.into_inner())
            .await
            .map(Response::new)
    }
    async fn execute_command(
        &self,
        request: Request<proto::ExecuteCommandRequest>,
    ) -> Result<Response<proto::ExecuteCommandResponse>, Status> {
        let _capacity = self.acquire()?;
        let peer = transport::peer(&request)?;
        let receipt =
            commands::execute(&self.database, &self.native, &peer, request.into_inner()).await?;
        Ok(Response::new(proto::ExecuteCommandResponse {
            receipt: Some(receipt),
        }))
    }
    async fn get_command(
        &self,
        request: Request<proto::GetCommandRequest>,
    ) -> Result<Response<proto::GetCommandResponse>, Status> {
        let _capacity = self.acquire()?;
        let peer = transport::peer(&request)?;
        let receipt =
            commands::get(&self.database, &self.native, &peer, request.into_inner()).await?;
        Ok(Response::new(proto::GetCommandResponse {
            receipt: Some(receipt),
        }))
    }
    async fn establish_session(
        &self,
        request: Request<proto::EstablishSessionRequest>,
    ) -> Result<Response<proto::EstablishSessionResponse>, Status> {
        let _capacity = self.acquire()?;
        let peer = transport::peer(&request)?;
        let session = sessions::establish(
            &self.database,
            &self.native,
            &self.issuer,
            &peer,
            request.into_inner(),
        )
        .await?;
        Ok(Response::new(proto::EstablishSessionResponse {
            session: Some(session),
        }))
    }
    async fn inspect_session(
        &self,
        request: Request<proto::InspectSessionRequest>,
    ) -> Result<Response<proto::InspectSessionResponse>, Status> {
        let _capacity = self.acquire()?;
        let peer = transport::peer(&request)?;
        let session =
            sessions::inspect(&self.database, &self.native, &peer, request.into_inner()).await?;
        Ok(Response::new(proto::InspectSessionResponse {
            session: Some(session),
        }))
    }
    async fn revoke_session(
        &self,
        request: Request<proto::RevokeSessionRequest>,
    ) -> Result<Response<proto::RevokeSessionResponse>, Status> {
        let _capacity = self.acquire()?;
        let peer = transport::peer(&request)?;
        let receipt =
            sessions::revoke(&self.database, &self.native, &peer, request.into_inner()).await?;
        Ok(Response::new(proto::RevokeSessionResponse {
            receipt: Some(receipt),
        }))
    }
    async fn get_policy_state(
        &self,
        request: Request<proto::GetPolicyStateRequest>,
    ) -> Result<Response<proto::GetPolicyStateResponse>, Status> {
        let _capacity = self.acquire()?;
        let peer = transport::peer(&request)?;
        decision::workload(&self.native, &peer, Action::PolicyCheck).await?;
        let state = self.database.state().await?;
        Ok(Response::new(proto::GetPolicyStateResponse {
            version: state.version,
            recovery_generation: state.recovery_generation,
            fenced: state.fenced,
        }))
    }
    async fn list_access(
        &self,
        request: Request<proto::ListAccessRequest>,
    ) -> Result<Response<proto::ListAccessResponse>, Status> {
        let _capacity = self.acquire()?;
        let peer = transport::peer(&request)?;
        if peer != policy::BFF_ID {
            return Err(Status::permission_denied(
                "human policy reads require the BFF",
            ));
        }
        let request = request.into_inner();
        let context = context(request.context)?;
        let resource = request
            .resource
            .ok_or_else(|| Status::invalid_argument("resource required"))?;
        let action = match proto::ResourceKind::try_from(resource.kind) {
            Ok(proto::ResourceKind::Platform) => Action::PolicyRead,
            Ok(proto::ResourceKind::Workspace) => Action::WorkspacePolicyRead,
            _ => return Err(Status::invalid_argument("unsupported access roster")),
        };
        let state = self.database.state().await?;
        let decision = self
            .require_access(&peer, context, action, resource.clone())
            .await?;
        let cursor = if request.cursor.is_empty() {
            String::new()
        } else {
            request.cursor
        };
        if cursor.len() > 256 || request.limit > 200 {
            return Err(Status::invalid_argument("invalid roster page"));
        }
        let limit = i64::from(if request.limit == 0 {
            100
        } else {
            request.limit
        });
        let client = self
            .database
            .pool
            .get()
            .await
            .map_err(|_| Status::unavailable("control database pool unavailable"))?;
        let rows = if action == Action::PolicyRead {
            client
                .query(PLATFORM_ROSTER, &[&cursor, &(limit + 1)])
                .await
                .map_err(sql_error)?
        } else {
            let uid = decision::parse_uuid(&resource.id)?;
            client
                .query(WORKSPACE_ROSTER, &[&uid, &cursor, &(limit + 1)])
                .await
                .map_err(sql_error)?
        };
        let next = if rows.len() > limit as usize {
            rows[limit as usize - 1].get(5)
        } else {
            String::new()
        };
        let entries: Vec<proto::AccessEntry> = rows
            .into_iter()
            .take(limit as usize)
            .map(|row| {
                Ok(proto::AccessEntry {
                    subject_id: row.get(0),
                    role: row.get(1),
                    grant_id: row.get(2),
                    actions: row.get(3),
                    expires_at_unix_ms: row.get::<_, i64>(4) as u64,
                    github_id: row.get(6),
                    scope: row
                        .get::<_, Option<serde_json::Value>>(7)
                        .map(store::decode)
                        .transpose()?,
                    resource: row
                        .get::<_, Option<serde_json::Value>>(8)
                        .map(store::decode)
                        .transpose()?,
                })
            })
            .collect::<Result<_, Status>>()?;
        let subjects: Vec<String> = entries
            .iter()
            .filter(|entry| action == Action::PolicyRead || entry.role == "owner")
            .map(|entry| entry.subject_id.clone())
            .collect();
        let quotas = client.query("SELECT h.id,coalesce(q.total_workspaces,2),coalesce(q.active_workspaces,1),coalesce(q.retained_bytes,68719476736),coalesce(u.used_workspaces,0),coalesce(u.used_active,0),coalesce(u.used_bytes,0) FROM ofz.humans h LEFT JOIN ofz.quotas q ON q.human_id=h.id LEFT JOIN ofz.quota_usage u ON u.owner_id=h.id WHERE h.id=ANY($1) ORDER BY h.id", &[&subjects]).await.map_err(sql_error)?.into_iter().map(|row| proto::QuotaRecord {
            human_id:row.get(0),total_workspaces:row.get::<_,i32>(1) as u32,active_workspaces:row.get::<_,i32>(2) as u32,
            retained_bytes:row.get::<_,i64>(3) as u64,used_workspaces:row.get::<_,i64>(4) as u32,
            used_active:row.get::<_,i64>(5) as u32,used_bytes:row.get::<_,i64>(6) as u64,
        }).collect();
        let workspace_state = if action == Action::WorkspacePolicyRead {
            client
                .query_one(
                    "SELECT state FROM ofz.workspaces WHERE uid=$1",
                    &[&decision::parse_uuid(&resource.id)?],
                )
                .await
                .map_err(sql_error)?
                .get(0)
        } else {
            String::new()
        };
        drop(client);
        self.finish_read(&decision, state.version).await?;
        Ok(Response::new(proto::ListAccessResponse {
            entries,
            cursor: next,
            version: state.version,
            quotas,
            workspace_state,
        }))
    }
    async fn read_audit(
        &self,
        request: Request<proto::ReadAuditRequest>,
    ) -> Result<Response<proto::ReadAuditResponse>, Status> {
        let _capacity = self.acquire()?;
        let peer = transport::peer(&request)?;
        if peer != policy::BFF_ID {
            return Err(Status::permission_denied(
                "human audit reads require the BFF",
            ));
        }
        let request = request.into_inner();
        let context = context(request.context)?;
        let state = self.database.state().await?;
        let decision = self
            .require_access(&peer, context, Action::AuditRead, policy::platform())
            .await?;
        let cursor: i64 = if request.cursor.is_empty() {
            0
        } else {
            request
                .cursor
                .parse()
                .map_err(|_| Status::invalid_argument("invalid audit cursor"))?
        };
        if cursor < 0 || request.limit > 200 {
            return Err(Status::invalid_argument("invalid audit page"));
        }
        let limit = i64::from(if request.limit == 0 {
            100
        } else {
            request.limit
        });
        let client = self
            .database
            .pool
            .get()
            .await
            .map_err(|_| Status::unavailable("control database pool unavailable"))?;
        let rows = client.query("SELECT sequence,created_at_ms,receipt FROM ofz.audit WHERE sequence>$1 ORDER BY sequence LIMIT $2", &[&cursor,&(limit+1)]).await.map_err(sql_error)?;
        let next = if rows.len() > limit as usize {
            rows[limit as usize - 1].get::<_, i64>(0).to_string()
        } else {
            String::new()
        };
        let mut receipts = Vec::new();
        for row in rows.into_iter().take(limit as usize) {
            let mut receipt: proto::AuditReceipt = store::decode(row.get(2))?;
            receipt.sequence = row.get::<_, i64>(0) as u64;
            receipt.created_at_unix_ms = row.get::<_, i64>(1) as u64;
            receipts.push(receipt);
        }
        drop(client);
        self.finish_read(&decision, state.version).await?;
        Ok(Response::new(proto::ReadAuditResponse {
            receipts,
            cursor: next,
        }))
    }
}

const PLATFORM_ROSTER: &str = r#"
SELECT m.human_id AS subject_id,
       CASE m.role WHEN 1 THEN 'member' WHEN 2 THEN 'administrator' WHEN 3 THEN 'auditor' ELSE 'operator' END AS role,
       '' AS grant_id,ARRAY[]::integer[] AS actions,0::bigint AS expires_at_ms,
       m.human_id||'/'||m.role AS cursor,h.github_id,NULL::jsonb,NULL::jsonb
FROM ofz.memberships m JOIN ofz.humans h ON h.id=m.human_id
WHERE m.human_id||'/'||m.role>$1 ORDER BY cursor LIMIT $2
"#;

const WORKSPACE_ROSTER: &str = r#"
SELECT subject_id,role,grant_id,actions,expires_at_ms,cursor,github_id,scope,resource
FROM (
    SELECT w.owner_id AS subject_id,'owner' AS role,'' AS grant_id,
           ARRAY[]::integer[] AS actions,0::bigint AS expires_at_ms,'human/'||w.owner_id AS cursor,
           h.github_id,NULL::jsonb AS scope,NULL::jsonb AS resource
    FROM ofz.workspaces w JOIN ofz.humans h ON h.id=w.owner_id WHERE w.uid=$1
    UNION ALL
    SELECT c.human_id,CASE c.role WHEN 2 THEN 'developer' ELSE 'viewer' END,'',ARRAY[]::integer[],0,
           'human/'||c.human_id,h.github_id,NULL::jsonb,NULL::jsonb
    FROM ofz.collaborators c JOIN ofz.humans h ON h.id=c.human_id WHERE c.workspace_uid=$1
    UNION ALL
    SELECT agent_id::text,'diagnostic',id::text,actions,expires_at_ms,'grant/'||id::text,'',scope,
           jsonb_build_object('kind',resource_kind,'id',resource_id)
    FROM ofz.grants WHERE workspace_uid=$1 AND NOT revoked AND expires_at_ms>ofz.now_ms()
    UNION ALL
    SELECT e.human_id,'emergency','',ARRAY[]::integer[],e.expires_at_ms,'emergency/'||e.human_id,
           h.github_id,NULL::jsonb,NULL::jsonb
    FROM ofz.emergency_access e JOIN ofz.humans h ON h.id=e.human_id
    WHERE e.workspace_uid=$1 AND e.expires_at_ms>ofz.now_ms()
      AND EXISTS (SELECT 1 FROM ofz.memberships m WHERE m.human_id=e.human_id AND m.role=1)
) roster WHERE cursor>$2 ORDER BY cursor LIMIT $3
"#;
