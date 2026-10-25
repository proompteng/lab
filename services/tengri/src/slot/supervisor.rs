use std::{
    env,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

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
    sync::{Mutex, RwLock, watch},
};

use super::{
    Claim, GUEST_API_PORT, SlotState,
    admission::GuestAdmission,
    runner::{self, CommandRequest, SlotStatus},
    vmm::connect_vsock,
};

pub const CLAIM_UID_HEADER: &str = "x-tengri-microvm-uid";
pub const CLAIM_EPOCH_HEADER: &str = "x-tengri-claim-epoch";
pub const RUNTIME_EPOCH_HEADER: &str = "x-tengri-runtime-epoch";
pub const LEADER_OWNER_HEADER: &str = "x-tengri-leader-owner";
pub const LEADER_GENERATION_HEADER: &str = "x-tengri-leader-generation";
pub(crate) const READINESS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

#[derive(Clone)]
struct Supervisor {
    state: watch::Sender<SlotState>,
    gate: Arc<RwLock<()>>,
    grpc: Arc<Mutex<Option<GuestConnection>>>,
    fences: watch::Sender<()>,
    database: Arc<crate::control::Database>,
    leadership: watch::Sender<Option<crate::control::Fence>>,
    fencing_failed: Arc<AtomicBool>,
    runner_socket: PathBuf,
    admission: GuestAdmission,
}

struct GuestConnection {
    claim: Claim,
    leadership: crate::control::Fence,
    fence: watch::Receiver<()>,
    sender: hyper::client::conn::http2::SendRequest<Body>,
}

impl Supervisor {
    async fn grpc_sender(
        &self,
        claim: &Claim,
        socket: &Path,
        leadership: crate::control::Fence,
    ) -> anyhow::Result<hyper::client::conn::http2::SendRequest<Body>> {
        let mut cached = self.grpc.lock().await;
        if let Some(connection) = cached.as_ref().filter(|connection| {
            connection.claim == *claim
                && connection.leadership == leadership
                && !connection.sender.is_closed()
                && !connection.fence.has_changed().unwrap_or(true)
        }) {
            return Ok(connection.sender.clone());
        }
        let stream = connect_vsock(socket, GUEST_API_PORT).await?;
        // Hyper's HTTP/2 driver owns a background task. Dropping its connection
        // future alone does not close streams held by cloned senders.
        let stream = stream.into_std()?;
        let fence_socket = stream.try_clone()?;
        let stream = tokio::net::UnixStream::from_std(stream)?;
        let (sender, connection) =
            hyper::client::conn::http2::handshake(TokioExecutor::new(), TokioIo::new(stream))
                .await?;
        let mut state = self.state.subscribe();
        let fence = self.fences.subscribe();
        let mut lifetime = fence.clone();
        let expected = claim.clone();
        let authority = self.clone();
        tokio::spawn(async move {
            tokio::pin!(connection);
            tokio::select! {
                _ = &mut connection => {},
                _ = state.wait_for(|state| !state.serves(&expected)) => {},
                _ = lifetime.changed() => {},
                _ = authority.wait_for_leadership_loss(leadership) => {},
            }
            let _ = fence_socket.shutdown(std::net::Shutdown::Both);
        });
        *cached = Some(GuestConnection {
            claim: claim.clone(),
            leadership,
            fence,
            sender: sender.clone(),
        });
        Ok(sender)
    }

    async fn command(&self, request: &CommandRequest) -> anyhow::Result<SlotStatus> {
        runner::command_at(&self.runner_socket, request).await
    }

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
        if self.fencing_failed.load(Ordering::SeqCst) {
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "slot execution fencing is unproven".into(),
            ));
        }
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
        self.fences.send_replace(());
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
    let readiness_database = database.clone();
    let admission = GuestAdmission::new(
        tengri::guest_authorization::GuestVerifier::from_file(&PathBuf::from(env::var(
            "TENGRI_GUEST_VERIFICATION_KEY_FILE",
        )?))?,
        pod_uid,
        tengri::guest_authorization::recovery_generation_from_file(&PathBuf::from(env::var(
            "TENGRI_GUEST_RECOVERY_GENERATION_FILE",
        )?))?,
    )?;
    let readiness_admission = admission.clone();
    let health = Router::new()
        .route(
            "/metrics",
            get(|| async {
                (
                    [(
                        axum::http::header::CONTENT_TYPE,
                        "text/plain; version=0.0.4; charset=utf-8",
                    )],
                    crate::metrics::global().render_latencies(),
                )
            }),
        )
        .route("/livez", get(|| async { StatusCode::OK }))
        .route(
            "/readyz",
            get(move || {
                let database = readiness_database.clone();
                let admission = readiness_admission.clone();
                async move {
                    readiness(
                        &database,
                        &runner::sockets_directory().join("control.sock"),
                        admission.is_ready(),
                    )
                    .await
                    .response()
                }
            }),
        );
    let health_listener = TcpListener::bind("0.0.0.0:8080").await?;
    let health_task = tokio::spawn(async move { axum::serve(health_listener, health).await });
    admission.wait_ready().await;
    let listener = TcpListener::bind("0.0.0.0:8443").await?;
    tokio::select! {
        result = serve(listener, tls, database, admission) => result,
        result = health_task => { result??; anyhow::bail!("supervisor health listener stopped") },
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Readiness {
    Ready,
    Admission,
    Schema,
    Runner,
    Timeout,
}

impl Readiness {
    fn response(self) -> (StatusCode, &'static str) {
        match self {
            Self::Ready => (StatusCode::OK, "ready\n"),
            Self::Admission => (StatusCode::SERVICE_UNAVAILABLE, "admission_unavailable\n"),
            Self::Schema => (StatusCode::SERVICE_UNAVAILABLE, "schema_unavailable\n"),
            Self::Runner => (StatusCode::SERVICE_UNAVAILABLE, "runner_unavailable\n"),
            Self::Timeout => (StatusCode::SERVICE_UNAVAILABLE, "timeout\n"),
        }
    }
}

async fn readiness(
    database: &crate::control::Database,
    runner_socket: &std::path::Path,
    admission_ready: bool,
) -> Readiness {
    let check = async {
        database
            .verify_schema()
            .await
            .map_err(|_| Readiness::Schema)?;
        let status = runner::command_at(runner_socket, &CommandRequest::Status)
            .await
            .map_err(|_| Readiness::Runner)?;
        if !matches!(
            status.state,
            SlotState::Vacant { .. } | SlotState::Awake { .. } | SlotState::Sleeping { .. }
        ) {
            return Err(Readiness::Runner);
        }
        Ok(())
    };
    readiness_check(admission_ready, check).await
}

async fn readiness_check(
    admission_ready: bool,
    check: impl std::future::Future<Output = Result<(), Readiness>>,
) -> Readiness {
    if !admission_ready {
        return Readiness::Admission;
    }
    match tokio::time::timeout(READINESS_TIMEOUT, check).await {
        Ok(Ok(())) => Readiness::Ready,
        Ok(Err(reason)) => reason,
        Err(_) => Readiness::Timeout,
    }
}

pub(super) async fn serve(
    listener: TcpListener,
    tls: Arc<rustls::ServerConfig>,
    database: Arc<crate::control::Database>,
    admission: GuestAdmission,
) -> anyhow::Result<()> {
    let (state, _) = watch::channel(SlotState::Preparing);
    let supervisor = Supervisor {
        state,
        gate: Arc::new(RwLock::new(())),
        grpc: Default::default(),
        fences: watch::channel(()).0,
        database,
        leadership: watch::channel(None).0,
        fencing_failed: Arc::new(AtomicBool::new(false)),
        runner_socket: runner::sockets_directory().join("control.sock"),
        admission,
    };
    let router = Router::new()
        .route("/slot/status", get(status))
        .route("/slot/fence", post(install_fence))
        .route("/slot/restore", post(restore))
        .route("/slot/sleep", post(sleep))
        .route("/slot/stop", post(stop))
        .fallback(forward)
        .with_state(supervisor)
        .layer(axum::middleware::from_fn(
            crate::telemetry::response_trace_id,
        ))
        .layer(
            tower_http::trace::TraceLayer::new_for_http()
                .make_span_with(crate::telemetry::RequestSpan)
                .on_failure(crate::telemetry::http_failure),
        );
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
    let _guard = supervisor.gate.write().await;
    if supervisor.fencing_failed.load(Ordering::SeqCst) {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "slot execution fencing is unproven".into(),
        ));
    }
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
    let _guard = supervisor.gate.write().await;
    let status = supervisor
        .command(&CommandRequest::Status)
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
    let _guard = supervisor.gate.write().await;
    supervisor.require_leadership(Some(leadership)).await?;
    if matches!(
        request,
        CommandRequest::Sleep { .. } | CommandRequest::Stop { .. }
    ) {
        let current = supervisor
            .command(&CommandRequest::Status)
            .await
            .map_err(lifecycle_error)?;
        supervisor.fence(&current.state, request)?;
    }
    let result = runner::command_at_until(
        &supervisor.runner_socket,
        request,
        supervisor.wait_for_leadership_loss(leadership),
    )
    .await;
    let authority = supervisor.require_leadership(Some(leadership)).await;
    if authority.is_err()
        || result
            .as_ref()
            .is_err_and(|error| error.is::<runner::CommandWithdrawn>())
    {
        let error = authority.err().unwrap_or_else(|| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "slot lifecycle authority was withdrawn during dispatch".into(),
            )
        });
        let claim = request
            .claim()
            .context("lifecycle command has no claim")
            .map_err(lifecycle_error)?
            .clone();
        supervisor.fencing_failed.store(true, Ordering::SeqCst);
        supervisor.leadership.send_replace(None);
        supervisor.state.send_replace(SlotState::Failed {
            claim: Some(claim.clone()),
            message: "slot lifecycle authority withdrawn".into(),
        });
        let fenced = tokio::time::timeout(runner::FENCING_TIMEOUT, async {
            loop {
                if let Ok(status) = supervisor
                    .command(&CommandRequest::Fence {
                        claim: claim.clone(),
                    })
                    .await
                    && (status.state.claim() == Some(&claim)
                        && matches!(
                            status.state,
                            SlotState::Failed { .. } | SlotState::Stopped { .. }
                        )
                        || status.state.claim().is_none()
                            && matches!(
                                status.state,
                                SlotState::Vacant { .. } | SlotState::Failed { claim: None, .. }
                            ))
                {
                    return status;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .map_err(|_| {
            lifecycle_error(anyhow::anyhow!(
                "cannot prove slot execution fencing; admission remains quarantined"
            ))
        })?;
        supervisor.state.send_replace(fenced.state);
        supervisor.fencing_failed.store(false, Ordering::SeqCst);
        return Err(error);
    }
    let status = match result {
        Ok(status) => status,
        Err(error) => {
            if let Ok(status) = supervisor.command(&CommandRequest::Status).await {
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
    let _request = supervisor.admission.reserve_request().map_err(|_| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "guest admission request capacity exhausted".into(),
        )
    })?;
    let admission =
        crate::metrics::global().latency_timer(crate::metrics::Latency::SupervisorAdmission);
    #[cfg(test)]
    let started = std::time::Instant::now();
    // The status read and transport admission cannot overlap a sleep fence.
    let guard = supervisor.gate.read().await;
    let leadership = supervisor.require_leadership(None).await?;
    let status = supervisor
        .command(&CommandRequest::Status)
        .await
        .map_err(lifecycle_error)?;
    let claim = status
        .state
        .claim()
        .context("slot is unclaimed")
        .map_err(lifecycle_error)?
        .clone();
    if !status.state.serves(&claim) || !matches_claim(request.headers(), &claim) {
        return Err((
            StatusCode::CONFLICT,
            "slot owner, epoch, or lifecycle changed".into(),
        ));
    }
    supervisor.state.send_replace(status.state);
    let (opening, forwarded) = supervisor
        .admission
        .opening(request)
        .await
        .map_err(|error| {
            if error
                .downcast_ref::<tonic::Status>()
                .is_some_and(|status| status.code() == tonic::Code::ResourceExhausted)
            {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "guest admission buffer capacity exhausted".into(),
                )
            } else {
                (
                    StatusCode::FORBIDDEN,
                    "invalid signed guest RPC opening".into(),
                )
            }
        })?;
    supervisor
        .admission
        .consume(&opening, &claim, leadership, &supervisor.database)
        .await
        .map_err(|error| {
            let status = match error.code() {
                tonic::Code::PermissionDenied | tonic::Code::Unauthenticated => {
                    StatusCode::FORBIDDEN
                }
                _ => StatusCode::SERVICE_UNAVAILABLE,
            };
            (status, "signed guest RPC admission unavailable".into())
        })?;
    supervisor.require_leadership(Some(leadership)).await?;
    request = forwarded;
    request.headers_mut().extend(crate::telemetry::headers());
    drop(opening);
    #[cfg(test)]
    eprintln!(
        "real KVM proxy status: {:.2} ms cumulative",
        started.elapsed().as_secs_f64() * 1000.0
    );
    let socket = runner::sockets_directory().join("guest.vsock");
    #[cfg(test)]
    eprintln!(
        "real KVM proxy vsock: {:.2} ms cumulative",
        started.elapsed().as_secs_f64() * 1000.0
    );
    let mut parts = request.uri().clone().into_parts();
    parts.scheme = Some(axum::http::uri::Scheme::HTTP);
    parts.authority = Some(axum::http::uri::Authority::from_static("nanoagent"));
    *request.uri_mut() =
        axum::http::Uri::from_parts(parts).map_err(|error| lifecycle_error(error.into()))?;
    let grpc = tengri::guest_authorization::rpc_action(request.uri().path()).is_some();
    if grpc {
        let mut sender = supervisor
            .grpc_sender(&claim, &socket, leadership)
            .await
            .map_err(lifecycle_error)?;
        drop(guard);
        drop(admission);
        #[cfg(test)]
        eprintln!(
            "real KVM proxy HTTP/2: {:.2} ms cumulative",
            started.elapsed().as_secs_f64() * 1000.0
        );
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
        let mut state = supervisor.state.subscribe();
        let lifetime = supervisor.fences.subscribe();
        let mut driver_lifetime = lifetime.clone();
        let expected = claim.clone();
        let stream = connect_vsock(&socket, GUEST_API_PORT)
            .await
            .map_err(lifecycle_error)?;
        drop(guard);
        drop(admission);
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
                _ = driver_lifetime.changed() => {},
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
            let mut lifetime = lifetime;
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
                        _ = lifetime.changed() => {},
                        _ = authority.wait_for_leadership_loss(leadership) => {},
                    }
                }
            });
        }
        Ok(response.map(Body::new))
    }
}

fn matches_claim(headers: &HeaderMap, claim: &Claim) -> bool {
    [CLAIM_UID_HEADER, CLAIM_EPOCH_HEADER, RUNTIME_EPOCH_HEADER]
        .iter()
        .all(|name| headers.get_all(*name).iter().count() == 1)
        && headers
            .get(CLAIM_UID_HEADER)
            .and_then(|value| value.to_str().ok())
            == Some(claim.microvm_uid.as_str())
        && headers
            .get(CLAIM_EPOCH_HEADER)
            .and_then(|value| value.to_str().ok())
            == Some(claim.epoch.to_string().as_str())
        && headers
            .get(RUNTIME_EPOCH_HEADER)
            .and_then(|value| value.to_str().ok())
            == Some(claim.runtime_epoch.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readiness_responses_are_bounded_and_preserve_http_status() {
        for (reason, body) in [
            (Readiness::Admission, "admission_unavailable\n"),
            (Readiness::Schema, "schema_unavailable\n"),
            (Readiness::Runner, "runner_unavailable\n"),
            (Readiness::Timeout, "timeout\n"),
        ] {
            assert_eq!(reason.response(), (StatusCode::SERVICE_UNAVAILABLE, body));
        }
        assert_eq!(Readiness::Ready.response(), (StatusCode::OK, "ready\n"));
    }

    #[tokio::test]
    async fn readiness_admission_does_not_poll_dependencies() {
        let reason = readiness_check(false, async {
            panic!("admission must close before checking dependencies")
        })
        .await;
        assert_eq!(reason, Readiness::Admission);
    }

    #[tokio::test]
    async fn readiness_preserves_dependency_failures_and_success() {
        for failure in [Readiness::Schema, Readiness::Runner] {
            assert_eq!(readiness_check(true, async { Err(failure) }).await, failure);
        }
        assert_eq!(
            readiness_check(true, async { Ok(()) }).await,
            Readiness::Ready
        );
    }

    #[tokio::test(start_paused = true)]
    async fn readiness_preserves_two_second_deadline() {
        let started = tokio::time::Instant::now();
        assert_eq!(
            readiness_check(true, std::future::pending()).await,
            Readiness::Timeout
        );
        assert_eq!(started.elapsed(), READINESS_TIMEOUT);
        assert_eq!(READINESS_TIMEOUT, std::time::Duration::from_secs(2));
    }

    #[test]
    fn guest_headers_require_exact_single_current_runtime_binding() {
        let claim = Claim {
            microvm_id: "agent-a".into(),
            microvm_uid: "owner-a".into(),
            epoch: 7,
            runtime_epoch: "44444444-4444-4444-8444-444444444444".into(),
        };
        let mut headers = HeaderMap::new();
        headers.insert(CLAIM_UID_HEADER, claim.microvm_uid.parse().unwrap());
        headers.insert(CLAIM_EPOCH_HEADER, "7".parse().unwrap());
        assert!(!matches_claim(&headers, &claim));
        headers.insert(RUNTIME_EPOCH_HEADER, claim.runtime_epoch.parse().unwrap());
        assert!(matches_claim(&headers, &claim));
        for (name, invalid) in [
            (CLAIM_UID_HEADER, "owner-b"),
            (CLAIM_EPOCH_HEADER, "8"),
            (CLAIM_EPOCH_HEADER, "07"),
            (RUNTIME_EPOCH_HEADER, "55555555-5555-4555-8555-555555555555"),
        ] {
            let mut wrong = headers.clone();
            wrong.insert(name, invalid.parse().unwrap());
            assert!(!matches_claim(&wrong, &claim));
        }
        for name in [CLAIM_UID_HEADER, CLAIM_EPOCH_HEADER, RUNTIME_EPOCH_HEADER] {
            let mut duplicate = headers.clone();
            duplicate.append(name, headers.get(name).unwrap().clone());
            assert!(!matches_claim(&duplicate, &claim));
        }
    }

    #[tokio::test]
    #[ignore = "requires disposable shared TLS PostgreSQL from test-runtime.sh"]
    async fn runtime_shared_state_http2_reuses_vsock_and_closes_pending_requests_at_a_sleep_fence()
    {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let directory = std::path::PathBuf::from(format!(
            "/tmp/tengri-vsock-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir(&directory).unwrap();
        let socket = directory.join("guest.vsock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let connections = Arc::new(AtomicUsize::new(0));
        let accepts = connections.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                accepts.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    let mut handshake = Vec::new();
                    loop {
                        let byte = stream.read_u8().await.unwrap();
                        handshake.push(byte);
                        if byte == b'\n' {
                            break;
                        }
                    }
                    assert_eq!(handshake, b"CONNECT 1024\n");
                    stream.write_all(b"OK 1024\n").await.unwrap();
                    let service = hyper::service::service_fn(
                        |request: Request<hyper::body::Incoming>| async move {
                            if request.uri().path() == "/pending" {
                                futures::future::pending::<()>().await;
                            }
                            Ok::<_, std::convert::Infallible>(Response::new(Body::from("ok")))
                        },
                    );
                    let _ = hyper::server::conn::http2::Builder::new(TokioExecutor::new())
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
        });
        let claim = Claim {
            microvm_id: "agent-a".into(),
            microvm_uid: "owner-a".into(),
            epoch: 7,
            runtime_epoch: "22222222-2222-4222-8222-222222222222".into(),
        };
        let (state, _) = watch::channel(SlotState::Awake {
            claim: claim.clone(),
        });
        let database = Arc::new(crate::control::Database::shared_fixture().await);
        let leadership = database
            .acquire(uuid::Uuid::new_v4())
            .await
            .unwrap()
            .unwrap();
        let supervisor = Supervisor {
            state,
            gate: Default::default(),
            grpc: Default::default(),
            fences: watch::channel(()).0,
            database: database.clone(),
            leadership: watch::channel(Some(leadership)).0,
            fencing_failed: Arc::new(AtomicBool::new(false)),
            runner_socket: runner::sockets_directory().join("control.sock"),
            admission: GuestAdmission::fixture(),
        };
        for _ in 0..4 {
            let mut sender = supervisor
                .grpc_sender(&claim, &socket, leadership)
                .await
                .unwrap();
            assert_eq!(
                sender
                    .send_request(
                        Request::builder()
                            .uri("http://nanoagent/ok")
                            .body(Body::empty())
                            .unwrap()
                    )
                    .await
                    .unwrap()
                    .status(),
                StatusCode::OK
            );
        }
        assert_eq!(connections.load(Ordering::SeqCst), 1);
        let mut sender = supervisor
            .grpc_sender(&claim, &socket, leadership)
            .await
            .unwrap();
        let mut pending = tokio::spawn(async move {
            sender
                .send_request(
                    Request::builder()
                        .uri("http://nanoagent/pending")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
        });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(25), &mut pending)
                .await
                .is_err()
        );
        let current = supervisor.state.borrow().clone();
        supervisor
            .fence(
                &current,
                &CommandRequest::Sleep {
                    claim: claim.clone(),
                },
            )
            .unwrap();
        supervisor.state.send_replace(SlotState::Awake {
            claim: claim.clone(),
        });
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), pending)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        supervisor.state.send_replace(SlotState::Awake {
            claim: claim.clone(),
        });
        let mut sender = supervisor
            .grpc_sender(&claim, &socket, leadership)
            .await
            .unwrap();
        sender
            .send_request(
                Request::builder()
                    .uri("http://nanoagent/ok")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(connections.load(Ordering::SeqCst), 2);
        let next = Claim { epoch: 8, ..claim };
        supervisor.state.send_replace(SlotState::Awake {
            claim: next.clone(),
        });
        let mut sender = supervisor
            .grpc_sender(&next, &socket, leadership)
            .await
            .unwrap();
        sender
            .send_request(
                Request::builder()
                    .uri("http://nanoagent/ok")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(connections.load(Ordering::SeqCst), 3);
        database.release(leadership).await.unwrap();
        server.abort();
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn unproven_execution_fencing_rejects_transport_and_replacement_leadership() {
        let supervisor = Supervisor {
            state: watch::channel(SlotState::Preparing).0,
            gate: Arc::new(RwLock::new(())),
            grpc: Default::default(),
            fences: watch::channel(()).0,
            database: Arc::new(crate::control::Database::unconnected_fixture()),
            leadership: watch::channel(None).0,
            fencing_failed: Arc::new(AtomicBool::new(true)),
            runner_socket: PathBuf::from("/not-contacted"),
            admission: GuestAdmission::fixture(),
        };
        assert!(matches!(
            supervisor.require_leadership(None).await,
            Err((StatusCode::SERVICE_UNAVAILABLE, _))
        ));
        let replacement = crate::control::Fence {
            owner: uuid::Uuid::new_v4(),
            generation: 2,
        };
        assert!(matches!(
            install_fence(State(supervisor.clone()), Json(replacement)).await,
            Err((StatusCode::SERVICE_UNAVAILABLE, _))
        ));
        let request = Request::builder().uri("/").body(Body::empty()).unwrap();
        assert!(matches!(
            forward(State(supervisor), request).await,
            Err((StatusCode::SERVICE_UNAVAILABLE, _))
        ));
    }

    #[tokio::test]
    #[ignore = "requires disposable shared TLS PostgreSQL from test-runtime.sh"]
    async fn runtime_shared_state_leadership_loss_cancels_lifecycle_before_replacement() {
        use tokio::{
            io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
            net::UnixListener,
            sync::Notify,
            time::{Duration, timeout},
        };
        for action in ["restore", "sleep", "stop"] {
            let directory = PathBuf::from("/tmp")
                .join(format!("tengri-command-fence-{}", uuid::Uuid::new_v4()));
            tokio::fs::create_dir(&directory).await.unwrap();
            let socket = directory.join("control.sock");
            let listener = UnixListener::bind(&socket).unwrap();
            let claim = Claim {
                microvm_id: "agent-a".into(),
                microvm_uid: "owner-a".into(),
                epoch: 7,
                runtime_epoch: "44444444-4444-4444-8444-444444444444".into(),
            };
            let awake = SlotState::Awake {
                claim: claim.clone(),
            };
            let current = Arc::new(Mutex::new(awake.clone()));
            let dispatched = Arc::new(Notify::new());
            let cancelled = Arc::new(Notify::new());
            let runner = tokio::spawn({
                let current = current.clone();
                let dispatched = dispatched.clone();
                let cancelled = cancelled.clone();
                async move {
                    loop {
                        let (stream, _) = listener.accept().await.unwrap();
                        let current = current.clone();
                        let dispatched = dispatched.clone();
                        let cancelled = cancelled.clone();
                        tokio::spawn(async move {
                            let (reader, mut writer) = stream.into_split();
                            let mut reader = BufReader::new(reader);
                            let mut line = String::new();
                            reader.read_line(&mut line).await.unwrap();
                            let command: serde_json::Value = serde_json::from_str(&line).unwrap();
                            let error = if command["action"] == action {
                                dispatched.notify_one();
                                let _ = reader.read_u8().await;
                                *current.lock().await = SlotState::Failed {
                                    claim: Some(
                                        serde_json::from_value(command["claim"].clone()).unwrap(),
                                    ),
                                    message: "lifecycle caller disconnected".into(),
                                };
                                cancelled.notify_one();
                                Some("lifecycle caller disconnected".into())
                            } else {
                                None
                            };
                            let response = runner::CommandResponse {
                                status: SlotStatus {
                                    identity: super::super::SlotIdentity {
                                        pod_uid: "pod".into(),
                                        pvc_uid: "home".into(),
                                        image: "image".into(),
                                        kernel_sha256: "kernel".into(),
                                        firecracker_version: super::super::FIRECRACKER_VERSION
                                            .into(),
                                        cpu: "cpu".into(),
                                    },
                                    state: current.lock().await.clone(),
                                },
                                error,
                            };
                            let mut bytes = serde_json::to_vec(&response).unwrap();
                            bytes.push(b'\n');
                            let _ = writer.write_all(&bytes).await;
                        });
                    }
                }
            });
            let database = Arc::new(crate::control::Database::shared_fixture().await);
            let fence = database
                .acquire(uuid::Uuid::new_v4())
                .await
                .unwrap()
                .unwrap();
            let supervisor = Supervisor {
                state: watch::channel(awake).0,
                gate: Arc::new(RwLock::new(())),
                grpc: Default::default(),
                fences: watch::channel(()).0,
                database: database.clone(),
                leadership: watch::channel(Some(fence)).0,
                fencing_failed: Arc::new(AtomicBool::new(false)),
                runner_socket: socket,
                admission: GuestAdmission::fixture(),
            };
            let request = match action {
                "restore" => CommandRequest::Restore {
                    claim: claim.clone(),
                },
                "sleep" => CommandRequest::Sleep {
                    claim: claim.clone(),
                },
                _ => CommandRequest::Stop {
                    claim: claim.clone(),
                },
            };
            let mut transition = tokio::spawn({
                let supervisor = supervisor.clone();
                async move { lifecycle(&supervisor, fence, &request).await }
            });
            timeout(Duration::from_secs(2), dispatched.notified())
                .await
                .unwrap();
            database.release(fence).await.unwrap();
            let replacement = database
                .acquire(uuid::Uuid::new_v4())
                .await
                .unwrap()
                .unwrap();
            let mut installation = tokio::spawn({
                let supervisor = supervisor.clone();
                async move { install_fence(State(supervisor), Json(replacement)).await }
            });
            let stopped = timeout(Duration::from_secs(5), &mut transition).await;
            let installed = timeout(Duration::from_secs(2), &mut installation).await;
            transition.abort();
            installation.abort();
            database.release(replacement).await.unwrap();
            runner.abort();
            let _ = runner.await;
            tokio::fs::remove_dir_all(directory).await.unwrap();
            assert!(
                matches!(stopped, Ok(Ok(Err(_)))),
                "{action} continued after leadership loss"
            );
            assert!(
                matches!(installed, Ok(Ok(Ok(StatusCode::NO_CONTENT)))),
                "replacement remained blocked by {action}"
            );
            assert!(matches!(*current.lock().await, SlotState::Failed { .. }));
            timeout(Duration::from_secs(1), cancelled.notified())
                .await
                .unwrap();
        }
    }

    #[tokio::test]
    #[ignore = "requires disposable shared TLS PostgreSQL from test-runtime.sh"]
    async fn runtime_shared_state_supervisor_keeps_transport_fenced_until_sleep_finishes() {
        use tokio::{
            io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
            net::UnixListener,
            sync::Notify,
        };
        let directory =
            PathBuf::from("/tmp").join(format!("tengri-admission-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&directory).await.unwrap();
        let socket = directory.join("control.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let claim = Claim {
            microvm_id: "agent-a".into(),
            microvm_uid: "owner-a".into(),
            epoch: 7,
            runtime_epoch: "44444444-4444-4444-8444-444444444444".into(),
        };
        let awake = SlotState::Awake {
            claim: claim.clone(),
        };
        let current = Arc::new(Mutex::new(awake.clone()));
        let sleeping = Arc::new(Notify::new());
        let finish = Arc::new(Notify::new());
        let stall_status = Arc::new(AtomicBool::new(true));
        let status_started = Arc::new(Notify::new());
        let finish_status = Arc::new(Notify::new());
        let runner = tokio::spawn({
            let current = current.clone();
            let sleeping = sleeping.clone();
            let finish = finish.clone();
            let stall_status = stall_status.clone();
            let status_started = status_started.clone();
            let finish_status = finish_status.clone();
            async move {
                loop {
                    let (stream, _) = listener.accept().await.unwrap();
                    let current = current.clone();
                    let sleeping = sleeping.clone();
                    let finish = finish.clone();
                    let stall_status = stall_status.clone();
                    let status_started = status_started.clone();
                    let finish_status = finish_status.clone();
                    tokio::spawn(async move {
                        let (reader, mut writer) = stream.into_split();
                        let mut line = String::new();
                        BufReader::new(reader).read_line(&mut line).await.unwrap();
                        let command: CommandRequest = serde_json::from_str(&line).unwrap();
                        if matches!(command, CommandRequest::Status)
                            && stall_status.swap(false, Ordering::SeqCst)
                        {
                            status_started.notify_one();
                            finish_status.notified().await;
                        }
                        if let CommandRequest::Sleep { claim } = command {
                            sleeping.notify_one();
                            finish.notified().await;
                            *current.lock().await = SlotState::Sleeping {
                                claim,
                                snapshot: super::super::Snapshot { generation: 1 },
                            };
                        }
                        let response = runner::CommandResponse {
                            status: SlotStatus {
                                identity: super::super::SlotIdentity {
                                    pod_uid: "pod".into(),
                                    pvc_uid: "home".into(),
                                    image: "image".into(),
                                    kernel_sha256: "kernel".into(),
                                    firecracker_version: super::super::FIRECRACKER_VERSION.into(),
                                    cpu: "cpu".into(),
                                },
                                state: current.lock().await.clone(),
                            },
                            error: None,
                        };
                        let mut bytes = serde_json::to_vec(&response).unwrap();
                        bytes.push(b'\n');
                        writer.write_all(&bytes).await.unwrap();
                    });
                }
            }
        });
        let database = Arc::new(crate::control::Database::shared_fixture().await);
        let fence = database
            .acquire(uuid::Uuid::new_v4())
            .await
            .unwrap()
            .unwrap();
        let supervisor = Supervisor {
            state: watch::channel(awake).0,
            gate: Arc::new(RwLock::new(())),
            grpc: Default::default(),
            fences: watch::channel(()).0,
            database: database.clone(),
            leadership: watch::channel(Some(fence)).0,
            fencing_failed: Arc::new(AtomicBool::new(false)),
            runner_socket: socket,
            admission: GuestAdmission::fixture(),
        };
        let guest_request = || {
            Request::builder()
                .uri("/proompteng.runtime.guest.v1.NanoagentService/GetInfo")
                .header(CLAIM_UID_HEADER, &claim.microvm_uid)
                .header(CLAIM_EPOCH_HEADER, "7")
                .header(RUNTIME_EPOCH_HEADER, &claim.runtime_epoch)
                .body(Body::empty())
                .unwrap()
        };
        let stalled_request = guest_request();
        let stalled = tokio::spawn({
            let supervisor = supervisor.clone();
            async move { forward(State(supervisor), stalled_request).await }
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), status_started.notified())
            .await
            .unwrap();
        let independent = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            forward(State(supervisor.clone()), guest_request()),
        )
        .await;
        finish_status.notify_one();
        assert!(matches!(
            stalled.await.unwrap(),
            Err((StatusCode::FORBIDDEN, _))
        ));
        assert!(
            matches!(independent, Ok(Err((StatusCode::FORBIDDEN, _)))),
            "one guest opening blocked another request's authorization denial"
        );
        let transition = tokio::spawn({
            let supervisor = supervisor.clone();
            let claim = claim.clone();
            async move { lifecycle(&supervisor, fence, &CommandRequest::Sleep { claim }).await }
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), sleeping.notified())
            .await
            .unwrap();
        let request = guest_request();
        let forwarded = forward(State(supervisor.clone()), request);
        tokio::pin!(forwarded);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), &mut forwarded)
                .await
                .is_err(),
            "transport must not pass the runner's still-awake state while sleep is in flight"
        );
        assert!(!supervisor.state.borrow().serves(&claim));
        finish.notify_one();
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), transition)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(matches!(result.0.state, SlotState::Sleeping { .. }));
        let response = tokio::time::timeout(std::time::Duration::from_secs(2), &mut forwarded)
            .await
            .unwrap();
        assert!(matches!(response, Err((StatusCode::CONFLICT, _))));
        database.release(fence).await.unwrap();
        let dsn = std::env::var("TENGRI_DATABASE_DSN")
            .unwrap()
            .replace("user=tengri_controller", "user=tengri_supervisor");
        let readiness_database = crate::control::Database::connect(
            &dsn,
            std::path::Path::new(&std::env::var("TENGRI_DATABASE_PASSWORD_FILE").unwrap()),
            std::path::Path::new(&std::env::var("TENGRI_DATABASE_CA_FILE").unwrap()),
            "tengri_supervisor",
        )
        .await
        .unwrap();
        assert_eq!(
            readiness(&readiness_database, &supervisor.runner_socket, true).await,
            Readiness::Ready
        );
        readiness_database.close_fixture();
        let started = tokio::time::Instant::now();
        assert_eq!(
            readiness(&readiness_database, &supervisor.runner_socket, true).await,
            Readiness::Schema,
            "a healthy sleeping runner cannot make a disconnected supervisor ready"
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(3));
        database.verify_schema().await.unwrap();
        runner.abort();
        let _ = runner.await;
        tokio::fs::remove_dir_all(directory).await.unwrap();
    }

    #[tokio::test]
    async fn guest_requests_wait_for_exclusive_transport_fencing() {
        let (state, _) = watch::channel(SlotState::Awake {
            claim: Claim {
                microvm_id: "agent-a".into(),
                microvm_uid: "owner-a".into(),
                epoch: 7,
                runtime_epoch: "44444444-4444-4444-8444-444444444444".into(),
            },
        });
        let gate = Arc::new(RwLock::new(()));
        let _admission = gate.write().await;
        let request = Request::builder()
            .uri("/proompteng.runtime.guest.v1.NanoagentService/GetInfo")
            .header(CLAIM_UID_HEADER, "owner-a")
            .header(CLAIM_EPOCH_HEADER, "7")
            .header(RUNTIME_EPOCH_HEADER, "44444444-4444-4444-8444-444444444444")
            .body(Body::empty())
            .unwrap();
        let supervisor = Supervisor {
            state,
            gate: gate.clone(),
            grpc: Default::default(),
            fences: watch::channel(()).0,
            database: Arc::new(crate::control::Database::unconnected_fixture()),
            leadership: watch::channel(None).0,
            fencing_failed: Arc::new(AtomicBool::new(false)),
            runner_socket: runner::sockets_directory().join("control.sock"),
            admission: GuestAdmission::fixture(),
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
            runtime_epoch: "44444444-4444-4444-8444-444444444444".into(),
        };
        let saving = SlotState::Saving {
            claim: owner.clone(),
        };
        let (state, _) = watch::channel(saving.clone());
        let supervisor = Supervisor {
            state,
            gate: Arc::new(RwLock::new(())),
            grpc: Default::default(),
            fences: watch::channel(()).0,
            database: Arc::new(crate::control::Database::unconnected_fixture()),
            leadership: watch::channel(None).0,
            fencing_failed: Arc::new(AtomicBool::new(false)),
            runner_socket: runner::sockets_directory().join("control.sock"),
            admission: GuestAdmission::fixture(),
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
            runtime_epoch: "44444444-4444-4444-8444-444444444444".into(),
        };
        let awake = SlotState::Awake {
            claim: owner.clone(),
        };
        let (state, _) = watch::channel(awake.clone());
        let supervisor = Supervisor {
            state,
            gate: Arc::new(RwLock::new(())),
            grpc: Default::default(),
            fences: watch::channel(()).0,
            database: Arc::new(crate::control::Database::unconnected_fixture()),
            leadership: watch::channel(None).0,
            fencing_failed: Arc::new(AtomicBool::new(false)),
            runner_socket: runner::sockets_directory().join("control.sock"),
            admission: GuestAdmission::fixture(),
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
