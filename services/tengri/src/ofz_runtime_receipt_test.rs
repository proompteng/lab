use super::*;
use std::{
    convert::Infallible,
    future::Future,
    pin::Pin,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
};
use tokio::sync::Mutex;

#[derive(Clone, Default)]
struct RuntimeService {
    reads: Arc<Mutex<Vec<GetWorkspaceStateRequest>>>,
    maintenance: Arc<Mutex<Vec<proto::AuthorizeGuestMaintenanceRequest>>>,
    recovery: Arc<AtomicU64>,
    denied: Arc<AtomicBool>,
    concurrent: Arc<Mutex<Option<Arc<tokio::sync::Barrier>>>>,
}

type Reply<T> = Pin<Box<dyn Future<Output = Result<tonic::Response<T>, Status>> + Send>>;

impl tonic::server::UnaryService<GetPolicyStateRequest> for RuntimeService {
    type Response = GetPolicyStateResponse;
    type Future = Reply<Self::Response>;

    fn call(&mut self, _: Request<GetPolicyStateRequest>) -> Self::Future {
        let recovery_generation = self.recovery.load(Ordering::SeqCst);
        Box::pin(async move {
            Ok(tonic::Response::new(GetPolicyStateResponse {
                recovery_generation,
                ..Default::default()
            }))
        })
    }
}

impl tonic::server::UnaryService<GetWorkspaceStateRequest> for RuntimeService {
    type Response = GetWorkspaceStateResponse;
    type Future = Reply<Self::Response>;

    fn call(&mut self, request: Request<GetWorkspaceStateRequest>) -> Self::Future {
        let service = self.clone();
        Box::pin(async move {
            let request = request.into_inner();
            service.reads.lock().await.push(request.clone());
            let concurrent = service.concurrent.lock().await.clone();
            if let Some(concurrent) = concurrent {
                concurrent.wait().await;
            }
            if service.denied.load(Ordering::SeqCst) {
                return Err(Status::permission_denied("controller role revoked"));
            }
            Ok(tonic::Response::new(GetWorkspaceStateResponse {
                workspace_uid: request.workspace_uid,
                owner_id: "a".repeat(64),
                home_uid: "22222222-2222-4222-8222-222222222222".into(),
                reservation_id: "33333333-3333-4333-8333-333333333333".into(),
                home_bytes: 32 << 30,
                runtime_epoch: "44444444-4444-4444-8444-444444444444".into(),
                running: true,
                state: "active".into(),
                runtime_allowed: true,
                recovery_generation: service.recovery.load(Ordering::SeqCst),
                valid_until_unix_ms: now_ms()? + 1500,
                audit_receipt_id: if request.stream_receipt_id.is_empty() {
                    uuid::Uuid::new_v4().to_string()
                } else {
                    request.stream_receipt_id
                },
                policy_version: 1,
            }))
        })
    }
}

impl tonic::server::UnaryService<proto::AuthorizeGuestMaintenanceRequest> for RuntimeService {
    type Response = proto::AuthorizeGuestMaintenanceResponse;
    type Future = Reply<Self::Response>;

    fn call(&mut self, request: Request<proto::AuthorizeGuestMaintenanceRequest>) -> Self::Future {
        let service = self.clone();
        Box::pin(async move {
            let request = request.into_inner();
            service.maintenance.lock().await.push(request.clone());
            if service.denied.load(Ordering::SeqCst) {
                return Err(Status::permission_denied("controller role revoked"));
            }
            Ok(tonic::Response::new(
                proto::AuthorizeGuestMaintenanceResponse {
                    decision: Some(CheckResponse {
                        allowed: true,
                        revision: "runtime-policy".into(),
                        audit_receipt_id: if request.stream_receipt_id.is_empty() {
                            uuid::Uuid::new_v4().to_string()
                        } else {
                            request.stream_receipt_id
                        },
                        valid_until_unix_ms: now_ms()? + 1500,
                        recovery_generation: service.recovery.load(Ordering::SeqCst),
                        effective_scope: None,
                    }),
                },
            ))
        })
    }
}

#[tokio::test]
async fn runtime_receipts_preserve_fresh_checks_concurrency_recovery_and_control_audits() {
    crate::install_rustls_crypto_provider().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let service = RuntimeService::default();
    service.recovery.store(1, Ordering::SeqCst);
    let incoming = service.clone();
    let server = tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let service = incoming.clone();
            tokio::spawn(async move {
                hyper::server::conn::http2::Builder::new(hyper_util::rt::TokioExecutor::new())
                    .serve_connection(TokioIo::new(stream), hyper::service::service_fn(move |request: hyper::Request<hyper::body::Incoming>| {
                        let service = service.clone();
                        async move {
                            let response = match request.uri().path() {
                                "/proompteng.authz.v1.AuthorizationService/GetPolicyState" => tonic::server::Grpc::new(tonic_prost::ProstCodec::<GetPolicyStateResponse, GetPolicyStateRequest>::default()).unary(service, request).await,
                                "/proompteng.authz.v1.AuthorizationService/GetWorkspaceState" => tonic::server::Grpc::new(tonic_prost::ProstCodec::<GetWorkspaceStateResponse, GetWorkspaceStateRequest>::default()).unary(service, request).await,
                                "/proompteng.authz.v1.AuthorizationService/AuthorizeGuestMaintenance" => tonic::server::Grpc::new(tonic_prost::ProstCodec::<proto::AuthorizeGuestMaintenanceResponse, proto::AuthorizeGuestMaintenanceRequest>::default()).unary(service, request).await,
                                path => panic!("unexpected fixture RPC {path}"),
                            };
                            Ok::<_, Infallible>(response)
                        }
                    }))
                    .await.unwrap();
            });
        }
    });
    let channel = Endpoint::from_shared(format!("http://{address}"))
        .unwrap()
        .connect()
        .await
        .unwrap();
    let client = Client::from_channel(channel);
    let uid = "11111111-1111-4111-8111-111111111111";
    let results = futures::future::join_all((0..8).map(|_| client.workspace_state(uid))).await;
    let receipt = results[0].as_ref().unwrap().audit_receipt_id.clone();
    assert!(
        results
            .iter()
            .all(|r| r.as_ref().unwrap().audit_receipt_id == receipt)
    );
    assert_eq!(service.reads.lock().await.len(), 8);
    assert_eq!(
        service
            .reads
            .lock()
            .await
            .iter()
            .filter(|r| r.stream_receipt_id.is_empty())
            .count(),
        1
    );
    *service.concurrent.lock().await = Some(Arc::new(tokio::sync::Barrier::new(8)));
    let results = tokio::time::timeout(
        Duration::from_secs(1),
        futures::future::join_all((0..8).map(|_| client.workspace_state(uid))),
    )
    .await
    .expect("warm runtime checks were serialized");
    assert!(
        results
            .iter()
            .all(|r| r.as_ref().unwrap().audit_receipt_id == receipt)
    );
    *service.concurrent.lock().await = None;
    service.recovery.store(2, Ordering::SeqCst);
    let recovered = client.workspace_state(uid).await.unwrap();
    assert_ne!(recovered.audit_receipt_id, receipt);
    assert_eq!(recovered.recovery_generation, 2);
    assert!(
        service
            .reads
            .lock()
            .await
            .last()
            .unwrap()
            .stream_receipt_id
            .is_empty()
    );
    let epoch = "44444444-4444-4444-8444-444444444444";
    let mut probe_receipt = String::new();
    for _ in 0..8 {
        let probe = client
            .guest_maintenance(uid, epoch, proto::GuestMaintenancePurpose::Probe, "")
            .await
            .unwrap();
        if probe_receipt.is_empty() {
            probe_receipt = probe.audit_receipt_id.clone();
        }
        assert_eq!(probe.audit_receipt_id, probe_receipt);
    }
    assert_eq!(service.maintenance.lock().await.len(), 8);
    assert_eq!(
        service
            .maintenance
            .lock()
            .await
            .iter()
            .filter(|r| r.stream_receipt_id.is_empty())
            .count(),
        1
    );
    let mut cleanup_receipts = Vec::new();
    for _ in 0..2 {
        cleanup_receipts.push(
            client
                .guest_maintenance(
                    uid,
                    epoch,
                    proto::GuestMaintenancePurpose::TerminalCleanup,
                    "terminal-7",
                )
                .await
                .unwrap()
                .audit_receipt_id,
        );
    }
    assert_ne!(cleanup_receipts[0], cleanup_receipts[1]);
    assert!(
        service
            .maintenance
            .lock()
            .await
            .iter()
            .filter(|r| r.purpose == proto::GuestMaintenancePurpose::TerminalCleanup as i32)
            .all(|r| r.stream_receipt_id.is_empty())
    );
    service.denied.store(true, Ordering::SeqCst);
    assert_eq!(
        client.workspace_state(uid).await.unwrap_err().code(),
        tonic::Code::PermissionDenied
    );
    assert_eq!(
        client
            .guest_maintenance(uid, epoch, proto::GuestMaintenancePurpose::Probe, "")
            .await
            .unwrap_err()
            .code(),
        tonic::Code::PermissionDenied
    );
    assert_eq!(service.reads.lock().await.len(), 18);
    assert_eq!(service.maintenance.lock().await.len(), 11);
    server.abort();
}
