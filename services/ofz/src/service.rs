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
}

impl Service {
    pub fn new(database: Database, native: Native, issuer: Issuer) -> Self {
        Self {
            database,
            native,
            issuer,
            capacity: Arc::new(Semaphore::new(128)),
        }
    }
    fn acquire(&self) -> Result<OwnedSemaphorePermit, Status> {
        self.capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| Status::resource_exhausted("authorization API overloaded"))
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
        decision::workload(&self.native, &peer, Action::PolicyCheck).await?;
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
        let (allowed, _, _, state) = decision::evaluate(
            &self.database,
            &self.native,
            &peer,
            decision::Evaluation {
                context: &context,
                action,
                resource: &resource,
                target: "",
            },
            false,
        )
        .await?;
        if !allowed {
            return Err(Status::permission_denied("access denied"));
        }
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
            client.query("SELECT human_id AS subject_id,role::text AS role,'' AS grant_id,ARRAY[]::integer[] AS actions,0::bigint AS expires_at_ms,human_id||'/'||role AS cursor FROM ofz.memberships WHERE human_id||'/'||role>$1 ORDER BY cursor LIMIT $2", &[&cursor,&(limit+1)]).await.map_err(sql_error)?
        } else {
            let uid = decision::parse_uuid(&resource.id)?;
            client.query("SELECT subject_id,role,grant_id,actions,expires_at_ms,cursor FROM (SELECT owner_id AS subject_id,'owner' AS role,'' AS grant_id,ARRAY[]::integer[] AS actions,0::bigint AS expires_at_ms,'human/'||owner_id AS cursor FROM ofz.workspaces WHERE uid=$1 UNION ALL SELECT human_id, CASE role WHEN 2 THEN 'developer' ELSE 'viewer' END,'',ARRAY[]::integer[],0,'human/'||human_id FROM ofz.collaborators WHERE workspace_uid=$1 UNION ALL SELECT agent_id::text,'diagnostic',id::text,actions,expires_at_ms,'grant/'||id::text FROM ofz.grants WHERE workspace_uid=$1 AND NOT revoked AND expires_at_ms>ofz.now_ms()) roster WHERE cursor>$2 ORDER BY cursor LIMIT $3", &[&uid,&cursor,&(limit+1)]).await.map_err(sql_error)?
        };
        let next = if rows.len() > limit as usize {
            rows[limit as usize - 1].get(5)
        } else {
            String::new()
        };
        let entries = rows
            .into_iter()
            .take(limit as usize)
            .map(|row| proto::AccessEntry {
                subject_id: row.get(0),
                role: row.get(1),
                grant_id: row.get(2),
                actions: row.get(3),
                expires_at_unix_ms: row.get::<_, i64>(4) as u64,
            })
            .collect();
        drop(client);
        self.database
            .audit(
                &store::receipt(
                    &context,
                    &peer,
                    resource,
                    action,
                    true,
                    "",
                    "access roster read",
                ),
                "",
            )
            .await?;
        Ok(Response::new(proto::ListAccessResponse {
            entries,
            cursor: next,
            version: state.version,
        }))
    }
    async fn read_audit(
        &self,
        request: Request<proto::ReadAuditRequest>,
    ) -> Result<Response<proto::ReadAuditResponse>, Status> {
        let _capacity = self.acquire()?;
        let peer = transport::peer(&request)?;
        decision::workload(&self.native, &peer, Action::PolicyCheck).await?;
        let request = request.into_inner();
        let context = context(request.context)?;
        let (allowed, _, _, _) = decision::evaluate(
            &self.database,
            &self.native,
            &peer,
            decision::Evaluation {
                context: &context,
                action: Action::AuditRead,
                resource: &policy::platform(),
                target: "",
            },
            false,
        )
        .await?;
        if !allowed {
            return Err(Status::permission_denied("access denied"));
        }
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
        self.database
            .audit(
                &store::receipt(
                    &context,
                    &peer,
                    policy::platform(),
                    Action::AuditRead,
                    true,
                    "",
                    "audit read",
                ),
                "",
            )
            .await?;
        Ok(Response::new(proto::ReadAuditResponse {
            receipts,
            cursor: next,
        }))
    }
}
