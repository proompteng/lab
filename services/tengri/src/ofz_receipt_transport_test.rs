use super::*;
use std::{
    convert::Infallible,
    future::Future,
    pin::Pin,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
};
use tokio::sync::Mutex;

#[derive(Clone)]
struct CheckService {
    calls: Arc<Mutex<Vec<CheckRequest>>>,
    allowed: Arc<AtomicBool>,
    concurrent: Arc<Mutex<Option<Arc<tokio::sync::Barrier>>>>,
    delay_ms: Arc<AtomicU64>,
    database_clock_offset_ms: Arc<AtomicU64>,
}

impl tonic::server::UnaryService<CheckRequest> for CheckService {
    type Response = CheckResponse;
    type Future =
        Pin<Box<dyn Future<Output = Result<tonic::Response<CheckResponse>, Status>> + Send>>;

    fn call(&mut self, request: Request<CheckRequest>) -> Self::Future {
        let service = self.clone();
        Box::pin(async move {
            let request = request.into_inner();
            let database_now = now_ms()? - service.database_clock_offset_ms.load(Ordering::SeqCst);
            if request.context.as_ref().unwrap().deadline_unix_ms > database_now + 30_000 {
                return Err(Status::deadline_exceeded("invalid authorization deadline"));
            }
            let receipt = if request.stream_receipt_id.is_empty() {
                uuid::Uuid::new_v4().to_string()
            } else {
                request.stream_receipt_id.clone()
            };
            service.calls.lock().await.push(request);
            tokio::time::sleep(Duration::from_millis(
                service.delay_ms.load(Ordering::SeqCst),
            ))
            .await;
            let concurrent = service.concurrent.lock().await.clone();
            if let Some(concurrent) = concurrent {
                concurrent.wait().await;
            }
            Ok(tonic::Response::new(CheckResponse {
                allowed: service.allowed.load(Ordering::SeqCst),
                revision: "fresh-policy".into(),
                audit_receipt_id: receipt,
                valid_until_unix_ms: now_ms()? + 1500,
                recovery_generation: 1,
                effective_scope: None,
            }))
        })
    }
}

#[tokio::test]
async fn repeated_reads_still_call_ofz_and_control_submissions_keep_distinct_audits() {
    crate::install_rustls_crypto_provider().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let service = CheckService {
        calls: Arc::new(Mutex::new(Vec::new())),
        allowed: Arc::new(AtomicBool::new(true)),
        concurrent: Arc::new(Mutex::new(None)),
        delay_ms: Arc::new(AtomicU64::new(0)),
        database_clock_offset_ms: Arc::new(AtomicU64::new(0)),
    };
    let incoming = service.clone();
    let server = tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let service = incoming.clone();
            tokio::spawn(async move {
                hyper::server::conn::http2::Builder::new(hyper_util::rt::TokioExecutor::new())
                    .serve_connection(
                        TokioIo::new(stream),
                        hyper::service::service_fn(move |request| {
                            let service = service.clone();
                            async move {
                                let mut grpc =
                                    tonic::server::Grpc::new(tonic_prost::ProstCodec::default());
                                Ok::<_, Infallible>(grpc.unary(service, request).await)
                            }
                        }),
                    )
                    .await
                    .unwrap();
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
    let context =
        crate::auth::Principal::fixture(&"a".repeat(64), uid, Action::FilesObserve).context;
    let resource = Resource {
        kind: proto::ResourceKind::Workspace as i32,
        id: uid.into(),
    };
    let results = futures::future::join_all((0..8).map(|_| {
        client.check(
            context.clone(),
            Action::FilesObserve,
            resource.clone(),
            "/workspace/file".into(),
            String::new(),
            1,
        )
    }))
    .await;
    let first = results[0].as_ref().unwrap().audit_receipt_id.clone();
    assert!(
        results
            .iter()
            .all(|r| r.as_ref().unwrap().audit_receipt_id == first)
    );
    {
        let calls = service.calls.lock().await;
        assert_eq!(
            calls.len(),
            8,
            "a receipt must never replace a fresh policy RPC"
        );
        assert_eq!(
            calls
                .iter()
                .filter(|r| r.stream_receipt_id.is_empty())
                .count(),
            1,
            "concurrent reads must establish only one durable receipt"
        );
    }
    *service.concurrent.lock().await = Some(Arc::new(tokio::sync::Barrier::new(8)));
    let parallel = futures::future::join_all((0..8).map(|_| {
        client.check(
            context.clone(),
            Action::FilesObserve,
            resource.clone(),
            "/workspace/file".into(),
            String::new(),
            1,
        )
    }));
    let parallel = tokio::time::timeout(Duration::from_secs(3), parallel)
        .await
        .expect("warm receipt checks serialized behind an Ofz request");
    assert!(
        parallel
            .iter()
            .all(|r| r.as_ref().is_ok_and(|r| r.audit_receipt_id == first))
    );
    *service.concurrent.lock().await = None;
    service.allowed.store(false, Ordering::SeqCst);
    assert_eq!(
        client
            .check(
                context.clone(),
                Action::FilesObserve,
                resource.clone(),
                "/workspace/file".into(),
                String::new(),
                1
            )
            .await
            .unwrap_err()
            .code(),
        tonic::Code::PermissionDenied
    );
    assert_eq!(
        service.calls.lock().await.len(),
        17,
        "revocation must reach Ofz even with a cached receipt"
    );
    service.allowed.store(true, Ordering::SeqCst);
    let other = client
        .check(
            context.clone(),
            Action::FilesObserve,
            resource.clone(),
            "/workspace/other".into(),
            String::new(),
            1,
        )
        .await
        .unwrap();
    assert_ne!(other.audit_receipt_id, first);
    let controls = futures::future::join_all((0..4).map(|_| {
        client.check(
            context.clone(),
            Action::FilesWrite,
            resource.clone(),
            "/workspace/file".into(),
            String::new(),
            1,
        )
    }))
    .await;
    let ids: std::collections::HashSet<_> = controls
        .into_iter()
        .map(|r| r.unwrap().audit_receipt_id)
        .collect();
    assert_eq!(ids.len(), 4);
    assert!(
        service
            .calls
            .lock()
            .await
            .iter()
            .filter(|r| r.action == Action::FilesWrite as i32)
            .all(|r| r.stream_receipt_id.is_empty())
    );
    let mut short = context.clone();
    short.deadline_unix_ms = now_ms().unwrap() + 50;
    let waiting = CheckRequest {
        context: Some(short.clone()),
        action: Action::FilesObserve as i32,
        resource: Some(resource.clone()),
        target: "/workspace/cold".into(),
        stream_receipt_id: String::new(),
    };
    let slot = client.receipts.slot(&waiting, 1).await.unwrap();
    let guard = slot.lock().await;
    let calls = service.calls.lock().await.len();
    let expired = tokio::time::timeout(
        Duration::from_millis(500),
        client.check(
            short,
            Action::FilesObserve,
            resource,
            "/workspace/cold".into(),
            String::new(),
            1,
        ),
    )
    .await
    .expect("cold receipt wait exceeded the signed deadline");
    assert_eq!(expired.unwrap_err().code(), tonic::Code::DeadlineExceeded);
    assert_eq!(
        service.calls.lock().await.len(),
        calls,
        "an expired queued request must never reach Ofz"
    );
    drop(guard);

    service
        .database_clock_offset_ms
        .store(1000, Ordering::SeqCst);

    // The BFF assertion is checked on controller admission; a durable Ofz audit is
    // followed by a fresh policy decision, rather than extending that assertion.
    let mut expired_principal =
        crate::auth::Principal::fixture(&"a".repeat(64), uid, Action::FilesObserve);
    expired_principal.context.deadline_unix_ms = now_ms().unwrap() - 1;
    let expired = crate::authz::WorkspaceAuthorization::new(client.clone())
        .access(
            &expired_principal,
            uid,
            &expired_principal.context.runtime_epoch,
            "/workspace/expired-audit",
        )
        .unwrap();
    let calls = service.calls.lock().await.len();
    assert_eq!(
        expired.require().await.unwrap_err().code(),
        tonic::Code::DeadlineExceeded
    );
    assert_eq!(
        service.calls.lock().await.len(),
        calls,
        "an expired initial submission must not start a durable audit"
    );
    let submission = crate::auth::Principal::fixture(&"a".repeat(64), uid, Action::FilesObserve);
    let auth = crate::auth::Authenticator::fixture("https://proompteng.ai".into());
    let path = "/proompteng.runtime.v1.MicroVMControlPlane/ListFiles";
    let request = crate::auth::signed_fixture_request(
        crate::grpc::proto::ListFilesRequest {
            agent_id: "agent-test".into(),
            path: "/workspace/slow-audit".into(),
        },
        &submission,
        path,
        auth.audience(),
    );
    let principal = auth.authorize(&request, path).await.unwrap();
    let captured: crate::auth::Principal =
        serde_json::from_value(serde_json::to_value(&principal).unwrap()).unwrap();
    tokio::time::sleep(Duration::from_millis(5100)).await;
    assert!(submission.context.deadline_unix_ms < now_ms().unwrap());
    assert_eq!(
        auth.authorize(&request, path).await.unwrap_err().code(),
        tonic::Code::Unauthenticated,
        "the original assertion cannot be admitted again after it expires"
    );
    let captured_access = crate::authz::WorkspaceAuthorization::new(client.clone())
        .access(
            &captured,
            uid,
            &captured.context.runtime_epoch,
            "/workspace/captured-audit",
        )
        .unwrap();
    assert_eq!(
        captured_access.require().await.unwrap_err().code(),
        tonic::Code::DeadlineExceeded,
        "serialized capabilities must not inherit verified RPC admission"
    );
    let access = crate::authz::WorkspaceAuthorization::new(client)
        .access(
            &principal,
            uid,
            &principal.context.runtime_epoch,
            "/workspace/slow-audit",
        )
        .unwrap();
    service.delay_ms.store(6100, Ordering::SeqCst);
    access
        .require()
        .await
        .expect("durable audit must outlive a five-second commit stall");
    let last = service.calls.lock().await.last().cloned().unwrap();
    assert!(last.context.unwrap().deadline_unix_ms > now_ms().unwrap());

    service.delay_ms.store(0, Ordering::SeqCst);
    service.allowed.store(false, Ordering::SeqCst);
    assert_eq!(
        access.require().await.unwrap_err().code(),
        tonic::Code::PermissionDenied,
        "a committed receipt must still check current revocation"
    );

    service.allowed.store(true, Ordering::SeqCst);
    service.delay_ms.store(2100, Ordering::SeqCst);
    let started = tokio::time::Instant::now();
    assert!(
        access.require().await.is_err(),
        "receipt revalidation must retain its two-second deadline"
    );
    assert!(started.elapsed() < Duration::from_millis(2100));
    server.abort();
}
