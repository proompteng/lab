use std::{env, sync::Arc};

use anyhow::Context;
use axum::{
    Json, Router,
    body::Body,
    extract::State,
    http::{HeaderMap, Request, StatusCode},
    response::Response,
    routing::{get, post},
};
use futures::StreamExt;
use hyper_util::{
    rt::{TokioExecutor, TokioIo},
    server::conn::auto::Builder,
    service::TowerToHyperService,
};
use tokio::{
    net::TcpListener,
    sync::{Mutex, watch},
};

use super::{
    Claim, GUEST_API_PORT, SlotState,
    runner::{self, CommandRequest, SlotStatus},
    vmm::connect_vsock,
};

pub const CLAIM_UID_HEADER: &str = "x-tengri-microvm-uid";
pub const CLAIM_EPOCH_HEADER: &str = "x-tengri-claim-epoch";
pub const LEADER_OWNER_HEADER: &str = "x-tengri-leader-owner";
pub const LEADER_GENERATION_HEADER: &str = "x-tengri-leader-generation";

#[derive(Clone)]
struct Supervisor {
    state: watch::Sender<SlotState>,
    gate: Arc<Mutex<()>>,
    database: Arc<crate::control::Database>,
    leadership: watch::Sender<Option<crate::control::Fence>>,
}

impl Supervisor {
    async fn wait_for_leadership_loss(&self, fence: crate::control::Fence) {
        let mut changes = self.leadership.subscribe();
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
        loop {
            tokio::select! {
                _ = interval.tick() => { if self.require_leadership(Some(fence)).await.is_err() { return; } }
                result = changes.changed() => { if result.is_err() || *changes.borrow() != Some(fence) { return; } }
            }
        }
    }

    async fn require_leadership(
        &self,
        expected: Option<crate::control::Fence>,
    ) -> Result<crate::control::Fence, (StatusCode, String)> {
        let fence = (*self.leadership.borrow()).ok_or_else(|| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "controller fence not installed".into(),
            )
        })?;
        if expected.is_some_and(|expected| expected != fence) {
            return Err((
                StatusCode::CONFLICT,
                "controller fencing generation changed".into(),
            ));
        }
        self.database.require_fence(fence).await.map_err(|_| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "controller leadership unavailable".into(),
            )
        })?;
        Ok(fence)
    }

    fn fence(
        &self,
        current: &SlotState,
        request: &CommandRequest,
    ) -> Result<(), (StatusCode, String)> {
        let (claim, allowed, next) = match request {
            CommandRequest::Sleep { claim } => (
                claim,
                matches!(current, SlotState::Vacant { .. })
                    || current.serves(claim)
                    || matches!(current, SlotState::Sleeping { claim: owner, .. } | SlotState::Saving { claim: owner } if owner == claim),
                SlotState::Saving {
                    claim: claim.clone(),
                },
            ),
            CommandRequest::Stop { claim } => (
                claim,
                current.claim() == Some(claim)
                    || matches!(
                        current,
                        SlotState::Vacant { .. } | SlotState::Failed { claim: None, .. }
                    ),
                SlotState::Stopping {
                    claim: claim.clone(),
                },
            ),
            _ => return Err(busy()),
        };
        claim
            .validate()
            .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
        if !allowed {
            return Err((
                StatusCode::CONFLICT,
                "slot owner, epoch, or lifecycle changed".into(),
            ));
        }
        self.state.send_replace(next);
        Ok(())
    }
}

pub async fn run() -> anyhow::Result<()> {
    let namespace = env::var("TENGRI_NAMESPACE")?;
    let pod_uid = env::var("TENGRI_POD_UID")?;
    let identity = crate::identity::WorkloadIdentity::for_slot(&namespace, &pod_uid).await?;
    let tls = identity.slot_server_tls(&namespace)?;
    let database = Arc::new(crate::control::Database::from_environment("tengri_supervisor").await?);
    database.verify_schema().await?;
    let health = Router::new()
        .route("/livez", get(|| async { StatusCode::OK }))
        .route(
            "/readyz",
            get(|| async {
                match runner::command(&CommandRequest::Status).await {
                    Ok(status)
                        if matches!(
                            status.state,
                            SlotState::Vacant { .. }
                                | SlotState::Awake { .. }
                                | SlotState::Sleeping { .. }
                        ) =>
                    {
                        StatusCode::OK
                    }
                    _ => StatusCode::SERVICE_UNAVAILABLE,
                }
            }),
        );
    let health_listener = TcpListener::bind("0.0.0.0:8080").await?;
    let health_task = tokio::spawn(async move { axum::serve(health_listener, health).await });
    let listener = TcpListener::bind("0.0.0.0:8443").await?;
    tokio::select! {
        result = serve(listener, tls, database) => result,
        result = health_task => { result??; anyhow::bail!("supervisor health listener stopped") },
    }
}

pub(super) async fn serve(
    listener: TcpListener,
    tls: Arc<rustls::ServerConfig>,
    database: Arc<crate::control::Database>,
) -> anyhow::Result<()> {
    let (state, _) = watch::channel(SlotState::Preparing);
    let supervisor = Supervisor {
        state,
        gate: Arc::new(Mutex::new(())),
        database,
        leadership: watch::channel(None).0,
    };
    let router = Router::new()
        .route("/slot/status", get(status))
        .route("/slot/fence", post(install_fence))
        .route("/slot/restore", post(restore))
        .route("/slot/sleep", post(sleep))
        .route("/slot/stop", post(stop))
        .fallback(forward)
        .with_state(supervisor);
    let incoming = crate::identity::tls_incoming(listener, tls);
    tokio::pin!(incoming);
    while let Some(connection) = incoming.next().await {
        let connection = connection?;
        let service = TowerToHyperService::new(router.clone());
        tokio::spawn(async move {
            let builder = Builder::new(TokioExecutor::new());
            if let Err(error) = builder
                .serve_connection_with_upgrades(TokioIo::new(connection), service)
                .await
            {
                tracing::debug!(error = %error, "supervisor connection closed");
            }
        });
    }
    Ok(())
}

async fn install_fence(
    State(supervisor): State<Supervisor>,
    Json(fence): Json<crate::control::Fence>,
) -> Result<StatusCode, (StatusCode, String)> {
    supervisor
        .database
        .require_fence(fence)
        .await
        .map_err(|_| {
            (
                StatusCode::CONFLICT,
                "controller fencing generation rejected".into(),
            )
        })?;
    let _guard = supervisor.gate.lock().await;
    if supervisor.leadership.borrow().is_some_and(|installed| {
        installed.generation > fence.generation
            || installed.generation == fence.generation && installed.owner != fence.owner
    }) {
        return Err((
            StatusCode::CONFLICT,
            "controller fencing generation regressed".into(),
        ));
    }
    supervisor.leadership.send_replace(Some(fence));
    Ok(StatusCode::NO_CONTENT)
}

fn request_fence(headers: &HeaderMap) -> Result<crate::control::Fence, (StatusCode, String)> {
    let invalid = || {
        (
            StatusCode::UNAUTHORIZED,
            "controller fencing headers required".into(),
        )
    };
    if headers.get_all(LEADER_OWNER_HEADER).iter().count() != 1
        || headers.get_all(LEADER_GENERATION_HEADER).iter().count() != 1
    {
        return Err(invalid());
    }
    let owner = headers
        .get(LEADER_OWNER_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or_else(invalid)?;
    let generation = headers
        .get(LEADER_GENERATION_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or_else(invalid)?;
    crate::control::Fence { owner, generation }
        .validate()
        .map_err(|_| invalid())
}

async fn status(
    State(supervisor): State<Supervisor>,
) -> Result<Json<SlotStatus>, (StatusCode, String)> {
    let _guard = supervisor.gate.lock().await;
    let status = runner::command(&CommandRequest::Status)
        .await
        .map_err(lifecycle_error)?;
    supervisor.state.send_replace(status.state.clone());
    Ok(Json(status))
}

async fn restore(
    State(supervisor): State<Supervisor>,
    headers: HeaderMap,
    Json(claim): Json<Claim>,
) -> Result<Json<SlotStatus>, (StatusCode, String)> {
    lifecycle(
        &supervisor,
        request_fence(&headers)?,
        &CommandRequest::Restore { claim },
    )
    .await
}

async fn sleep(
    State(supervisor): State<Supervisor>,
    headers: HeaderMap,
    Json(claim): Json<Claim>,
) -> Result<Json<SlotStatus>, (StatusCode, String)> {
    lifecycle(
        &supervisor,
        request_fence(&headers)?,
        &CommandRequest::Sleep { claim },
    )
    .await
}

async fn stop(
    State(supervisor): State<Supervisor>,
    headers: HeaderMap,
    Json(claim): Json<Claim>,
) -> Result<Json<SlotStatus>, (StatusCode, String)> {
    lifecycle(
        &supervisor,
        request_fence(&headers)?,
        &CommandRequest::Stop { claim },
    )
    .await
}

async fn lifecycle(
    supervisor: &Supervisor,
    leadership: crate::control::Fence,
    request: &CommandRequest,
) -> Result<Json<SlotStatus>, (StatusCode, String)> {
    let _guard = supervisor.gate.lock().await;
    supervisor.require_leadership(Some(leadership)).await?;
    if matches!(
        request,
        CommandRequest::Sleep { .. } | CommandRequest::Stop { .. }
    ) {
        let current = runner::command(&CommandRequest::Status)
            .await
            .map_err(lifecycle_error)?;
        supervisor.fence(&current.state, request)?;
    }
    drop(_guard);
    let result = runner::command(request).await;
    let _guard = supervisor.gate.lock().await;
    supervisor.require_leadership(Some(leadership)).await?;
    let status = match result {
        Ok(status) => status,
        Err(error) => {
            if let Ok(status) = runner::command(&CommandRequest::Status).await {
                supervisor.state.send_replace(status.state);
            }
            return Err(lifecycle_error(error));
        }
    };
    supervisor.state.send_replace(status.state.clone());
    Ok(Json(status))
}

fn lifecycle_error(error: anyhow::Error) -> (StatusCode, String) {
    (StatusCode::SERVICE_UNAVAILABLE, error.to_string())
}

fn busy() -> (StatusCode, String) {
    (StatusCode::CONFLICT, "slot lifecycle is busy".into())
}

async fn forward(
    State(supervisor): State<Supervisor>,
    mut request: Request<Body>,
) -> Result<Response, (StatusCode, String)> {
    #[cfg(test)]
    let started = std::time::Instant::now();
    // The status read and transport admission cannot overlap a sleep fence.
    let guard = supervisor.gate.lock().await;
    let leadership = supervisor.require_leadership(None).await?;
    let status = runner::command(&CommandRequest::Status)
        .await
        .map_err(lifecycle_error)?;
    let claim = status
        .state
        .claim()
        .context("slot is unclaimed")
        .map_err(lifecycle_error)?
        .clone();
    if !status.state.serves(&claim)
        || request
            .headers()
            .get(CLAIM_UID_HEADER)
            .and_then(|v| v.to_str().ok())
            != Some(claim.microvm_uid.as_str())
        || request
            .headers()
            .get(CLAIM_EPOCH_HEADER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            != Some(claim.epoch)
    {
        return Err((
            StatusCode::CONFLICT,
            "slot owner, epoch, or lifecycle changed".into(),
        ));
    }
    supervisor.state.send_replace(status.state);
    #[cfg(test)]
    eprintln!(
        "real KVM proxy status: {:.2} ms cumulative",
        started.elapsed().as_secs_f64() * 1000.0
    );
    let mut state = supervisor.state.subscribe();
    let socket = runner::sockets_directory().join("guest.vsock");
    let stream = connect_vsock(&socket, GUEST_API_PORT)
        .await
        .map_err(lifecycle_error)?;
    #[cfg(test)]
    eprintln!(
        "real KVM proxy vsock: {:.2} ms cumulative",
        started.elapsed().as_secs_f64() * 1000.0
    );
    drop(guard);
    let mut parts = request.uri().clone().into_parts();
    parts.scheme = Some(axum::http::uri::Scheme::HTTP);
    parts.authority = Some(axum::http::uri::Authority::from_static("nanoagent"));
    *request.uri_mut() =
        axum::http::Uri::from_parts(parts).map_err(|error| lifecycle_error(error.into()))?;
    let grpc = request
        .headers()
        .get("content-type")
        .is_some_and(|v| v.as_bytes().starts_with(b"application/grpc"));
    let expected = claim.clone();
    if grpc {
        let (mut sender, connection) =
            hyper::client::conn::http2::handshake(TokioExecutor::new(), TokioIo::new(stream))
                .await
                .map_err(|error| lifecycle_error(error.into()))?;
        #[cfg(test)]
        eprintln!(
            "real KVM proxy HTTP/2: {:.2} ms cumulative",
            started.elapsed().as_secs_f64() * 1000.0
        );
        let authority = supervisor.clone();
        tokio::spawn(async move {
            tokio::pin!(connection);
            tokio::select! {
                _ = &mut connection => {},
                _ = state.wait_for(|state| !state.serves(&expected)) => {},
                _ = authority.wait_for_leadership_loss(leadership) => {},
            }
        });
        let response = sender
            .send_request(request)
            .await
            .map_err(|error| lifecycle_error(error.into()))?;
        #[cfg(test)]
        eprintln!(
            "real KVM proxy reply: {:.2} ms cumulative",
            started.elapsed().as_secs_f64() * 1000.0
        );
        Ok(response.map(Body::new))
    } else {
        let downstream_upgrade = hyper::upgrade::on(&mut request);
        let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .map_err(|error| lifecycle_error(error.into()))?;
        let authority = supervisor.clone();
        tokio::spawn(async move {
            let connection = connection.with_upgrades();
            tokio::pin!(connection);
            tokio::select! {
                _ = &mut connection => {},
                _ = state.wait_for(|state| !state.serves(&expected)) => {},
                _ = authority.wait_for_leadership_loss(leadership) => {},
            }
        });
        let mut response = sender
            .send_request(request)
            .await
            .map_err(|error| lifecycle_error(error.into()))?;
        if response.status() == StatusCode::SWITCHING_PROTOCOLS {
            let upstream_upgrade = hyper::upgrade::on(&mut response);
            let mut state = supervisor.state.subscribe();
            let authority = supervisor.clone();
            tokio::spawn(async move {
                if let (Ok(downstream), Ok(upstream)) =
                    tokio::join!(downstream_upgrade, upstream_upgrade)
                {
                    let (mut downstream, mut upstream) =
                        (TokioIo::new(downstream), TokioIo::new(upstream));
                    tokio::select! {
                        _ = tokio::io::copy_bidirectional(&mut downstream, &mut upstream) => {},
                        _ = state.wait_for(|state| !state.serves(&claim)) => {},
                        _ = authority.wait_for_leadership_loss(leadership) => {},
                    }
                }
            });
        }
        Ok(response.map(Body::new))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn concurrent_guest_requests_wait_for_transport_admission() {
        let (state, _) = watch::channel(SlotState::Awake {
            claim: Claim {
                microvm_id: "agent-a".into(),
                microvm_uid: "owner-a".into(),
                epoch: 7,
            },
        });
        let gate = Arc::new(Mutex::new(()));
        let _admission = gate.lock().await;
        let request = Request::builder()
            .uri("/proompteng.runtime.guest.v1.NanoagentService/GetInfo")
            .header(CLAIM_UID_HEADER, "owner-a")
            .header(CLAIM_EPOCH_HEADER, "7")
            .body(Body::empty())
            .unwrap();
        let supervisor = Supervisor {
            state,
            gate: gate.clone(),
            database: Arc::new(crate::control::Database::unconnected_fixture()),
            leadership: watch::channel(None).0,
        };
        let response = forward(State(supervisor), request);
        futures::pin_mut!(response);
        assert!(futures::poll!(response).is_pending());
    }

    #[test]
    fn a_pending_sleep_commit_can_only_be_retried_by_its_owner() {
        let owner = Claim {
            microvm_id: "agent-a".into(),
            microvm_uid: "owner-a".into(),
            epoch: 7,
        };
        let saving = SlotState::Saving {
            claim: owner.clone(),
        };
        let (state, _) = watch::channel(saving.clone());
        let supervisor = Supervisor {
            state,
            gate: Arc::new(Mutex::new(())),
            database: Arc::new(crate::control::Database::unconnected_fixture()),
            leadership: watch::channel(None).0,
        };
        for claim in [
            Claim {
                microvm_uid: "owner-b".into(),
                ..owner.clone()
            },
            Claim {
                epoch: 8,
                ..owner.clone()
            },
        ] {
            assert!(
                supervisor
                    .fence(&saving, &CommandRequest::Sleep { claim })
                    .is_err()
            );
        }
        supervisor
            .fence(&saving, &CommandRequest::Sleep { claim: owner })
            .unwrap();
        assert_eq!(*supervisor.state.borrow(), saving);
    }

    #[test]
    fn stale_lifecycle_requests_do_not_close_the_current_owners_streams() {
        let owner = Claim {
            microvm_id: "agent-a".into(),
            microvm_uid: "owner-a".into(),
            epoch: 7,
        };
        let awake = SlotState::Awake {
            claim: owner.clone(),
        };
        let (state, _) = watch::channel(awake.clone());
        let supervisor = Supervisor {
            state,
            gate: Arc::new(Mutex::new(())),
            database: Arc::new(crate::control::Database::unconnected_fixture()),
            leadership: watch::channel(None).0,
        };
        for wrong in [
            Claim {
                microvm_uid: "owner-b".into(),
                ..owner.clone()
            },
            Claim {
                epoch: 8,
                ..owner.clone()
            },
            Claim {
                microvm_id: "".into(),
                ..owner.clone()
            },
        ] {
            for request in [
                CommandRequest::Sleep {
                    claim: wrong.clone(),
                },
                CommandRequest::Stop {
                    claim: wrong.clone(),
                },
            ] {
                assert!(supervisor.fence(&awake, &request).is_err());
                assert!(supervisor.state.borrow().serves(&owner));
            }
        }
        supervisor
            .fence(
                &awake,
                &CommandRequest::Sleep {
                    claim: owner.clone(),
                },
            )
            .unwrap();
        assert!(!supervisor.state.borrow().serves(&owner));
    }
}
