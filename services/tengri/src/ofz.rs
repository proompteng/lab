#[allow(clippy::enum_variant_names)]
pub mod proto {
    tonic::include_proto!("proompteng.authz.v1");
}

use anyhow::{Context as _, ensure};
use hyper_util::rt::TokioIo;
use prost::Message;
use proto::{
    Action, Actor, CheckRequest, CheckResponse, CommandReceipt, ExecuteCommandRequest,
    GetCommandRequest, GetPolicyStateRequest, GetPolicyStateResponse,
    GetWorkspaceReservationRequest, GetWorkspaceReservationResponse, GetWorkspaceStateRequest,
    GetWorkspaceStateResponse, RequestContext, Resource, actor::Identity,
    authorization_service_client::AuthorizationServiceClient, execute_command_request::Command,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    io,
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{net::TcpStream, time::timeout};
use tokio_rustls::TlsConnector;
use tonic::{
    Request, Status,
    transport::{Channel, Endpoint},
};

pub const CONTROLLER_ID: &str = "spiffe://proompteng.ai/ns/tengri/sa/tengri";
pub const OFZ_ID: &str = "spiffe://proompteng.ai/ns/ofz/sa/ofz-api";
const DECISION_TIMEOUT: Duration = Duration::from_secs(2);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct Client {
    rpc: AuthorizationServiceClient<Channel>,
}

impl Client {
    pub fn new(target: &str, identity: &crate::identity::WorkloadIdentity) -> anyhow::Result<Self> {
        let url = reqwest::Url::parse(&format!("https://{target}"))?;
        ensure!(
            url.host_str()
                .is_some_and(|host| host.parse::<std::net::IpAddr>().is_err())
                && url.username().is_empty()
                && url.password().is_none()
                && url.path() == "/"
                && url.query().is_none()
                && url.fragment().is_none(),
            "Ofz requires a fixed DNS authority"
        );
        let tls = identity
            .guest_tls(OFZ_ID.parse()?)?
            .context("Ofz requires SPIFFE mutual TLS")?;
        let connector = TlsConnector::from(tls);
        let name = rustls::pki_types::ServerName::try_from(url.host_str().unwrap().to_owned())?;
        let address = format!(
            "{}:{}",
            url.host_str().unwrap(),
            url.port_or_known_default().unwrap()
        );
        let channel = Endpoint::from_shared(url.to_string())?
            .connect_timeout(DECISION_TIMEOUT)
            .connect_with_connector_lazy(tower::service_fn(move |_| {
                let connector = connector.clone();
                let name = name.clone();
                let address = address.clone();
                async move {
                    timeout(DECISION_TIMEOUT, async {
                        let tcp = TcpStream::connect(address).await?;
                        tcp.set_nodelay(true)?;
                        Ok::<_, io::Error>(TokioIo::new(connector.connect(name, tcp).await?))
                    })
                    .await
                    .map_err(|_| {
                        io::Error::new(io::ErrorKind::TimedOut, "Ofz handshake deadline")
                    })?
                }
            }));
        Ok(Self::from_channel(channel))
    }

    fn from_channel(channel: Channel) -> Self {
        Self {
            rpc: AuthorizationServiceClient::new(channel)
                .max_decoding_message_size(1_048_576)
                .max_encoding_message_size(65536),
        }
    }

    pub async fn state(&self) -> Result<GetPolicyStateResponse, Status> {
        let mut rpc = self.rpc.clone();
        let state = bounded(
            DECISION_TIMEOUT,
            rpc.get_policy_state(request(GetPolicyStateRequest {}, DECISION_TIMEOUT)),
        )
        .await?;
        if state.recovery_generation == 0 {
            return Err(Status::unavailable("invalid Ofz recovery generation"));
        }
        Ok(state)
    }

    pub async fn workspace_state(&self, uid: &str) -> Result<GetWorkspaceStateResponse, Status> {
        if !canonical_uuid(uid) {
            return Err(Status::invalid_argument("workspace UID required"));
        }
        let mut context = workload_context()?;
        context.workspace_uid = uid.into();
        context.deadline_unix_ms = now_ms()? + 2000;
        let mut rpc = self.rpc.clone();
        let state = bounded(
            DECISION_TIMEOUT,
            rpc.get_workspace_state(request(
                GetWorkspaceStateRequest {
                    context: Some(context),
                    workspace_uid: uid.into(),
                },
                DECISION_TIMEOUT,
            )),
        )
        .await?;
        let now = now_ms()?;
        if state.workspace_uid != uid
            || state.policy_version == 0
            || state.recovery_generation == 0
            || !canonical_uuid(&state.audit_receipt_id)
            || !canonical_human(&state.owner_id)
            || !canonical_uuid(&state.home_uid)
            || !canonical_uuid(&state.reservation_id)
            || state.home_bytes != 32 * 1024 * 1024 * 1024
            || !state.runtime_epoch.is_empty() && !canonical_uuid(&state.runtime_epoch)
            || !["active", "quarantined", "removing", "removed"].contains(&state.state.as_str())
            || state.runtime_allowed
                && (!state.running || state.runtime_epoch.is_empty() || state.state != "active")
            || state.valid_until_unix_ms <= now
            || state.valid_until_unix_ms > now + 2000
        {
            return Err(Status::unavailable("invalid Ofz runtime state"));
        }
        Ok(state)
    }

    pub async fn reservation(
        &self,
        principal: &crate::auth::Principal,
        id: &str,
    ) -> Result<GetWorkspaceReservationResponse, Status> {
        if !canonical_uuid(id) {
            return Err(Status::invalid_argument("capacity reservation required"));
        }
        let mut context = principal.context.clone();
        context.deadline_unix_ms = context.deadline_unix_ms.min(now_ms()? + 2000);
        let mut rpc = self.rpc.clone();
        let reservation = bounded(
            DECISION_TIMEOUT,
            rpc.get_workspace_reservation(request(
                GetWorkspaceReservationRequest {
                    context: Some(context),
                    reservation_id: id.into(),
                    recovery_generation: principal.recovery_generation,
                },
                DECISION_TIMEOUT,
            )),
        )
        .await?;
        let now = now_ms()?;
        if reservation.reservation_id != id
            || reservation.owner_id != principal.owner_hash
            || reservation.home_bytes != 32 * 1024 * 1024 * 1024
            || reservation.recovery_generation != principal.recovery_generation
            || !canonical_uuid(&reservation.audit_receipt_id)
            || reservation.valid_until_unix_ms <= now
            || reservation.valid_until_unix_ms > now + 2000
            || !matches!(reservation.state.as_str(), "reserved" | "enrolled")
            || (reservation.state == "enrolled") != canonical_uuid(&reservation.workspace_uid)
            || reservation.state == "reserved" && !reservation.workspace_uid.is_empty()
        {
            return Err(Status::unavailable("invalid Ofz capacity reservation"));
        }
        Ok(reservation)
    }

    pub async fn check(
        &self,
        context: RequestContext,
        action: Action,
        resource: Resource,
        target: String,
        receipt_id: String,
        recovery_generation: u64,
    ) -> Result<CheckResponse, Status> {
        let mut rpc = self.rpc.clone();
        let decision = bounded(
            DECISION_TIMEOUT,
            rpc.check(request(
                CheckRequest {
                    context: Some(context),
                    action: action as i32,
                    resource: Some(resource),
                    target,
                    stream_receipt_id: receipt_id,
                },
                DECISION_TIMEOUT,
            )),
        )
        .await?;
        if decision.recovery_generation != recovery_generation {
            return Err(Status::unauthenticated(
                "authorization recovery generation changed",
            ));
        }
        if !decision.allowed {
            return Err(Status::permission_denied("workspace action denied"));
        }
        let now = now_ms()?;
        if !canonical_uuid(&decision.audit_receipt_id)
            || decision.revision.is_empty()
            || decision.valid_until_unix_ms <= now
            || decision.valid_until_unix_ms > now + 2000
        {
            return Err(Status::unavailable("invalid or expired Ofz decision"));
        }
        Ok(decision)
    }

    pub async fn command(
        &self,
        operation_id: &str,
        command: Command,
    ) -> Result<CommandReceipt, Status> {
        if !canonical_uuid(operation_id) {
            return Err(Status::invalid_argument("canonical operation ID required"));
        }
        let payload = ExecuteCommandRequest {
            command: Some(command.clone()),
            ..Default::default()
        }
        .encode_to_vec();
        let client_request_hash = Sha256::digest(payload).to_vec();
        let mut rpc = self.rpc.clone();
        match bounded(
            COMMAND_TIMEOUT,
            rpc.get_command(request(
                GetCommandRequest {
                    context: Some(workload_context()?),
                    operation_id: operation_id.into(),
                    client_request_hash: client_request_hash.clone(),
                },
                COMMAND_TIMEOUT,
            )),
        )
        .await
        {
            Ok(response) => {
                return response
                    .receipt
                    .ok_or_else(|| Status::unavailable("Ofz command receipt missing"));
            }
            Err(error) if error.code() == tonic::Code::NotFound => {}
            Err(error) => return Err(error),
        }
        // Version conflicts have no committed intent. Reuse the operation identity with a fresh version.
        for _ in 0..3 {
            let state = self.state().await?;
            let mut rpc = self.rpc.clone();
            match bounded(
                COMMAND_TIMEOUT,
                rpc.execute_command(request(
                    ExecuteCommandRequest {
                        context: Some(workload_context()?),
                        operation_id: operation_id.into(),
                        expected_version: state.version,
                        reason: "attested workspace lifecycle".into(),
                        client_request_hash: client_request_hash.clone(),
                        command: Some(command.clone()),
                    },
                    COMMAND_TIMEOUT,
                )),
            )
            .await
            {
                Ok(response) => {
                    return response
                        .receipt
                        .ok_or_else(|| Status::unavailable("Ofz command receipt missing"));
                }
                Err(error) if error.code() == tonic::Code::Aborted => {}
                Err(error) => return Err(error),
            }
        }
        Err(Status::aborted("workspace policy changed repeatedly"))
    }
}

fn workload_context() -> Result<RequestContext, Status> {
    Ok(RequestContext {
        actor: Some(Actor {
            identity: Some(Identity::WorkloadId(CONTROLLER_ID.into())),
        }),
        trace_id: uuid::Uuid::new_v4().to_string(),
        deadline_unix_ms: now_ms()? + 5000,
        contract_version: 1,
        ..Default::default()
    })
}

fn request<T>(message: T, duration: Duration) -> Request<T> {
    let mut request = Request::new(message);
    request
        .metadata_mut()
        .insert("x-ofz-contract-version", "1".parse().unwrap());
    request.set_timeout(duration);
    request
}

async fn bounded<T>(
    duration: Duration,
    call: impl std::future::Future<Output = Result<tonic::Response<T>, Status>>,
) -> Result<T, Status> {
    timeout(duration, call)
        .await
        .map_err(|_| Status::unavailable("Ofz request deadline exceeded"))?
        .map(tonic::Response::into_inner)
}

#[derive(Deserialize)]
struct Operation {
    surface: String,
    operation: String,
    action: Option<String>,
}

pub fn action(surface: &str, operation: &str) -> Result<Action, Status> {
    static CATALOG: OnceLock<Vec<Operation>> = OnceLock::new();
    CATALOG
        .get_or_init(|| {
            serde_json::from_str(include_str!(concat!(
                env!("OUT_DIR"),
                "/ofz-operations.json"
            )))
            .expect("compiled authorization catalog")
        })
        .iter()
        .find(|entry| entry.surface == surface && entry.operation == operation)
        .and_then(|entry| entry.action.as_deref())
        .and_then(Action::from_str_name)
        .filter(|action| *action != Action::Unspecified)
        .ok_or_else(|| Status::permission_denied("unclassified protected operation"))
}

pub fn now_ms() -> Result<u64, Status> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|time| time.as_millis().try_into().ok())
        .ok_or_else(|| Status::unavailable("runtime clock unavailable"))
}

pub fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value)
        .is_ok_and(|id| !id.is_nil() && id.hyphenated().to_string() == value)
}

pub fn canonical_human(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}

pub fn operation_id(uid: &str, action: &str) -> String {
    let hash = Sha256::digest(format!("ofz.runtime.v1\n{uid}\n{action}"));
    let mut bytes: [u8; 16] = hash[..16].try_into().unwrap();
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(bytes).to_string()
}

#[cfg(test)]
#[path = "ofz_wire_test.rs"]
mod wire_test;
