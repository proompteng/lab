use super::{
    authorization, catalog, connections, executions,
    mutations::{self, Command},
    onboarding, workspaces,
};
use crate::{
    native::Native,
    proto::{self, platform_authorization_service_server::PlatformAuthorizationService},
    registry,
    sessions::{self, Issuer},
    store::Database,
    transport,
};
use std::sync::Arc;
use tokio::sync::Semaphore;
use tonic::{Request, Response, Status};

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
}
#[tonic::async_trait]
impl PlatformAuthorizationService for Service {
    async fn list_platform_workspaces(
        &self,
        request: Request<proto::ListPlatformWorkspacesRequest>,
    ) -> Result<Response<proto::ListPlatformWorkspacesResponse>, Status> {
        let _capacity = self
            .capacity
            .try_acquire()
            .map_err(|_| Status::resource_exhausted("platform administration is busy"))?;
        let peer = transport::peer(&request)?;
        workspaces::list(&self.database, &self.native, &peer, request.into_inner())
            .await
            .map(Response::new)
    }
    async fn get_platform_workspace(
        &self,
        request: Request<proto::GetPlatformWorkspaceRequest>,
    ) -> Result<Response<proto::GetPlatformWorkspaceResponse>, Status> {
        let _capacity = self
            .capacity
            .try_acquire()
            .map_err(|_| Status::resource_exhausted("platform administration is busy"))?;
        let peer = transport::peer(&request)?;
        workspaces::get(&self.database, &self.native, &peer, request.into_inner())
            .await
            .map(Response::new)
    }
    async fn read_workspace_activity(
        &self,
        request: Request<proto::ReadWorkspaceActivityRequest>,
    ) -> Result<Response<proto::ReadWorkspaceActivityResponse>, Status> {
        let _capacity = self
            .capacity
            .try_acquire()
            .map_err(|_| Status::resource_exhausted("platform administration is busy"))?;
        let peer = transport::peer(&request)?;
        workspaces::activity(&self.database, &self.native, &peer, request.into_inner())
            .await
            .map(Response::new)
    }
    async fn begin_sign_in(
        &self,
        request: Request<proto::BeginSignInRequest>,
    ) -> Result<Response<proto::BeginSignInResponse>, Status> {
        let _capacity = self
            .capacity
            .try_acquire()
            .map_err(|_| Status::resource_exhausted("platform policy service is busy"))?;
        let peer = transport::peer(&request)?;
        sessions::begin_sign_in(&self.database, &peer, request.into_inner()).await?;
        Ok(Response::new(proto::BeginSignInResponse {}))
    }
    async fn consume_sign_in(
        &self,
        request: Request<proto::ConsumeSignInRequest>,
    ) -> Result<Response<proto::ConsumeSignInResponse>, Status> {
        let _capacity = self
            .capacity
            .try_acquire()
            .map_err(|_| Status::resource_exhausted("platform policy service is busy"))?;
        let peer = transport::peer(&request)?;
        Ok(Response::new(
            sessions::consume_sign_in(&self.database, &peer, request.into_inner()).await?,
        ))
    }
    async fn establish_session(
        &self,
        request: Request<proto::EstablishSessionRequest>,
    ) -> Result<Response<proto::EstablishSessionResponse>, Status> {
        let _capacity = self
            .capacity
            .try_acquire()
            .map_err(|_| Status::resource_exhausted("platform policy service is busy"))?;
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
        let _capacity = self
            .capacity
            .try_acquire()
            .map_err(|_| Status::resource_exhausted("platform policy service is busy"))?;
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
        let _capacity = self
            .capacity
            .try_acquire()
            .map_err(|_| Status::resource_exhausted("platform policy service is busy"))?;
        let peer = transport::peer(&request)?;
        let receipt = sessions::revoke(&self.database, &peer, request.into_inner()).await?;
        Ok(Response::new(proto::RevokeSessionResponse {
            receipt: Some(receipt),
        }))
    }
    async fn get_platform_configuration(
        &self,
        request: Request<proto::GetPlatformConfigurationRequest>,
    ) -> Result<Response<proto::GetPlatformConfigurationResponse>, Status> {
        let peer = transport::peer(&request)?;
        let _permit = self
            .capacity
            .try_acquire()
            .map_err(|_| Status::resource_exhausted("platform policy service is busy"))?;
        if registry::configured()?.service(&peer).is_none() {
            return Err(Status::permission_denied("registered service required"));
        }
        onboarding::verify_configuration(&self.database).await?;
        Ok(Response::new(proto::GetPlatformConfigurationResponse {
            policy_version: self.database.state().await?.version,
            relay_clients: registry::configured()?
                .services
                .iter()
                .filter(|s| s.roles.iter().any(|r| r == "relay.client"))
                .map(|s| proto::RegisteredRelayClient {
                    id: s.id.clone(),
                    identities: s.identities.clone(),
                    display_name: s.name().into(),
                })
                .collect(),
            policy_catalog_json: serde_json::to_string(catalog::configured()?)
                .map_err(|_| Status::internal("encode policy catalog"))?,
        }))
    }
    async fn read_policy_relationships(
        &self,
        request: Request<proto::ReadPolicyRelationshipsRequest>,
    ) -> Result<Response<proto::ReadPolicyRelationshipsResponse>, Status> {
        let peer = transport::peer(&request)?;
        let _permit = self
            .capacity
            .try_acquire()
            .map_err(|_| Status::resource_exhausted("platform policy service is busy"))?;
        let input = request.into_inner();
        let session = input
            .administrator
            .as_ref()
            .ok_or_else(|| Status::unauthenticated("human session required"))?;
        let registration = registry::configured()?
            .service(&peer)
            .ok_or_else(|| Status::permission_denied("registered service required"))?;
        if !registration
            .roles
            .iter()
            .any(|role| role == "platform.administration")
            || !registration.allows_origin(&session.origin)
        {
            return Err(Status::permission_denied(
                "service cannot read policy relationships",
            ));
        }
        let operation = uuid::Uuid::new_v4().to_string();
        let (context, state, _) =
            authorization::human_context(&self.database, session, &operation, false).await?;
        onboarding::verify(&self.database).await?;
        let (allowed, revision) = self
            .native
            .check(&[crate::native::Check::new(
                "platform_workspace",
                &input.workspace_id,
                "manage",
                "human",
                &session.human_id,
            )])
            .await?;
        if !allowed {
            let mut denied = crate::store::receipt(
                &context,
                &peer,
                crate::policy::platform(),
                proto::Action::PolicyRead,
                false,
                &operation,
                "resource permissions require a workspace administrator",
            );
            denied.recovery_generation = state.recovery_generation;
            denied.platform_action = "ofz.relationships.read".into();
            denied.platform_workspace_id = input.workspace_id.clone();
            denied.revision = revision;
            self.database
                .audit(&denied, "ofz.relationships.read")
                .await?;
            return Err(Status::permission_denied(
                "workspace administrator required",
            ));
        }
        let resource = input
            .resource
            .as_ref()
            .ok_or_else(|| Status::invalid_argument("resource required"))?;
        if resource.id.is_empty()
            || resource.id.len() > 256
            || !resource.target.is_empty()
            || !resource
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"/_|-=+".contains(&b))
        {
            return Err(Status::invalid_argument("invalid policy resource"));
        }
        let definition = catalog::configured()?.resource(&resource.kind)?;
        workspaces::resource_scope(&input.workspace_id, resource)?;
        if input.subject_kind == "workspace" && input.subject_id != input.workspace_id {
            return Err(Status::permission_denied(
                "workspace grant cannot reference another workspace",
            ));
        }
        let (subject_kind, subject) = workspaces::subject(&input.subject_kind, &input.subject_id)?;
        let relations = self
            .native
            .policy_relations(
                &definition.native_type,
                &resource.id,
                subject_kind,
                &subject,
            )
            .await?;
        if relations.iter().any(|name| {
            !definition.relations.iter().any(|relation| {
                relation.name == *name && relation.subjects.contains(&input.subject_kind)
            })
        }) {
            return Err(Status::failed_precondition(
                "relationship is not in the onboarded policy",
            ));
        }
        let mut receipt = crate::store::receipt(
            &context,
            &peer,
            crate::policy::platform(),
            proto::Action::PolicyRead,
            true,
            &operation,
            "read resource permissions",
        );
        receipt.recovery_generation = state.recovery_generation;
        receipt.revision = revision;
        receipt.platform_action = "ofz.relationships.read".into();
        receipt.platform_workspace_id = input.workspace_id.clone();
        receipt.platform_resources = vec![format!("{}/{}", resource.kind, resource.id)];
        self.database
            .audit(&receipt, "ofz.relationships.read")
            .await?;
        let (_, current, _) = authorization::human_context(
            &self.database,
            session,
            &uuid::Uuid::new_v4().to_string(),
            false,
        )
        .await?;
        if current.version != state.version
            || current.recovery_generation != state.recovery_generation
            || !self
                .native
                .check(&[crate::native::Check::new(
                    "platform_workspace",
                    &input.workspace_id,
                    "manage",
                    "human",
                    &session.human_id,
                )])
                .await?
                .0
        {
            return Err(Status::aborted("platform policy changed during read"));
        }
        Ok(Response::new(proto::ReadPolicyRelationshipsResponse {
            policy_version: state.version,
            relations,
        }))
    }
    async fn check_platform_access(
        &self,
        request: Request<proto::CheckPlatformAccessRequest>,
    ) -> Result<Response<proto::CheckPlatformAccessResponse>, Status> {
        let peer = transport::peer(&request)?;
        let _permit = self
            .capacity
            .try_acquire()
            .map_err(|_| Status::resource_exhausted("platform authorization is busy"))?;
        Ok(Response::new(proto::CheckPlatformAccessResponse {
            decision: Some(
                authorization::check(&self.database, &self.native, &peer, request.into_inner())
                    .await?,
            ),
        }))
    }
    async fn list_platform_connections(
        &self,
        request: Request<proto::ListPlatformConnectionsRequest>,
    ) -> Result<Response<proto::ListPlatformConnectionsResponse>, Status> {
        let peer = transport::peer(&request)?;
        let _permit = self
            .capacity
            .try_acquire()
            .map_err(|_| Status::resource_exhausted("platform connection service is busy"))?;
        connections::list(&self.database, &self.native, &peer, request.into_inner())
            .await
            .map(Response::new)
    }
    async fn put_platform_connection(
        &self,
        request: Request<proto::PutPlatformConnectionRequest>,
    ) -> Result<Response<proto::PutPlatformConnectionResponse>, Status> {
        let peer = transport::peer(&request)?;
        let _permit = self
            .capacity
            .try_acquire()
            .map_err(|_| Status::resource_exhausted("platform connection service is busy"))?;
        let input = request.into_inner();
        let connection_id = input.connection_id.clone();
        let version = input
            .expected_version
            .checked_add(1)
            .ok_or_else(|| Status::invalid_argument("connection version overflow"))?;
        let outcome = mutations::execute(
            &self.database,
            &self.native,
            &peer,
            Command::PutConnection(input),
        )
        .await?;
        Ok(Response::new(proto::PutPlatformConnectionResponse {
            connection_id,
            version,
            credential_generation: outcome.version,
            decision: Some(outcome.decision),
        }))
    }
    async fn revoke_platform_connection(
        &self,
        request: Request<proto::RevokePlatformConnectionRequest>,
    ) -> Result<Response<proto::RevokePlatformConnectionResponse>, Status> {
        let peer = transport::peer(&request)?;
        let _permit = self
            .capacity
            .try_acquire()
            .map_err(|_| Status::resource_exhausted("platform connection service is busy"))?;
        let input = request.into_inner();
        let connection_id = input.connection_id.clone();
        let outcome = mutations::execute(
            &self.database,
            &self.native,
            &peer,
            Command::RevokeConnection(input),
        )
        .await?;
        Ok(Response::new(proto::RevokePlatformConnectionResponse {
            connection_id,
            credential_generation: outcome.version,
            decision: Some(outcome.decision),
        }))
    }
    async fn record_platform_execution(
        &self,
        request: Request<proto::RecordPlatformExecutionRequest>,
    ) -> Result<Response<proto::RecordPlatformExecutionResponse>, Status> {
        let peer = transport::peer(&request)?;
        let _permit = self
            .capacity
            .try_acquire()
            .map_err(|_| Status::resource_exhausted("platform audit service is busy"))?;
        Ok(Response::new(
            executions::record(&self.database, &peer, request.into_inner()).await?,
        ))
    }
    async fn get_platform_execution(
        &self,
        request: Request<proto::GetPlatformExecutionRequest>,
    ) -> Result<Response<proto::GetPlatformExecutionResponse>, Status> {
        let peer = transport::peer(&request)?;
        let _permit = self
            .capacity
            .try_acquire()
            .map_err(|_| Status::resource_exhausted("platform audit service is busy"))?;
        Ok(Response::new(
            executions::get(&self.database, &self.native, &peer, request.into_inner()).await?,
        ))
    }
    async fn write_policy_relationships(
        &self,
        request: Request<proto::WritePolicyRelationshipsRequest>,
    ) -> Result<Response<proto::WritePolicyRelationshipsResponse>, Status> {
        let peer = transport::peer(&request)?;
        let _permit = self
            .capacity
            .try_acquire()
            .map_err(|_| Status::resource_exhausted("platform policy service is busy"))?;
        Ok(Response::new(proto::WritePolicyRelationshipsResponse {
            decision: Some(
                mutations::execute(
                    &self.database,
                    &self.native,
                    &peer,
                    Command::Relationships(request.into_inner()),
                )
                .await?
                .decision,
            ),
        }))
    }
    async fn create_platform_delegation(
        &self,
        request: Request<proto::CreatePlatformDelegationRequest>,
    ) -> Result<Response<proto::CreatePlatformDelegationResponse>, Status> {
        let peer = transport::peer(&request)?;
        let _permit = self
            .capacity
            .try_acquire()
            .map_err(|_| Status::resource_exhausted("platform policy service is busy"))?;
        let outcome = mutations::execute(
            &self.database,
            &self.native,
            &peer,
            Command::Create(request.into_inner()),
        )
        .await?;
        Ok(Response::new(proto::CreatePlatformDelegationResponse {
            delegation_id: outcome.delegation_id,
            credential: outcome.credential,
            decision: Some(outcome.decision),
            credential_generation: outcome.version,
        }))
    }
    async fn activate_platform_delegation(
        &self,
        request: Request<proto::ActivatePlatformDelegationRequest>,
    ) -> Result<Response<proto::ActivatePlatformDelegationResponse>, Status> {
        let peer = transport::peer(&request)?;
        let _permit = self
            .capacity
            .try_acquire()
            .map_err(|_| Status::resource_exhausted("platform policy service is busy"))?;
        Ok(Response::new(proto::ActivatePlatformDelegationResponse {
            decision: Some(
                mutations::execute(
                    &self.database,
                    &self.native,
                    &peer,
                    Command::Activate(request.into_inner()),
                )
                .await?
                .decision,
            ),
        }))
    }
    async fn revoke_platform_delegation(
        &self,
        request: Request<proto::RevokePlatformDelegationRequest>,
    ) -> Result<Response<proto::RevokePlatformDelegationResponse>, Status> {
        let peer = transport::peer(&request)?;
        let _permit = self
            .capacity
            .try_acquire()
            .map_err(|_| Status::resource_exhausted("platform policy service is busy"))?;
        Ok(Response::new(proto::RevokePlatformDelegationResponse {
            decision: Some(
                mutations::execute(
                    &self.database,
                    &self.native,
                    &peer,
                    Command::Revoke(request.into_inner()),
                )
                .await?
                .decision,
            ),
        }))
    }
}
