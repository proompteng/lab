use platform_client::authz::{PlatformConnectionScope, PlatformResource};
use relay::{
    cli::{Cli, CliOperation},
    connector::{Connector, Failure},
    http::{Http, HttpOperation},
    registered::{Operation, RegisteredOperation},
};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject};
use serde_json::json;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tonic::Code;

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("relay-drivers-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn file(&self, name: &str, value: &str) -> String {
        let path = self.0.join(name);
        std::fs::write(&path, value).unwrap();
        path.to_str().unwrap().to_owned()
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
fn operation_json() -> serde_json::Value {
    json!({
        "name":"read", "description":"Read fixture records", "action":"fixture.status.read",
        "target":{"name":"Fixture account", "kind":"fixture.account", "id":"fixture/account-one"},
        "input_schema":{"type":"object", "properties":{"query":{"type":"string", "maxLength":128}}, "required":["query"], "additionalProperties":false}
    })
}
fn operation() -> Operation {
    serde_json::from_value(operation_json()).unwrap()
}
fn failure<T>(result: Result<T, Failure>) -> Failure {
    match result {
        Err(error) => error,
        Ok(_) => panic!("expected driver failure"),
    }
}
fn python() -> String {
    let result = std::process::Command::new("python3")
        .args(["-c", "import sys; print(sys.executable)"])
        .output()
        .unwrap();
    assert!(result.status.success());
    String::from_utf8(result.stdout).unwrap().trim().to_owned()
}
fn cli(directory: &Directory, script: &str) -> Cli {
    let script = directory.file("fixture.py", script);
    Cli::new(
        "fixture".into(),
        vec![CliOperation {
            operation: operation(),
            process: relay::process::Profile {
                program: python(),
                arguments: vec![script],
                directory: directory.0.to_str().unwrap().into(),
                environment: Default::default(),
                secret_files: Default::default(),
            },
        }],
    )
    .unwrap()
}

fn mcp(directory: &Directory, mode: &str) -> relay::mcp::Mcp {
    let script = directory.file("mcp.py", include_str!("fixtures/mcp.py"));
    let schema = directory.file(
        "schema.json",
        &serde_json::to_string(&operation().input_schema).unwrap(),
    );
    relay::mcp::Mcp::new(
        "fixture".into(),
        relay::mcp::Transport::Stdio {
            process: relay::process::Profile {
                program: python(),
                arguments: vec![
                    script,
                    schema,
                    mode.into(),
                    directory.0.join("calls.jsonl").to_str().unwrap().into(),
                ],
                directory: directory.0.to_str().unwrap().into(),
                environment: Default::default(),
                secret_files: Default::default(),
            },
        },
        vec![relay::mcp::McpOperation {
            operation: operation(),
            tool: "fixture_read".into(),
        }],
    )
    .unwrap()
}

#[tokio::test]
async fn upstream_mcp_stdio_uses_only_registered_metadata_and_preserves_the_exact_arguments() {
    for mode in ["normal", "unannotated"] {
        let directory = Directory::new();
        let adapter = mcp(&directory, mode);
        assert!(adapter.operations(Some(&[])).is_empty());
        let operations = adapter.operations(None);
        assert_eq!(operations.len(), 1);
        assert_eq!(operations[0].description, "Read fixture records");
        let request = adapter
            .normalize("read", br#"{"query":"literal; $(no shell)"}"#)
            .unwrap();
        let result = adapter
            .execute(&request, None)
            .await
            .unwrap_or_else(|f| panic!("{}", f.status));
        let body: serde_json::Value = serde_json::from_slice(&result.bytes).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(body["content"][0]["text"].as_str().unwrap())
                .unwrap(),
            json!({"query":"literal; $(no shell)"})
        );
        assert_eq!(
            std::fs::read_to_string(directory.0.join("calls.jsonl"))
                .unwrap()
                .lines()
                .count(),
            1
        );
    }
}

#[tokio::test]
async fn upstream_mcp_rejects_tool_changes_before_dispatch_and_never_repeats_a_lost_call() {
    for mode in [
        "changed",
        "effectful",
        "destructive",
        "lost",
        "error",
        "oversized",
    ] {
        let directory = Directory::new();
        let adapter = mcp(&directory, mode);
        let result = failure(
            adapter
                .execute(
                    &adapter.normalize("read", br#"{"query":"ok"}"#).unwrap(),
                    None,
                )
                .await,
        );
        assert!(!result.status.message().contains("PRIVATE_PROVIDER_TOKEN"));
        let calls = std::fs::read_to_string(directory.0.join("calls.jsonl")).unwrap_or_default();
        if matches!(mode, "changed" | "effectful" | "destructive") {
            assert_eq!(result.status.code(), Code::FailedPrecondition);
            assert!(calls.is_empty());
        } else {
            assert_eq!(calls.lines().count(), 1, "{mode}");
        }
    }
}

#[tokio::test]
async fn upstream_mcp_cancellation_terminates_the_server_and_its_children() {
    let directory = Directory::new();
    let adapter = mcp(&directory, "hang");
    let task = tokio::spawn(async move {
        adapter
            .execute(
                &adapter.normalize("read", br#"{"query":"ok"}"#).unwrap(),
                None,
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(3), async {
        while !directory.0.join("calls.jsonl").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    task.abort();
    assert!(matches!(task.await,Err(error) if error.is_cancelled()));
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert!(!directory.0.join("calls.escaped").exists());
}

async fn mcp_http_fixture(
    mode: &'static str,
) -> (HttpFixture, Arc<std::sync::atomic::AtomicUsize>) {
    let effects = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let calls = effects.clone();
    let fixture=HttpFixture::serve(move |raw| {
        let response=|status:u16,content_type:&str,body:String,session:bool,known_length:bool| {
            let length=if known_length { format!("Content-Length: {}\r\n",body.len()) } else {String::new()};
            let session=if session {"Mcp-Session-Id: fixture-session\r\n"} else {""};
            format!("HTTP/1.1 {status} Fixture\r\nContent-Type: {content_type}\r\n{length}{session}Connection: close\r\n\r\n{body}")
        };
        if raw.starts_with("GET ") { return response(405,"application/json",String::new(),false,true); }
        if raw.starts_with("DELETE ") { return response(204,"application/json",String::new(),false,true); }
        if mode=="auth-expired" { return response(401,"application/json","{}".into(),false,true); }
        if mode=="provider-denied" { return response(403,"application/json","{}".into(),false,true); }
        let input:serde_json::Value=serde_json::from_str(raw.split_once("\r\n\r\n").unwrap().1).unwrap();
        if input.get("id").is_none() { return response(202,"application/json",String::new(),false,true); }
        let method=input["method"].as_str().unwrap();
        let result=match method {
            "initialize"=>json!({"protocolVersion":input["params"]["protocolVersion"],"capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}}),
            "tools/list"=>{
                let mut schema=operation().input_schema;
                if mode=="changed" { schema["additionalProperties"]=json!(true); }
                json!({"tools":[{"name":"fixture_read","inputSchema":schema,"annotations":{"readOnlyHint":true}}]})
            },
            "tools/call"=>{
                calls.fetch_add(1,std::sync::atomic::Ordering::SeqCst);
                if mode=="lost" { return String::new(); }
                if mode=="expired" { return response(404,"application/json","{}".into(),false,true); }
                json!({"isError":false,"content":[{"type":"text","text":if mode.starts_with("oversized") { "x".repeat(262145) } else {input["params"]["arguments"].to_string()}}]})
            },
            _=>panic!("unexpected MCP method {method}"),
        };
        let message=json!({"jsonrpc":"2.0","id":input["id"],"result":result}).to_string();
        let sse=mode=="sse"||mode=="oversized-sse";
        let body=if sse {format!("event: message\ndata: {message}\n\n")} else {message};
        response(200,if sse {"text/event-stream"} else {"application/json"},body,true,mode!="oversized-stream")
    }).await;
    (fixture, effects)
}

fn mcp_http(fixture: &HttpFixture, token: Option<String>) -> relay::mcp::Mcp {
    relay::mcp::Mcp::new(
        "fixture".into(),
        relay::mcp::Transport::Http {
            endpoint: fixture.endpoint.clone(),
            ca_file: Some(
                fixture
                    .directory
                    .0
                    .join("cert.pem")
                    .to_str()
                    .unwrap()
                    .into(),
            ),
            authentication: token
                .map(|path| relay::credentials::Authentication::BearerFile { path })
                .unwrap_or(relay::credentials::Authentication::None),
        },
        vec![relay::mcp::McpOperation {
            operation: operation(),
            tool: "fixture_read".into(),
        }],
    )
    .unwrap()
}

#[tokio::test]
async fn upstream_mcp_http_handles_json_and_sse_and_rotates_projected_credentials() {
    for mode in ["normal", "sse"] {
        let (fixture, effects) = mcp_http_fixture(mode).await;
        let token = fixture.directory.file("token", "first");
        let adapter = mcp_http(&fixture, Some(token.clone()));
        for value in ["first", "second"] {
            std::fs::write(&token, value).unwrap();
            let output = adapter
                .execute(
                    &adapter
                        .normalize(
                            "read",
                            br#"{"query":"literal&url=https://attacker.invalid/"}"#,
                        )
                        .unwrap(),
                    None,
                )
                .await
                .unwrap_or_else(|f| panic!("{mode}: {}", f.status));
            let body: serde_json::Value = serde_json::from_slice(&output.bytes).unwrap();
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(
                    body["content"][0]["text"].as_str().unwrap()
                )
                .unwrap()["query"],
                "literal&url=https://attacker.invalid/"
            );
        }
        assert_eq!(effects.load(std::sync::atomic::Ordering::SeqCst), 2);
        let requests = fixture.requests.lock().unwrap().clone();
        assert!(
            requests
                .iter()
                .any(|request| request.contains("authorization: Bearer first"))
        );
        assert!(
            requests
                .iter()
                .any(|request| request.contains("authorization: Bearer second"))
        );
    }
}

#[tokio::test]
async fn upstream_mcp_http_bounds_json_and_sse_and_never_replays_expired_or_lost_calls() {
    for mode in [
        "changed",
        "expired",
        "lost",
        "oversized",
        "oversized-stream",
        "oversized-sse",
    ] {
        let (fixture, effects) = mcp_http_fixture(mode).await;
        let adapter = mcp_http(&fixture, None);
        let error = failure(
            adapter
                .execute(
                    &adapter.normalize("read", br#"{"query":"ok"}"#).unwrap(),
                    None,
                )
                .await,
        );
        if mode == "changed" {
            assert_eq!(error.status.code(), Code::FailedPrecondition);
        }
        assert_eq!(
            effects.load(std::sync::atomic::Ordering::SeqCst),
            usize::from(mode != "changed"),
            "{mode}"
        );
    }
}

#[tokio::test]
async fn upstream_mcp_provider_authentication_and_permission_failures_remain_distinct() {
    for (mode, code) in [
        ("auth-expired", Code::FailedPrecondition),
        ("provider-denied", Code::PermissionDenied),
    ] {
        let (fixture, effects) = mcp_http_fixture(mode).await;
        let adapter = mcp_http(&fixture, None);
        let error = failure(
            adapter
                .execute(
                    &adapter.normalize("read", br#"{"query":"ok"}"#).unwrap(),
                    None,
                )
                .await,
        );
        assert_eq!(error.status.code(), code, "{mode}: {}", error.status);
        assert_eq!(effects.load(std::sync::atomic::Ordering::SeqCst), 0);
    }
}

#[test]
fn registration_and_discovery_are_bound_to_declared_policy_and_local_schemas() {
    let definition = operation();
    let registered = RegisteredOperation::new(definition.clone()).unwrap();
    assert!(registered.discovery("fixture", Some(&[])).is_none());
    let mut scope = PlatformConnectionScope {
        actions: vec![definition.action.clone()],
        resource: Some(PlatformResource {
            kind: definition.target.kind.clone(),
            id: "fixture/account-two".into(),
            target: String::new(),
        }),
        ..Default::default()
    };
    assert!(
        registered
            .discovery("fixture", Some(&[scope.clone()]))
            .is_none()
    );
    scope.resource.as_mut().unwrap().id = definition.target.id.clone();
    assert_eq!(
        registered
            .discovery("fixture", Some(&[scope]))
            .unwrap()
            .targets[0]
            .name,
        "Fixture account"
    );
    assert_eq!(
        registered
            .normalize(br#"{"query":"ok","endpoint":"https://attacker.invalid/"}"#)
            .unwrap_err()
            .code(),
        Code::InvalidArgument
    );
    assert_eq!(
        registered.normalize(br#"{"query":42}"#).unwrap_err().code(),
        Code::InvalidArgument
    );
    let mut external = definition;
    external.input_schema = json!({"type":"object","additionalProperties":false,"properties":{"query":{"$ref":"file:///etc/passwd"}}});
    assert!(RegisteredOperation::new(external).is_err());
    for path in [
        "//attacker.invalid/path",
        "https://attacker.invalid/path",
        "/read?token=secret",
        "/read#fragment",
    ] {
        let config = json!({"version":1,"connectors":[{"type":"http","id":"fixture","endpoint":"https://example.test/","operations":[{"operation":operation_json(),"method":"GET","path":path}]}]});
        assert!(relay::config::Config::parse(&serde_json::to_vec(&config).unwrap()).is_err());
    }
}

#[tokio::test]
async fn cli_treats_arguments_as_json_and_clears_ambient_credentials() {
    let directory = Directory::new();
    let adapter = cli(
        &directory,
        "import json,os,sys\nvalue=json.load(sys.stdin)\nprint(json.dumps({'query':value['query'],'environment':dict(os.environ)}))\n",
    );
    let query = "$(touch /tmp/relay-injected); --endpoint=https://attacker.invalid/";
    let request = adapter
        .normalize(
            "read",
            &serde_json::to_vec(&json!({"query":query})).unwrap(),
        )
        .unwrap();
    let result = adapter
        .execute(&request, None)
        .await
        .unwrap_or_else(|f| panic!("{}", f.status));
    let value: serde_json::Value = serde_json::from_slice(&result.bytes).unwrap();
    assert_eq!(value["query"], query);
    let keys: Vec<_> = value["environment"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    // Python and macOS may add locale metadata after exec; ambient service credentials stay absent.
    assert!(
        keys.iter().all(|key| *key == "LC_CTYPE"
            || (cfg!(target_os = "macos") && *key == "__CF_USER_TEXT_ENCODING")),
        "{keys:?}"
    );
    assert_eq!(request.resources[0].id, "fixture/account-one");
}

#[tokio::test]
async fn cli_preserves_process_failures_and_rejects_unbounded_or_invalid_output() {
    for (script, code) in [
        ("import sys\nsys.exit(7)\n", Code::Unavailable),
        ("print('not json')\n", Code::DataLoss),
        ("print('x'*262145)\n", Code::ResourceExhausted),
        (
            "import sys\nsys.stderr.write('x'*262145)\n",
            Code::ResourceExhausted,
        ),
    ] {
        let directory = Directory::new();
        let adapter = cli(&directory, script);
        let request = adapter.normalize("read", br#"{"query":"ok"}"#).unwrap();
        assert_eq!(
            failure(adapter.execute(&request, None).await).status.code(),
            code
        );
    }
}

#[tokio::test]
async fn cli_cancellation_terminates_descendants() {
    let directory = Directory::new();
    let adapter = Arc::new(cli(
        &directory,
        "import os,sys,time\npid=os.fork()\nif pid==0:\n time.sleep(1)\n open('escaped','w').write('escaped')\n time.sleep(5)\nelse:\n open('started','w').write(str(pid))\n time.sleep(30)\n",
    ));
    let request = adapter.normalize("read", br#"{"query":"ok"}"#).unwrap();
    let task = tokio::spawn(async move { adapter.execute(&request, None).await });
    tokio::time::timeout(Duration::from_secs(3), async {
        while !directory.0.join("started").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    task.abort();
    assert!(matches!(task.await, Err(error) if error.is_cancelled()));
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert!(!directory.0.join("escaped").exists());
}

#[tokio::test]
async fn cli_rotates_projected_credentials_without_changing_operation_identity() {
    let directory = Directory::new();
    let token = directory.file("token", "first");
    let script = directory.file("fixture.py", "import json,os,sys\njson.load(sys.stdin)\nprint(json.dumps({'token':os.environ['FIXTURE_TOKEN']}))\n");
    let adapter = Cli::new(
        "fixture".into(),
        vec![CliOperation {
            operation: operation(),
            process: relay::process::Profile {
                program: python(),
                arguments: vec![script],
                directory: directory.0.to_str().unwrap().into(),
                environment: Default::default(),
                secret_files: std::collections::BTreeMap::from([(
                    "FIXTURE_TOKEN".into(),
                    token.clone(),
                )]),
            },
        }],
    )
    .unwrap();
    for value in ["first", "second"] {
        std::fs::write(&token, value).unwrap();
        let result = adapter
            .execute(
                &adapter.normalize("read", br#"{"query":"ok"}"#).unwrap(),
                None,
            )
            .await
            .unwrap_or_else(|f| panic!("{}", f.status));
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&result.bytes).unwrap()["token"],
            value
        );
    }
}

struct HttpFixture {
    directory: Directory,
    endpoint: String,
    requests: Arc<Mutex<Vec<String>>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for HttpFixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl HttpFixture {
    async fn new(status: u16, body: String, headers: &str, known_length: bool) -> Self {
        let length = if known_length {
            format!("Content-Length: {}\r\n", body.len())
        } else {
            String::new()
        };
        let response = format!(
            "HTTP/1.1 {status} Fixture\r\n{length}Content-Type: application/json\r\nConnection: close\r\n{headers}\r\n{body}"
        );
        Self::serve(move |_| response.clone()).await
    }
    async fn serve(respond: impl Fn(&str) -> String + Send + 'static) -> Self {
        let directory = Directory::new();
        let cert = directory.0.join("cert.pem");
        let key = directory.0.join("key.pem");
        let output = std::process::Command::new("openssl")
            .args([
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-days",
                "1",
                "-subj",
                "/CN=localhost",
                "-addext",
                "subjectAltName=DNS:localhost",
                "-addext",
                "basicConstraints=critical,CA:FALSE",
                "-addext",
                "extendedKeyUsage=serverAuth",
                "-keyout",
            ])
            .arg(&key)
            .arg("-out")
            .arg(&cert)
            .output()
            .unwrap();
        assert!(output.status.success());
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![CertificateDer::from_pem_slice(&std::fs::read(&cert).unwrap()).unwrap()],
                PrivateKeyDer::from_pem_slice(&std::fs::read(&key).unwrap()).unwrap(),
            )
            .unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!(
            "https://localhost:{}/",
            listener.local_addr().unwrap().port()
        );
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let task = tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let mut socket = acceptor.accept(socket).await.unwrap();
                let mut request = Vec::new();
                loop {
                    let mut byte = [0];
                    if socket.read(&mut byte).await.unwrap() == 0 {
                        break;
                    }
                    request.push(byte[0]);
                    if request.ends_with(b"\r\n\r\n") {
                        break;
                    }
                }
                let content_length = String::from_utf8_lossy(&request)
                    .lines()
                    .find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or_default();
                assert!(content_length <= 16_384);
                let mut body = vec![0; content_length];
                socket.read_exact(&mut body).await.unwrap();
                request.extend(body);
                let request = String::from_utf8(request).unwrap();
                captured.lock().unwrap().push(request.clone());
                let response = respond(&request);
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.shutdown().await;
            }
        });
        Self {
            directory,
            endpoint,
            requests,
            task,
        }
    }
    fn adapter(&self, token: Option<String>) -> Http {
        Http::new(
            "fixture".into(),
            &self.endpoint,
            Some(self.directory.0.join("cert.pem").to_str().unwrap()),
            token
                .map(|path| relay::credentials::Authentication::BearerFile { path })
                .unwrap_or(relay::credentials::Authentication::None),
            vec![HttpOperation {
                operation: operation(),
                method: relay::http::Method::Get,
                path: "/records".into(),
            }],
        )
        .unwrap()
    }
}

#[tokio::test]
async fn http_encodes_query_values_rotates_credentials_and_never_follows_redirects() {
    let fixture = HttpFixture::new(200, "{\"items\":[]}".into(), "", true).await;
    let token = fixture.directory.file("token", "first");
    let adapter = fixture.adapter(Some(token.clone()));
    for value in ["first", "second"] {
        std::fs::write(&token, value).unwrap();
        let result = adapter
            .execute(
                &adapter
                    .normalize("read", br#"{"query":"a&url=https://attacker.invalid/"}"#)
                    .unwrap(),
                None,
            )
            .await
            .unwrap_or_else(|f| panic!("{}", f.status));
        assert_eq!(result.upstream_status, 200);
    }
    let requests = fixture.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 2);
    assert!(requests[0].starts_with(
        "GET /records?query=a%26url%3Dhttps%3A%2F%2Fattacker.invalid%2F HTTP/1.1\r\n"
    ));
    assert!(requests[0].contains("authorization: Bearer first\r\n"));
    assert!(requests[1].contains("authorization: Bearer second\r\n"));
    let redirect =
        HttpFixture::new(302, "{}".into(), "Location: /another-endpoint\r\n", true).await;
    let adapter = redirect.adapter(None);
    assert_eq!(
        failure(
            adapter
                .execute(
                    &adapter.normalize("read", br#"{"query":"ok"}"#).unwrap(),
                    None
                )
                .await
        )
        .upstream_status,
        302
    );
    assert_eq!(redirect.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn http_preserves_upstream_failures_and_enforces_output_budget() {
    for (status, body, code) in [
        (401, "{}".into(), Code::FailedPrecondition),
        (403, "{}".into(), Code::PermissionDenied),
        (503, "{}".into(), Code::Unavailable),
        (200, "x".repeat(262145), Code::ResourceExhausted),
    ] {
        let fixture = HttpFixture::new(status, body, "", true).await;
        let adapter = fixture.adapter(None);
        let error = failure(
            adapter
                .execute(
                    &adapter.normalize("read", br#"{"query":"ok"}"#).unwrap(),
                    None,
                )
                .await,
        );
        assert_eq!(error.status.code(), code);
        assert_eq!(error.upstream_status, u32::from(status));
        assert_eq!(fixture.requests.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn http_sends_validated_json_to_the_fixed_post_operation_and_bounds_streamed_bodies() {
    let fixture = HttpFixture::new(200, "{}".into(), "", false).await;
    let adapter = Http::new(
        "fixture".into(),
        &fixture.endpoint,
        Some(fixture.directory.0.join("cert.pem").to_str().unwrap()),
        relay::credentials::Authentication::None,
        vec![HttpOperation {
            operation: operation(),
            method: relay::http::Method::Post,
            path: "/search".into(),
        }],
    )
    .unwrap();
    adapter
        .execute(
            &adapter
                .normalize("read", br#"{"query":"url=https://attacker.invalid/"}"#)
                .unwrap(),
            None,
        )
        .await
        .unwrap_or_else(|f| panic!("{}", f.status));
    let request = fixture.requests.lock().unwrap()[0].clone();
    assert!(request.starts_with("POST /search HTTP/1.1\r\n"));
    assert!(request.ends_with("{\"query\":\"url=https://attacker.invalid/\"}"));
    let oversized = HttpFixture::new(200, "x".repeat(262145), "", false).await;
    let adapter = oversized.adapter(None);
    assert_eq!(
        failure(
            adapter
                .execute(
                    &adapter.normalize("read", br#"{"query":"ok"}"#).unwrap(),
                    None
                )
                .await
        )
        .status
        .code(),
        Code::ResourceExhausted
    );
}

#[tokio::test]
async fn cli_deadline_terminates_a_silent_process() {
    let directory = Directory::new();
    let adapter = cli(&directory, "import time\ntime.sleep(30)\n");
    let started = std::time::Instant::now();
    let result = adapter
        .execute(
            &adapter.normalize("read", br#"{"query":"ok"}"#).unwrap(),
            None,
        )
        .await;
    assert_eq!(failure(result).status.code(), Code::DeadlineExceeded);
    assert!(started.elapsed() < Duration::from_secs(15));
}

#[tokio::test]
async fn oauth_connector_startup_requires_its_exact_ofz_profile_and_destination() {
    use platform_client::authz::{GetPlatformConfigurationResponse, RegisteredProviderProfile};
    let profile = RegisteredProviderProfile {
        id: "inventory".into(),
        connector_id: "fixture".into(),
        destination: "https://provider.example/".into(),
    };
    for (profiles, allowed) in [
        (Vec::new(), false),
        (
            vec![RegisteredProviderProfile {
                connector_id: "other".into(),
                ..profile.clone()
            }],
            false,
        ),
        (
            vec![RegisteredProviderProfile {
                destination: "https://other.example/".into(),
                ..profile.clone()
            }],
            false,
        ),
        (vec![profile], true),
    ] {
        let connector = Http::new(
            "fixture".into(),
            "https://provider.example/",
            None,
            relay::credentials::Authentication::Oauth2 {
                profile: "inventory".into(),
            },
            vec![HttpOperation {
                operation: operation(),
                method: relay::http::Method::Get,
                path: "/records".into(),
            }],
        )
        .unwrap();
        let result = relay::service::Service::new(
            GetPlatformConfigurationResponse {
                provider_profiles: profiles,
                ..Default::default()
            },
            vec![Box::new(connector)],
            tonic::transport::Endpoint::from_static("http://localhost:1").connect_lazy(),
        );
        assert_eq!(result.is_ok(), allowed);
    }
}
