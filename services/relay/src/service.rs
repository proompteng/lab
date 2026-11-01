use crate::connector::{Connector, Normalized};
use platform_client::{
    authz::{self, platform_authorization_service_client::PlatformAuthorizationServiceClient},
    relay::{self, relay_service_server::RelayService},
    request, tls,
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Semaphore;
use tonic::{Request, Response, Status, transport::Channel};

#[derive(Clone)]
pub struct Service {
    clients: crate::enrollment::Enrollment,
    connectors: Arc<BTreeMap<String, Box<dyn Connector>>>,
    ofz: PlatformAuthorizationServiceClient<Channel>,
    capacity: Arc<Semaphore>,
}
impl Service {
    pub fn new(
        configuration: authz::GetPlatformConfigurationResponse,
        connectors: Vec<Box<dyn Connector>>,
        channel: Channel,
    ) -> Result<Self, Status> {
        let mut adapters = BTreeMap::new();
        for connector in connectors {
            if adapters
                .insert(connector.id().to_owned(), connector)
                .is_some()
            {
                return Err(Status::invalid_argument("duplicate connector adapter"));
            }
        }
        validate_providers(&adapters, &configuration)?;
        Ok(Self {
            clients: crate::enrollment::Enrollment::new(configuration.relay_clients),
            connectors: Arc::new(adapters),
            ofz: PlatformAuthorizationServiceClient::new(channel)
                .max_encoding_message_size(131_072)
                .max_decoding_message_size(1_048_576),
            capacity: Arc::new(Semaphore::new(64)),
        })
    }
    pub fn peer_authorizer(
        &self,
    ) -> impl Fn(&platform_client::tls::SpiffeIdentity) -> bool + Send + Sync + 'static {
        let clients = self.clients.clone();
        move |peer| clients.permits(&peer.to_string(), None)
    }
    pub async fn refresh_enrollment(&self) {
        let outcome = tokio::time::timeout(
            Duration::from_secs(5),
            self.ofz
                .clone()
                .get_platform_configuration(request(authz::GetPlatformConfigurationRequest {})),
        )
        .await;
        let clients = match outcome {
            Ok(Ok(response)) => {
                let configuration = response.into_inner();
                if validate_providers(&self.connectors, &configuration).is_ok() {
                    configuration.relay_clients
                } else {
                    Vec::new()
                }
            }
            _ => Vec::new(),
        };
        self.clients.replace(clients);
    }
    fn client(&self, peer: &str, id: &str) -> Result<(), Status> {
        if self.clients.permits(peer, Some(id)) {
            Ok(())
        } else {
            Err(Status::permission_denied(
                "registered Relay client required",
            ))
        }
    }
    async fn check(
        &self,
        check: authz::CheckPlatformAccessRequest,
    ) -> Result<authz::PlatformDecision, Status> {
        let decision = self
            .ofz
            .clone()
            .check_platform_access(request(check))
            .await?
            .into_inner()
            .decision
            .ok_or_else(|| Status::unavailable("platform decision missing"))?;
        validate_decision(decision)
    }
    async fn outcome(
        &self,
        check: &authz::CheckPlatformAccessRequest,
        receipt: &str,
        outcome: &str,
        status: u32,
        result: &[u8],
    ) -> Result<String, Status> {
        let response = self
            .ofz
            .clone()
            .record_platform_execution(request(authz::RecordPlatformExecutionRequest {
                operation_id: check.operation_id.clone(),
                authorization_receipt_id: receipt.into(),
                request_hash: check.request_hash.clone(),
                outcome: outcome.into(),
                upstream_status: status,
                result_hash: result_hash(outcome, result),
            }))
            .await?
            .into_inner();
        if uuid::Uuid::parse_str(&response.audit_receipt_id).is_err() {
            return Err(Status::unavailable(
                "execution outcome was not durably recorded",
            ));
        }
        Ok(response.audit_receipt_id)
    }
    fn client_subject(
        &self,
        peer: &str,
        subject: &authz::PlatformSubject,
        client_service: &str,
        delegation_id: Option<&str>,
    ) -> Result<(), Status> {
        self.client(peer, &subject.client_service)?;
        if matches!(subject.identity.as_ref(), Some(authz::platform_subject::Identity::WorkloadId(identity)) if identity != peer)
        {
            return Err(Status::permission_denied(
                "workload subject must match its attested caller",
            ));
        }
        if client_service != subject.client_service
            || match &subject.identity {
                Some(authz::platform_subject::Identity::Delegation(proof)) => {
                    delegation_id != Some(proof.delegation_id.as_str())
                }
                _ => delegation_id.is_some(),
            }
        {
            return Err(Status::permission_denied(
                "execution subject differs from its signed body",
            ));
        }
        Ok(())
    }
    fn normalize(
        &self,
        payload: &platform_client::ExecutionPayload,
    ) -> Result<(&dyn Connector, Normalized), Status> {
        let connector = self
            .connectors
            .get(&payload.connector_id)
            .ok_or_else(|| Status::not_found("connector not registered"))?;
        let operation = connector
            .operations(None)
            .into_iter()
            .find(|operation| operation.name == payload.operation)
            .ok_or_else(|| Status::unimplemented("connector operation is not onboarded"))?;
        if !operation.read_only {
            return Err(Status::unimplemented(
                "effectful connector operations require an execution contract",
            ));
        }
        let normalized = connector.normalize(
            &payload.operation,
            &serde_json::to_vec(&payload.arguments)
                .map_err(|_| Status::invalid_argument("invalid connector arguments"))?,
        )?;
        if operation.action != normalized.action
            || normalized.resources.iter().any(|resource| {
                !operation.targets.iter().any(|target| {
                    target.resource.as_ref().is_some_and(|declared| {
                        declared.kind == resource.kind && declared.id == resource.id
                    })
                })
            })
        {
            return Err(Status::internal(
                "adapter target differs from its registered operation",
            ));
        }
        Ok((connector.as_ref(), normalized))
    }
    async fn lookup(
        &self,
        peer: &str,
        input: relay::GetExecutionRequest,
    ) -> Result<relay::GetExecutionResponse, Status> {
        if input.body.len() > platform_client::MAX_RELAY_REQUEST_BYTES {
            return Err(Status::invalid_argument(
                "execution lookup exceeds its byte budget",
            ));
        }
        let lookup: platform_client::ExecutionLookup = serde_json::from_slice(&input.body)
            .map_err(|_| Status::invalid_argument("invalid execution lookup"))?;
        let payload = parse_execution(lookup.execution_body.as_bytes())?;
        let subject = input
            .subject
            .as_ref()
            .ok_or_else(|| Status::unauthenticated("platform subject required"))?;
        self.client_subject(
            peer,
            subject,
            &payload.client_service,
            lookup.delegation_id.as_deref(),
        )?;
        let same_binding = match (&payload.binding, &lookup.binding) {
            (None, None) => true,
            (Some(original), Some(current)) => {
                original.service == current.service && original.id == current.id
            }
            _ => false,
        };
        if !same_binding {
            return Err(Status::permission_denied(
                "execution lookup binding changed",
            ));
        }
        let (_, normalized) = self.normalize(&payload)?;
        let execution_hash = Sha256::digest(lookup.execution_body.as_bytes()).to_vec();
        let response = self
            .ofz
            .clone()
            .get_platform_execution(request(authz::GetPlatformExecutionRequest {
                authorization: Some(authz::CheckPlatformAccessRequest {
                    operation_id: payload.operation_id.clone(),
                    subject: input.subject,
                    action: normalized.action,
                    resources: normalized.resources,
                    request_hash: Sha256::digest(&input.body).to_vec(),
                    binding: lookup.binding,
                    audit_receipt_id: String::new(),
                }),
                execution_request_hash: execution_hash.clone(),
            }))
            .await?
            .into_inner();
        let decision = validate_decision(
            response
                .decision
                .ok_or_else(|| Status::unavailable("lookup decision missing"))?,
        )?;
        let execution = response
            .execution
            .ok_or_else(|| Status::unavailable("execution snapshot missing"))?;
        if execution.operation_id != payload.operation_id
            || execution.request_hash != execution_hash
            || !matches!(
                execution.outcome.as_str(),
                "started" | "succeeded" | "failed" | "withheld"
            )
            || uuid::Uuid::parse_str(&execution.authorization_receipt_id).is_err()
            || uuid::Uuid::parse_str(&execution.execution_receipt_id).is_err()
            || execution.upstream_status > 599
            || execution.updated_at_unix_ms == 0
            || (!execution.result_hash.is_empty() && execution.result_hash.len() != 32)
            || (matches!(execution.outcome.as_str(), "succeeded" | "withheld")
                && execution.result_hash.len() != 32)
        {
            return Err(Status::unavailable("invalid execution snapshot"));
        }
        Ok(relay::GetExecutionResponse {
            execution: Some(execution),
            lookup_receipt_id: decision.audit_receipt_id,
        })
    }
    async fn invoke(
        &self,
        peer: &str,
        input: relay::ExecuteRequest,
    ) -> Result<relay::ExecuteResponse, Status> {
        let payload = parse_execution(&input.body)?;
        let subject = input
            .subject
            .as_ref()
            .ok_or_else(|| Status::unauthenticated("platform subject required"))?;
        self.client_subject(
            peer,
            subject,
            &payload.client_service,
            payload.delegation_id.as_deref(),
        )?;
        let (connector, normalized) = self.normalize(&payload)?;
        let hash = Sha256::digest(&input.body).to_vec();
        let mut check = authz::CheckPlatformAccessRequest {
            operation_id: payload.operation_id.clone(),
            subject: input.subject,
            action: normalized.action.clone(),
            resources: normalized.resources.clone(),
            request_hash: hash,
            binding: payload.binding,
            audit_receipt_id: String::new(),
        };
        let decision = self.check(check.clone()).await?;
        check.audit_receipt_id = decision.audit_receipt_id;
        self.outcome(&check, &check.audit_receipt_id, "started", 0, &[])
            .await?;
        let invocation: Result<_, crate::connector::Failure> = async {
            let bearer = if let Some(provider) = connector.provider() {
                let credential = self
                    .ofz
                    .clone()
                    .resolve_provider_credential(request(authz::ResolveProviderCredentialRequest {
                        profile_id: provider.profile.into(),
                        connector_id: connector.id().into(),
                        destination: provider.destination.into(),
                        authorization: Some(check.clone()),
                    }))
                    .await
                    .map_err(crate::connector::Failure::from)?
                    .into_inner();
                if credential.access_token.is_empty()
                    || credential.access_token.len() > 16_384
                    || credential.access_token.chars().any(char::is_control)
                    || uuid::Uuid::parse_str(&credential.connection_id).is_err()
                {
                    return Err(Status::unavailable("invalid provider credential response").into());
                }
                Some(credential.access_token)
            } else {
                None
            };
            self.check(check.clone())
                .await
                .map_err(crate::connector::Failure::from)?;
            connector.execute(&normalized, bearer.as_deref()).await
        }
        .await;
        let output = match invocation {
            Ok(output) => output,
            Err(error) => {
                self.outcome(
                    &check,
                    &check.audit_receipt_id,
                    "failed",
                    error.upstream_status,
                    &[],
                )
                .await?;
                return Err(error.status);
            }
        };
        if let Err(error) = self.check(check.clone()).await {
            self.outcome(
                &check,
                &check.audit_receipt_id,
                "withheld",
                output.upstream_status,
                &output.bytes,
            )
            .await?;
            return Err(error);
        }
        let execution_receipt = self
            .outcome(
                &check,
                &check.audit_receipt_id,
                "succeeded",
                output.upstream_status,
                &output.bytes,
            )
            .await?;
        if let Err(error) = self.check(check.clone()).await {
            self.outcome(
                &check,
                &check.audit_receipt_id,
                "withheld",
                output.upstream_status,
                &output.bytes,
            )
            .await?;
            return Err(error);
        }
        Ok(relay::ExecuteResponse {
            operation_id: payload.operation_id,
            result: output.bytes,
            content_type: output.content_type,
            authorization_receipt_id: check.audit_receipt_id,
            execution_receipt_id: execution_receipt,
        })
    }
}
fn validate_providers(
    connectors: &BTreeMap<String, Box<dyn Connector>>,
    configuration: &authz::GetPlatformConfigurationResponse,
) -> Result<(), Status> {
    for connector in connectors.values() {
        if let Some(provider) = connector.provider()
            && !configuration.provider_profiles.iter().any(|profile| {
                profile.id == provider.profile
                    && profile.connector_id == connector.id()
                    && profile.destination == provider.destination
            })
        {
            return Err(Status::failed_precondition(
                "connector OAuth profile does not match its Ofz registration",
            ));
        }
    }
    Ok(())
}

fn parse_execution(body: &[u8]) -> Result<platform_client::ExecutionPayload, Status> {
    if body.len() > platform_client::MAX_EXECUTION_BODY_BYTES {
        return Err(Status::invalid_argument(
            "execution body exceeds its byte budget",
        ));
    }
    let payload: platform_client::ExecutionPayload = serde_json::from_slice(body)
        .map_err(|_| Status::invalid_argument("invalid platform execution payload"))?;
    if uuid::Uuid::parse_str(&payload.operation_id).is_err() {
        return Err(Status::invalid_argument(
            "execution operation UUID required",
        ));
    }
    Ok(payload)
}
fn validate_decision(decision: authz::PlatformDecision) -> Result<authz::PlatformDecision, Status> {
    let now = now_ms()?;
    if !decision.allowed {
        return Err(Status::permission_denied(
            "Ofz denied this connector operation",
        ));
    }
    if decision.revision.is_empty()
        || uuid::Uuid::parse_str(&decision.audit_receipt_id).is_err()
        || decision.recovery_generation == 0
        || decision.valid_until_unix_ms <= now
        || decision.valid_until_unix_ms > now + 2000
    {
        return Err(Status::unavailable(
            "invalid or expired platform authorization",
        ));
    }
    Ok(decision)
}
fn now_ms() -> Result<u64, Status> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| Status::unavailable("system clock unavailable"))?
        .as_millis() as u64)
}
#[tonic::async_trait]
impl RelayService for Service {
    async fn get_execution(
        &self,
        input: Request<relay::GetExecutionRequest>,
    ) -> Result<Response<relay::GetExecutionResponse>, Status> {
        let peer = tls::peer(&input)?;
        let _permit = self
            .capacity
            .try_acquire()
            .map_err(|_| Status::resource_exhausted("Relay is busy"))?;
        tokio::time::timeout(
            Duration::from_secs(30),
            self.lookup(&peer, input.into_inner()),
        )
        .await
        .map_err(|_| Status::deadline_exceeded("Relay lookup deadline"))?
        .map(Response::new)
    }
    async fn list_operations(
        &self,
        input: Request<relay::ListOperationsRequest>,
    ) -> Result<Response<relay::ListOperationsResponse>, Status> {
        let peer = tls::peer(&input)?;
        let subject = input
            .into_inner()
            .subject
            .ok_or_else(|| Status::unauthenticated("discovery subject required"))?;
        self.client_subject(&peer, &subject, &subject.client_service, None)?;
        let _permit = self
            .capacity
            .try_acquire()
            .map_err(|_| Status::resource_exhausted("Relay is busy"))?;
        let access = self
            .ofz
            .clone()
            .discover_platform_access(request(authz::DiscoverPlatformAccessRequest {
                subject: Some(subject),
            }))
            .await?
            .into_inner();
        let operations = self
            .connectors
            .values()
            .flat_map(|connector| connector.operations(Some(&access.scopes)))
            .collect();
        Ok(Response::new(relay::ListOperationsResponse { operations }))
    }
    async fn execute(
        &self,
        input: Request<relay::ExecuteRequest>,
    ) -> Result<Response<relay::ExecuteResponse>, Status> {
        let peer = tls::peer(&input)?;
        let _permit = self
            .capacity
            .try_acquire()
            .map_err(|_| Status::resource_exhausted("Relay is busy"))?;
        tokio::time::timeout(
            Duration::from_secs(30),
            self.invoke(&peer, input.into_inner()),
        )
        .await
        .map_err(|_| Status::deadline_exceeded("Relay execution deadline"))?
        .map(Response::new)
    }
}

fn result_hash(outcome: &str, result: &[u8]) -> Vec<u8> {
    if result.is_empty() && !matches!(outcome, "succeeded" | "withheld") {
        Vec::new()
    } else {
        Sha256::digest(result).to_vec()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completed_empty_results_retain_a_digest_for_receipt_lookup() {
        for outcome in ["succeeded", "withheld"] {
            assert_eq!(result_hash(outcome, b""), Sha256::digest(b"").to_vec());
        }
        assert!(result_hash("failed", b"").is_empty());
    }

    #[tokio::test]
    async fn workloads_cannot_assert_another_identity_in_the_same_service() {
        let first = "spiffe://proompteng.ai/ns/example/sa/first";
        let second = "spiffe://proompteng.ai/ns/example/sa/second";
        let service = Service::new(
            authz::GetPlatformConfigurationResponse {
                relay_clients: vec![authz::RegisteredRelayClient {
                    id: "example".into(),
                    identities: vec![first.into(), second.into()],
                    display_name: "Example".into(),
                }],
                ..Default::default()
            },
            Vec::new(),
            tonic::transport::Endpoint::from_static("http://localhost:1").connect_lazy(),
        )
        .unwrap();
        let payload = platform_client::ExecutionPayload {
            operation_id: uuid::Uuid::new_v4().to_string(),
            client_service: "example".into(),
            connector_id: "fixture".into(),
            operation: "status".into(),
            arguments: serde_json::json!({}),
            binding: None,
            delegation_id: None,
        };
        let input = relay::ExecuteRequest {
            subject: Some(authz::PlatformSubject {
                client_service: "example".into(),
                identity: Some(authz::platform_subject::Identity::WorkloadId(second.into())),
            }),
            body: serde_json::to_vec(&payload).unwrap(),
        };
        let mut discovery = request(relay::ListOperationsRequest {
            subject: input.subject.clone(),
        });
        discovery.extensions_mut().insert(tls::Peer(first.into()));
        assert_eq!(
            service.list_operations(discovery).await.unwrap_err().code(),
            tonic::Code::PermissionDenied
        );
        let lookup = relay::GetExecutionRequest {
            subject: input.subject.clone(),
            body: serde_json::to_vec(&platform_client::ExecutionLookup {
                execution_body: String::from_utf8(input.body.clone()).unwrap(),
                binding: None,
                delegation_id: None,
            })
            .unwrap(),
        };
        assert_eq!(
            service
                .lookup(first, lookup.clone())
                .await
                .unwrap_err()
                .code(),
            tonic::Code::PermissionDenied
        );
        assert_eq!(
            service
                .lookup(second, lookup.clone())
                .await
                .unwrap_err()
                .code(),
            tonic::Code::NotFound
        );
        assert_eq!(
            service
                .invoke(
                    second,
                    relay::ExecuteRequest {
                        subject: lookup.subject,
                        body: lookup.body,
                    }
                )
                .await
                .unwrap_err()
                .code(),
            tonic::Code::InvalidArgument
        );
        assert_eq!(
            service
                .lookup(
                    second,
                    relay::GetExecutionRequest {
                        subject: input.subject.clone(),
                        body: input.body.clone(),
                    }
                )
                .await
                .unwrap_err()
                .code(),
            tonic::Code::InvalidArgument
        );
        assert_eq!(
            service
                .invoke(first, input.clone())
                .await
                .unwrap_err()
                .code(),
            tonic::Code::PermissionDenied
        );
        assert_eq!(
            service.invoke(second, input).await.unwrap_err().code(),
            tonic::Code::NotFound
        );
    }
}
