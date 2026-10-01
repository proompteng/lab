use super::*;
use axum::{Json, Router, routing::get};
use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

#[tokio::test]
async fn protocol_discovery_selects_legacy_only_when_advertised() {
    for (version, identity, accepted) in [
        (-1, "agent", true),
        (0, "agent", true),
        (1, "agent", true),
        (99, "agent", false),
        (1, "other", false),
    ] {
        let calls = Arc::new(AtomicUsize::new(0));
        let recorded = calls.clone();
        let router = Router::new()
            .route(
                "/v1/evidence",
                get(move || async move {
                    let mut evidence = serde_json::json!({"microvmId":identity});
                    if version >= 0 {
                        evidence["guestProtocolVersion"] = version.into();
                    }
                    Json(evidence)
                }),
            )
            .route(
                "/v1/files",
                get(move || {
                    recorded.fetch_add(1, Ordering::Relaxed);
                    async { Json(serde_json::json!({"path":"/","entries":[]})) }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let mut guest = GuestClient {
            http: reqwest::Client::new(),
            base_url: format!("http://{address}"),
            token: "test".into(),
            rpc: None,
        };
        assert_eq!(guest.select_protocol("agent").await.is_ok(), accepted);
        if accepted {
            assert_eq!(guest.rpc.is_some(), version == 1);
            let result = guest.list_files("/").await;
            assert_eq!(result.is_ok(), version <= 0);
            assert_eq!(
                calls.load(Ordering::Relaxed),
                usize::from(version <= 0),
                "RPC failure must never retry through HTTP"
            );
        }
        server.abort();
    }
    let router = Router::new().route("/v1/evidence", get(|| async { StatusCode::UNAUTHORIZED }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let mut guest = GuestClient {
        http: reqwest::Client::new(),
        base_url: format!("http://{address}"),
        token: "wrong".into(),
        rpc: None,
    };
    assert!(matches!(
        guest.select_protocol("agent").await,
        Err(GuestError::Api {
            status: StatusCode::UNAUTHORIZED,
            ..
        })
    ));
    server.abort();
}

struct Fixture(Child);
impl Drop for Fixture {
    fn drop(&mut self) {
        drop(self.0.stdin.take());
        for _ in 0..150 {
            if matches!(self.0.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn fixture() -> (Fixture, GuestClient) {
    let executable = std::env::var("NANOAGENT_RPC_FIXTURE")
        .expect("set NANOAGENT_RPC_FIXTURE to the Go test binary");
    let mut child = Fixture(
        Command::new(executable)
            .arg("-test.run=^TestRPCInteropServer$")
            .env("NANOAGENT_RPC_INTEROP", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let stdout = child.0.stdout.take().unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Some(address) = line.strip_prefix("NANOAGENT_RPC_ADDR=") {
                let _ = sender.send(address.to_owned());
            }
        }
    });
    let address = receiver
        .recv_timeout(Duration::from_secs(10))
        .expect("Nanoagent fixture did not start");
    let guest = GuestClient {
        http: reqwest::Client::new(),
        base_url: address,
        token: "test-bootstrap-token".into(),
        rpc: None,
    };
    (child, guest)
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
    let (_fixture, mut guest) = fixture();
    guest.select_protocol("interop-agent").await.unwrap();
    let rpc = guest.rpc.clone().unwrap();
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
    assert_eq!(call.event_sequence, Some(1));
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
    let wrong = RpcClient::new(guest.base_url(), "wrong").unwrap();
    assert!(matches!(
        wrong.list_files("/").await,
        Err(GuestError::Api {
            status: StatusCode::UNAUTHORIZED,
            ..
        })
    ));
}
