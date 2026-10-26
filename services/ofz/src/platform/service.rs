use super::{
    authorization, catalog, connections, executions,
    mutations::{self, Command},
    onboarding,
};
use crate::{
    native::Native,
    proto::{self, platform_authorization_service_server::PlatformAuthorizationService},
    registry,
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
    capacity: Arc<Semaphore>,
}
impl Service {
    pub fn new(database: Database, native: Native) -> Self {
        Self {
            database,
            native,
            capacity: Arc::new(Semaphore::new(128)),
        }
    }
}
#[tonic::async_trait]
impl PlatformAuthorizationService for Service {
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
                })
                .collect(),
            policy_catalog_json: serde_json::to_string(catalog::configured()?)
                .map_err(|_| Status::internal("encode policy catalog"))?,
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
