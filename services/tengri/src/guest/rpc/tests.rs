use super::*;
use axum::Router;
use futures::StreamExt;
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, Command, Stdio},
};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

#[tokio::test]
async fn identity_is_verified_over_authenticated_grpc() {
    use super::test_server::{TestServer, TestService};
    use std::sync::Arc;
    for (id, version, expected) in [
        ("expected", 1, true),
        ("wrong", 1, false),
        ("expected", 0, false),
        ("expected", 2, false),
    ] {
        let fixture = TestServer::start(TestService {
            get_info: Some(Arc::new(move |request| {
                assert_eq!(
                    request.metadata().get("authorization").unwrap(),
                    "Bearer fixture-token"
                );
                assert!(request.metadata().contains_key("grpc-timeout"));
                Ok(proto::GuestInfo {
                    microvm_id: id.into(),
                    protocol_version: version,
                })
            })),
            ..Default::default()
        })
        .await;
        assert_eq!(
            fixture.guest.rpc.verify_identity("expected").await.is_ok(),
            expected
        );
    }
}

#[tokio::test]
async fn grpc_only_guest_rejects_legacy_http_without_discovery_or_fallback() {
    use std::sync::{Arc, Mutex};
    let paths = Arc::new(Mutex::new(Vec::new()));
    let seen = paths.clone();
    let router = Router::new().fallback(move |request: axum::extract::Request| {
        seen.lock().unwrap().push(request.uri().path().to_owned());
        async { StatusCode::NOT_FOUND }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let client = RpcClient::fixture(&address, "fixture-token").unwrap();
    assert!(
        matches!(client.verify_identity("expected").await, Err(GuestError::Api { status: StatusCode::SERVICE_UNAVAILABLE, message }) if message.contains("Sleep and resume"))
    );
    assert!(client.list_files("/").await.is_err());
    server.abort();
    let paths = paths.lock().unwrap();
    assert_eq!(
        paths.as_slice(),
        [
            "/proompteng.runtime.guest.v1.NanoagentService/GetInfo",
            "/proompteng.runtime.guest.v1.NanoagentService/ListFiles",
        ]
    );
}

#[tokio::test]
async fn grpc_read_requires_valid_matching_revision() {
    use super::test_server::{TestServer, TestService};
    use std::sync::Arc;
    for (revision, expected) in [
        ("".to_owned(), "missing"),
        ("bad".to_owned(), "invalid"),
        ("a".repeat(64), "mismatch"),
        (revision_for_content(b"content"), "ok"),
    ] {
        let fixture = TestServer::start(TestService {
            read_file: Some(Arc::new(move |_| {
                Ok(proto::FileContent {
                    content: b"content".to_vec(),
                    content_type: "text/plain".into(),
                    revision: revision.clone(),
                })
            })),
            ..Default::default()
        })
        .await;
        let result = fixture.guest.read_file("/file").await;
        match expected {
            "missing" => assert!(matches!(result, Err(GuestError::MissingFileRevision))),
            "invalid" => assert!(matches!(result, Err(GuestError::InvalidFileRevision))),
            "mismatch" => assert!(matches!(result, Err(GuestError::FileRevisionMismatch))),
            _ => assert_eq!(result.unwrap().content, b"content"),
        }
    }
}

#[tokio::test]
async fn grpc_terminal_creation_reconciles_lost_response() {
    use super::test_server::{TestServer, TestService};
    use std::sync::Arc;
    let fixture = TestServer::start(TestService {
        create_terminal: Some(Arc::new(|_| Err(Status::unavailable("response lost")))),
        list_terminals: Some(Arc::new(|_| {
            Ok(proto::TerminalList {
                sessions: vec![proto::TerminalSession {
                    id: "terminal".into(),
                    creation_id: "creation-identity".into(),
                    ..Default::default()
                }],
            })
        })),
        ..Default::default()
    })
    .await;
    let creation = fixture
        .guest
        .create_terminal("creation-identity", "/", 80, 24)
        .await
        .unwrap();
    assert_eq!(creation.session.id, "terminal");
    assert!(!creation.created);
}

#[tokio::test]
async fn grpc_terminal_creation_validates_the_creation_identity() {
    use super::test_server::{TestServer, TestService};
    use std::sync::Arc;
    for created in [true, false] {
        let fixture = TestServer::start(TestService {
            create_terminal: Some(Arc::new(move |_| {
                Ok(proto::TerminalCreated {
                    created,
                    session: Some(proto::TerminalSession {
                        id: "terminal".into(),
                        creation_id: "wrong-identity".into(),
                        ..Default::default()
                    }),
                })
            })),
            ..Default::default()
        })
        .await;
        let result = fixture
            .guest
            .create_terminal("creation-identity", "/", 80, 24)
            .await;
        assert!(
            matches!(result, Err(GuestError::TerminalCreationIdentityMismatch { created_terminal_id, .. }) if created_terminal_id == created.then(|| "terminal".to_owned()))
        );
    }
}

#[tokio::test]
async fn grpc_write_validates_preconditions_and_receipts() {
    use super::test_server::{TestServer, TestService};
    use std::sync::Arc;
    for revision in [
        "".to_owned(),
        "bad".to_owned(),
        "a".repeat(64),
        revision_for_content(b"content"),
    ] {
        let expected = revision == revision_for_content(b"content");
        let fixture = TestServer::start(TestService {
            write_file: Some(Arc::new(move |request| {
                let value = request.into_inner();
                assert_eq!(value.content, b"content");
                assert_eq!(value.expected_revision, "missing");
                Ok(proto::FileWriteResult {
                    path: value.path,
                    size: 7,
                    revision: revision.clone(),
                })
            })),
            ..Default::default()
        })
        .await;
        assert!(matches!(
            fixture.guest.write_file("/file", b"content", "bad").await,
            Err(GuestError::InvalidFileRevision)
        ));
        assert_eq!(
            fixture
                .guest
                .write_file("/file", b"content", "missing")
                .await
                .is_ok(),
            expected
        );
    }
}

struct Fixture {
    child: Child,
    endpoint: String,
    identity: Option<crate::identity::WorkloadIdentity>,
    preview_port: u16,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        drop(self.child.stdin.take());
        for _ in 0..150 {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

async fn fixture() -> (Fixture, GuestClient) {
    let executable = std::env::var("NANOAGENT_RPC_FIXTURE")
        .expect("set NANOAGENT_RPC_FIXTURE to the Go test binary");
    let mut child = Fixture {
        child: Command::new(executable)
            .arg("-test.run=^TestRPCInteropServer$")
            .env("NANOAGENT_RPC_INTEROP", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
        endpoint: String::new(),
        identity: None,
        preview_port: 0,
    };
    let stdout = child.child.stdout.take().unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Some(address) = line.strip_prefix("NANOAGENT_RPC_ENDPOINT=") {
                let _ = sender.send(address.to_owned());
            }
        }
    });
    let value = receiver
        .recv_timeout(Duration::from_secs(10))
        .expect("Nanoagent fixture did not start");
    let config: serde_json::Value = serde_json::from_str(&value).unwrap();
    let address = config["address"].as_str().unwrap().to_owned();
    child.endpoint = config["workloadEndpoint"].as_str().unwrap().to_owned();
    child.preview_port = config["previewPort"].as_str().unwrap().parse().unwrap();
    let identity = crate::identity::WorkloadIdentity::from_endpoint(
        config["workloadEndpoint"].as_str().unwrap().to_owned(),
        "galactic.proompteng.ai".parse().unwrap(),
        "tengri",
    )
    .await
    .unwrap();
    let tls = identity
        .guest_tls(identity.guest_id("tengri", "interop-agent").unwrap())
        .unwrap();
    let channel = identity
        .guest_channel(
            address.strip_prefix("https://").unwrap().parse().unwrap(),
            tls.clone(),
        )
        .unwrap();
    let mut preview = tls.unwrap().as_ref().clone();
    preview.alpn_protocols = vec![b"http/1.1".to_vec()];
    let http = reqwest::Client::builder()
        .use_preconfigured_tls(preview.clone())
        .http1_only()
        .build()
        .unwrap();
    let guest = GuestClient {
        rpc: RpcClient::new(channel, "test-bootstrap-token").unwrap(),
        base_url: address,
        token: "test-bootstrap-token".into(),
        http,
        preview_tls: Some(std::sync::Arc::new(preview)),
    };
    child.identity = Some(identity);
    (child, guest)
}

#[tokio::test]
#[ignore = "requires Go SPIFFE Workload API fixture; run test-rpc-interop.sh"]
async fn rust_server_requires_the_bff_identity_and_renews_its_svid() {
    use super::test_server::TestService;
    use crate::identity::{WorkloadIdentity, tls_incoming};
    use spiffe::{SpiffeId, X509Source, X509Svid, x509_source::SvidPicker};
    use std::sync::Arc;

    struct Pick(SpiffeId);
    impl SvidPicker for Pick {
        fn pick_svid(&self, svids: &[Arc<X509Svid>]) -> Option<usize> {
            svids.iter().position(|svid| svid.spiffe_id() == &self.0)
        }
    }
    let (mut fixture, _) = fixture().await;
    let identity = fixture.identity.as_ref().unwrap();
    let tls = identity.server_tls().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(
        tonic::transport::Server::builder()
            .add_service(
                proto::nanoagent_service_server::NanoagentServiceServer::new(TestService {
                    get_info: Some(Arc::new(|_| {
                        Ok(proto::GuestInfo {
                            microvm_id: "tls-fixture".into(),
                            protocol_version: 1,
                        })
                    })),
                    ..Default::default()
                }),
            )
            .serve_with_incoming(tls_incoming(listener, tls)),
    );
    let peer: SpiffeId = "spiffe://galactic.proompteng.ai/ns/tengri/sa/tengri"
        .parse()
        .unwrap();
    let bff_source = X509Source::builder()
        .endpoint(&fixture.endpoint)
        .picker(Pick(
            "spiffe://galactic.proompteng.ai/ns/proompteng/sa/proompteng"
                .parse()
                .unwrap(),
        ))
        .build()
        .await
        .unwrap();
    let bff = WorkloadIdentity::Spiffe {
        source: bff_source.clone(),
        domain: "galactic.proompteng.ai".parse().unwrap(),
    };
    let connect = |source: &WorkloadIdentity| {
        RpcClient::new(
            source
                .guest_channel(address, source.guest_tls(peer.clone()).unwrap())
                .unwrap(),
            "fixture-token",
        )
        .unwrap()
    };
    connect(&bff).verify_identity("tls-fixture").await.unwrap();
    assert!(
        connect(identity)
            .verify_identity("tls-fixture")
            .await
            .is_err(),
        "Tengri identity was accepted as the BFF"
    );
    assert!(
        RpcClient::fixture(&format!("http://{address}"), "fixture-token")
            .unwrap()
            .verify_identity("tls-fixture")
            .await
            .is_err(),
        "plaintext was accepted by the control-plane listener"
    );
    let WorkloadIdentity::Spiffe { source, .. } = identity else {
        panic!("missing SPIFFE source")
    };
    let before = source.svid().unwrap();
    let mut updates = source.updated();
    let mut bff_updates = bff_source.updated();
    writeln!(fixture.child.stdin.as_mut().unwrap(), "rotate").unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        updates.changed().await.unwrap();
        bff_updates.changed().await.unwrap();
    })
    .await
    .unwrap();
    assert_ne!(before.cert_chain(), source.svid().unwrap().cert_chain());
    connect(&bff).verify_identity("tls-fixture").await.unwrap();
    server.abort();
    bff_source.shutdown().await;
}

async fn attach(
    rpc: &RpcClient,
    id: &str,
    token: &str,
    since: u32,
) -> (
    mpsc::Sender<proto::TerminalInput>,
    tonic::Streaming<proto::TerminalOutput>,
) {
    let (sender, receiver) = mpsc::channel(16);
    sender
        .send(proto::TerminalInput {
            action: Some(proto::terminal_input::Action::Attach(
                proto::TerminalAttach {
                    id: id.into(),
                    reconnect_token: token.into(),
                    since,
                    columns: 80,
                    rows: 24,
                },
            )),
        })
        .await
        .unwrap();
    let stream = rpc
        .attach_terminal(ReceiverStream::new(receiver))
        .await
        .unwrap();
    (sender, stream)
}

async fn terminal_message(
    stream: &mut tonic::Streaming<proto::TerminalOutput>,
) -> proto::terminal_output::Event {
    tokio::time::timeout(Duration::from_secs(10), stream.message())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .event
        .unwrap()
}

#[tokio::test]
#[ignore = "requires Go Nanoagent fixture; run test-rpc-interop.sh"]
async fn rust_client_uses_real_go_guest_for_files_codex_and_terminal_streams() {
    use futures::SinkExt;
    use tokio_tungstenite::{
        Connector, connect_async_tls_with_config,
        tungstenite::{Message, client::IntoClientRequest},
    };
    let (fixture, guest) = fixture().await;
    guest.rpc.verify_identity("interop-agent").await.unwrap();
    let target = format!("{}/v1/preview/{}/", guest.base_url, fixture.preview_port);
    let response = guest
        .http
        .get(&target)
        .bearer_auth(&guest.token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.text().await.unwrap(), "preview-over-mtls");
    let mut request = format!("{}ws", target.replace("https://", "wss://"))
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {}", guest.token).parse().unwrap(),
    );
    let (mut websocket, _) = connect_async_tls_with_config(
        request,
        None,
        false,
        guest.preview_tls.clone().map(Connector::Rustls),
    )
    .await
    .unwrap();
    websocket.send(Message::Text("ping".into())).await.unwrap();
    let response = tokio::time::timeout(Duration::from_secs(5), websocket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(response.into_text().unwrap(), "guest:ping");
    websocket.close(None).await.unwrap();
    let rpc = guest.rpc.clone();
    let directory = guest.create_directory("/files").await.unwrap();
    assert!(directory.directory);
    let mut events = guest.watch_files("/files", None).await.unwrap();
    let snapshot = tokio::time::timeout(Duration::from_secs(5), events.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.kind, "reset");
    assert_eq!(snapshot.path, "/files");
    let content: Vec<u8> = (0..MAX_GUEST_FILE_BYTES).map(|i| i as u8).collect();
    let write = guest
        .write_file("/files/binary.dat", &content, "missing")
        .await
        .unwrap();
    assert_eq!(write.size, content.len() as i64);
    assert_eq!(
        guest.read_file("/files/binary.dat").await.unwrap().content,
        content
    );
    let conflict = guest
        .write_file("/files/binary.dat", b"stale", "missing")
        .await
        .unwrap_err();
    match conflict {
        GuestError::Api { status, message } => {
            assert_eq!(status, StatusCode::CONFLICT);
            assert_eq!(
                serde_json::from_str::<Value>(&message).unwrap()["currentRevision"],
                write.revision
            );
        }
        error => panic!("unexpected conflict: {error}"),
    }
    let event = tokio::time::timeout(Duration::from_secs(5), events.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(event.sequence > 0);
    assert_eq!(event.path, "/files/binary.dat");
    drop(events);
    let search = guest.search_files("binary", "/files", 10).await.unwrap();
    assert_eq!(search.entries[0].path, "/files/binary.dat");
    assert_eq!(guest.list_files("/files").await.unwrap().entries.len(), 1);
    guest
        .move_file("/files/binary.dat", "/files/moved.dat")
        .await
        .unwrap();
    guest.delete_file("/files/moved.dat", false).await.unwrap();
    assert!(matches!(
        guest.read_file("/.tengri/private").await,
        Err(GuestError::Api {
            status: StatusCode::NOT_FOUND,
            ..
        })
    ));

    let call = rpc
        .codex_call("account/read", serde_json::json!({}))
        .await
        .unwrap();
    assert_eq!(call.event_sequence, 1);
    assert_eq!(call.result["integer"].as_u64(), Some(9_007_199_254_740_993));
    assert!(guest.codex_login().await.unwrap().active);
    let mut codex = guest.watch_codex_events(0).await.unwrap();
    let event = tokio::time::timeout(Duration::from_secs(5), codex.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(event.sequence, 1);
    assert_eq!(
        event.raw["params"]["integer"].as_u64(),
        Some(9_007_199_254_740_993)
    );
    drop(codex);
    assert!(matches!(
        guest.resolve_codex_approval("missing", "accept").await,
        Err(GuestError::Api {
            status: StatusCode::NOT_FOUND,
            ..
        })
    ));
    assert!(matches!(
        rpc.codex_call("unsupported/method", serde_json::json!({}))
            .await,
        Err(GuestError::Api {
            status: StatusCode::BAD_REQUEST,
            ..
        })
    ));

    let created = guest
        .create_terminal("interop-terminal-creation", "/", 80, 24)
        .await
        .unwrap();
    assert!(created.created);
    let repeated = guest
        .create_terminal("interop-terminal-creation", "/", 80, 24)
        .await
        .unwrap();
    assert!(!repeated.created);
    assert_eq!(created.session.id, repeated.session.id);
    let (sender, mut stream) = attach(&rpc, &created.session.id, "", 0).await;
    let ready = match terminal_message(&mut stream).await {
        proto::terminal_output::Event::Ready(ready) => ready,
        other => panic!("expected ready, got {other:?}"),
    };
    sender
        .send(proto::TerminalInput {
            action: Some(proto::terminal_input::Action::Input(
                b"printf 'rpc-%s\\n' 'interop-marker'\n".to_vec(),
            )),
        })
        .await
        .unwrap();
    let mut output = Vec::new();
    loop {
        if let proto::terminal_output::Event::Output(data) = terminal_message(&mut stream).await {
            output.extend(data.data);
            if String::from_utf8_lossy(&output).contains("rpc-interop-marker") {
                break;
            }
        }
    }
    let (reconnected, mut replay) = attach(&rpc, &created.session.id, &ready.token, 0).await;
    assert!(matches!(
        terminal_message(&mut replay).await,
        proto::terminal_output::Event::Ready(_)
    ));
    let mut output = Vec::new();
    loop {
        if let proto::terminal_output::Event::Output(data) = terminal_message(&mut replay).await {
            output.extend(data.data);
            if String::from_utf8_lossy(&output).contains("rpc-interop-marker") {
                break;
            }
        }
    }
    drop(stream);
    drop(sender);
    reconnected
        .send(proto::TerminalInput {
            action: Some(proto::terminal_input::Action::Resize(
                proto::TerminalResize {
                    columns: 100,
                    rows: 30,
                },
            )),
        })
        .await
        .unwrap();
    reconnected
        .send(proto::TerminalInput {
            action: Some(proto::terminal_input::Action::Ping(proto::Empty {})),
        })
        .await
        .unwrap();
    loop {
        if matches!(
            terminal_message(&mut replay).await,
            proto::terminal_output::Event::Pong(_)
        ) {
            break;
        }
    }
    assert!(guest.list_terminals().await.unwrap()[0].attached);
    drop(replay);
    drop(reconnected);
    guest.terminate_terminal(&created.session.id).await.unwrap();
    assert!(guest.list_terminals().await.unwrap().is_empty());
    let mut wrong = guest.rpc.clone();
    wrong.authorization = MetadataValue::try_from("Bearer wrong").unwrap();
    assert!(matches!(
        wrong.list_files("/").await,
        Err(GuestError::Api {
            status: StatusCode::UNAUTHORIZED,
            ..
        })
    ));
}
