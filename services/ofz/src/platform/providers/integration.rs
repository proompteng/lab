use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tonic::Code;
use uuid::Uuid;

use super::*;

const ADMIN: &str = "spiffe://proompteng.ai/ns/proompteng/sa/platform-admin";
const RELAY: &str = "spiffe://proompteng.ai/ns/relay/sa/relay";
const OPENCODE: &str = "spiffe://proompteng.ai/ns/opencode/sa/opencode";

#[derive(Default)]
struct ProviderState {
    codes: BTreeMap<String, String>,
    access: BTreeMap<String, String>,
    refresh: BTreeSet<String>,
    exchanges: usize,
    refreshes: usize,
    revocations: usize,
    sequence: usize,
    lose_refresh: bool,
    scope: Option<String>,
    http_calls: usize,
    mcp_calls: usize,
}

pub(crate) struct Runtime {
    pub delegation_id: String,
    pub credential: String,
    pub binding: platform_client::authz::PlatformBinding,
}

fn operation() -> relay::registered::Operation {
    relay::registered::Operation {
        name: "read".into(),
        description: "Read the approved fixture resource".into(),
        action: "kubernetes.status.read".into(),
        target: relay::registered::Target {
            name: "Fixture".into(),
            kind: "kubernetes.namespace".into(),
            id: "galactic/11111111-1111-4111-8111-111111111111".into(),
        },
        input_schema: serde_json::json!({"type":"object","additionalProperties":false,"properties":{"query":{"type":"string"}},"required":["query"]}),
    }
}

async fn provider(
    directory: &std::path::Path,
) -> (
    String,
    Arc<Mutex<ProviderState>>,
    tokio::task::JoinHandle<()>,
) {
    let cert = std::fs::read(directory.join("server.crt")).unwrap();
    let key = std::fs::read(directory.join("server.key")).unwrap();
    let certificates = rustls_pemfile::certs(&mut cert.as_slice())
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let key = rustls_pemfile::private_key(&mut key.as_slice())
        .unwrap()
        .unwrap();
    let tls = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certificates, key)
        .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(tls));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!(
        "https://localhost:{}",
        listener.local_addr().unwrap().port()
    );
    let state = Arc::new(Mutex::new(ProviderState::default()));
    let shared = state.clone();
    let allowed_resource = endpoint.clone();
    let task = tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let acceptor = acceptor.clone();
            let state = shared.clone();
            let endpoint = allowed_resource.clone();
            tokio::spawn(async move {
                let mut stream = acceptor.accept(stream).await.unwrap();
                let mut bytes = Vec::new();
                let (header, body) = loop {
                    let mut buffer = [0u8; 4096];
                    let length = stream.read(&mut buffer).await.unwrap();
                    if length == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&buffer[..length]);
                    assert!(bytes.len() <= 32_768);
                    let Some(split) = bytes.windows(4).position(|bytes| bytes == b"\r\n\r\n")
                    else {
                        continue;
                    };
                    let header = String::from_utf8(bytes[..split].to_vec()).unwrap();
                    let length: usize = header
                        .lines()
                        .filter_map(|line| line.split_once(':'))
                        .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                        .map(|(_, value)| value.trim().parse().unwrap())
                        .unwrap_or(0);
                    if bytes.len() < split + 4 + length {
                        continue;
                    }
                    break (
                        header,
                        String::from_utf8(bytes[split + 4..split + 4 + length].to_vec()).unwrap(),
                    );
                };
                let path = header
                    .lines()
                    .next()
                    .unwrap()
                    .split_whitespace()
                    .nth(1)
                    .unwrap();
                let path = path.split('?').next().unwrap();
                let (status, response) = {
                    let mut state = state.lock().unwrap();
                    match path {
                        "/token" => {
                            let query =
                                reqwest::Url::parse(&format!("https://parse.invalid/?{body}"))
                                    .unwrap();
                            let fields: BTreeMap<_, _> = query.query_pairs().into_owned().collect();
                            assert!(
                                [format!("{endpoint}/"), format!("{endpoint}/mcp")]
                                    .contains(&fields["resource"])
                            );
                            let mut account = "account-one";
                            match fields["grant_type"].as_str() {
                                "authorization_code" => {
                                    state.exchanges += 1;
                                    let expected = state
                                        .codes
                                        .remove(&fields["code"])
                                        .expect("one registered code exchange");
                                    assert_eq!(
                                        URL_SAFE_NO_PAD.encode(Sha256::digest(
                                            fields["code_verifier"].as_bytes()
                                        )),
                                        expected
                                    );
                                    assert!(fields["redirect_uri"].starts_with("https://proompteng.ai/api/platform/provider-connections/callback/") || fields["redirect_uri"].starts_with("https://admin.proompteng.ai/api/platform/provider-connections/callback/"));
                                    if fields["code"] == "another-account" {
                                        account = "account-two";
                                    }
                                }
                                "refresh_token" => {
                                    state.refreshes += 1;
                                    assert!(
                                        state.refresh.remove(&fields["refresh_token"]),
                                        "refresh credentials are single use"
                                    );
                                    if state.lose_refresh {
                                        return;
                                    }
                                }
                                _ => panic!("unexpected provider grant"),
                            }
                            state.sequence += 1;
                            let access = format!("provider-access-{}", state.sequence);
                            let refresh = format!("provider-refresh-{}", state.sequence);
                            state.access.insert(access.clone(), account.into());
                            state.refresh.insert(refresh.clone());
                            (
                                200,
                                serde_json::json!({"access_token":access,"refresh_token":refresh,"token_type":"Bearer","expires_in":3600,"scope":state.scope.as_deref().unwrap_or("pods.read")}),
                            )
                        }
                        "/account" => {
                            let bearer = header
                                .lines()
                                .filter_map(|line| line.split_once(':'))
                                .find(|(key, _)| key.eq_ignore_ascii_case("authorization"))
                                .unwrap()
                                .1
                                .trim()
                                .strip_prefix("Bearer ")
                                .unwrap();
                            let account = state
                                .access
                                .get(bearer)
                                .expect("provider bearer credential");
                            (
                                200,
                                serde_json::json!({"id":account,"name":"Fixture account"}),
                            )
                        }
                        "/revoke" => {
                            state.revocations += 1;
                            let fields: BTreeMap<_, _> =
                                reqwest::Url::parse(&format!("https://parse.invalid/?{body}"))
                                    .unwrap()
                                    .query_pairs()
                                    .into_owned()
                                    .collect();
                            state.access.remove(&fields["token"]);
                            state.refresh.remove(&fields["token"]);
                            (200, serde_json::json!({}))
                        }
                        "/records" | "/mcp" => {
                            let bearer = header
                                .lines()
                                .filter_map(|line| line.split_once(':'))
                                .find(|(key, _)| key.eq_ignore_ascii_case("authorization"))
                                .and_then(|(_, value)| value.trim().strip_prefix("Bearer "));
                            if !bearer.is_some_and(|bearer| state.access.contains_key(bearer)) {
                                (401, serde_json::json!({}))
                            } else if path == "/records" {
                                state.http_calls += 1;
                                (200, serde_json::json!({"ready":true}))
                            } else if header.starts_with("GET ") {
                                (405, serde_json::json!({}))
                            } else if header.starts_with("DELETE ") {
                                (204, serde_json::json!({}))
                            } else {
                                let input: serde_json::Value = serde_json::from_str(&body).unwrap();
                                if input.get("id").is_none() {
                                    (202, serde_json::json!({}))
                                } else {
                                    let result = match input["method"].as_str().unwrap() {
                                        "initialize" => {
                                            serde_json::json!({"protocolVersion":input["params"]["protocolVersion"],"capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}})
                                        }
                                        "tools/list" => {
                                            serde_json::json!({"tools":[{"name":"fixture_read","inputSchema":operation().input_schema,"annotations":{"readOnlyHint":true,"destructiveHint":false}}]})
                                        }
                                        "tools/call" => {
                                            state.mcp_calls += 1;
                                            serde_json::json!({"content":[{"type":"text","text":"provider response"}],"isError":false})
                                        }
                                        _ => panic!("unexpected upstream MCP method"),
                                    };
                                    (
                                        200,
                                        serde_json::json!({"jsonrpc":"2.0","id":input["id"],"result":result}),
                                    )
                                }
                            }
                        }
                        _ => (404, serde_json::json!({"error":"unknown endpoint"})),
                    }
                };
                let body = response.to_string();
                let response = format!(
                    "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
            });
        }
    });
    (endpoint, state, task)
}

fn register_code(
    state: &Mutex<ProviderState>,
    begin: &proto::BeginProviderConnectionResponse,
    code: &str,
) -> String {
    let url = reqwest::Url::parse(&begin.authorization_url).unwrap();
    let fields: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(fields["code_challenge_method"], "S256");
    assert_eq!(
        fields["scope"],
        state
            .lock()
            .unwrap()
            .scope
            .as_deref()
            .unwrap_or("pods.read")
    );
    state
        .lock()
        .unwrap()
        .codes
        .insert(code.into(), fields["code_challenge"].clone());
    fields["state"].clone()
}

pub(crate) async fn qualify(
    owner: &Database,
    database: &Database,
    native: &Native,
    human: proto::PlatformHumanSession,
    administrator: proto::PlatformHumanSession,
    runtime: Runtime,
) {
    let directory = std::path::PathBuf::from(std::env::var("OFZ_TEST_CA_FILE").unwrap())
        .parent()
        .unwrap()
        .to_path_buf();
    let (endpoint, state, task) = provider(&directory).await;
    let workspace = registry::configured().unwrap().workspaces[0].id.clone();
    let resource = proto::PlatformResource {
        kind: "kubernetes.namespace".into(),
        id: "galactic/11111111-1111-4111-8111-111111111111".into(),
        target: String::new(),
    };
    let profile = Profile {
        id: "fixture-personal".into(),
        name: "Fixture provider".into(),
        workspace_id: workspace.clone(),
        connector_id: "fixture-http".into(),
        ownership: Ownership::Personal,
        resource: resource.clone(),
        actions: vec!["kubernetes.status.read".into()],
        resource_url: format!("{endpoint}/"),
        issuer: endpoint.clone(),
        authorization_endpoint: format!("{endpoint}/authorize"),
        token_endpoint: format!("{endpoint}/token"),
        account_endpoint: format!("{endpoint}/account"),
        account_id_field: "id".into(),
        account_name_field: "name".into(),
        revocation_endpoint: Some(format!("{endpoint}/revoke")),
        client_id: "provider-fixture".into(),
        client_secret_file: None,
        ca_file: Some(directory.join("ca.crt").to_str().unwrap().into()),
        scopes: vec!["pods.read".into()],
    };
    let mut shared = profile.clone();
    shared.id = "fixture-workspace".into();
    shared.connector_id = "fixture-mcp".into();
    shared.ownership = Ownership::Workspace;
    shared.resource_url = format!("{endpoint}/mcp");
    let providers = Providers::new(vec![profile.clone(), shared.clone()], &[77; 32]).unwrap();
    let binding = URL_SAFE_NO_PAD.encode([9; 32]);
    let mut begin = proto::BeginProviderConnectionRequest {
        operation_id: Uuid::new_v4().to_string(),
        human: Some(human.clone()),
        profile_id: profile.id.clone(),
        binding: binding.clone(),
        return_path: "/?settings=connections".into(),
    };
    let first = providers
        .begin(database, native, policy::BFF_ID, begin.clone())
        .await
        .unwrap();
    assert_eq!(
        first,
        providers
            .begin(database, native, policy::BFF_ID, begin.clone())
            .await
            .unwrap()
    );
    let response_state = register_code(&state, &first, "original");
    let mut complete = proto::CompleteProviderConnectionRequest {
        human: Some(human.clone()),
        profile_id: profile.id.clone(),
        state: response_state,
        binding: binding.clone(),
        code: "original".into(),
        issuer: endpoint.clone(),
        error: String::new(),
    };
    let mut wrong = complete.clone();
    wrong.binding = URL_SAFE_NO_PAD.encode([8; 32]);
    assert_eq!(
        providers
            .complete(database, native, policy::BFF_ID, wrong)
            .await
            .unwrap_err()
            .code(),
        Code::NotFound
    );
    let mut wrong = complete.clone();
    wrong.profile_id = shared.id.clone();
    assert_eq!(
        providers
            .complete(database, native, policy::BFF_ID, wrong)
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    let connected = providers
        .complete(database, native, policy::BFF_ID, complete.clone())
        .await
        .unwrap();
    assert!(connected.connected);
    assert_eq!(connected.connection_id, first.connection_id);
    assert_eq!(
        connected,
        providers
            .complete(database, native, policy::BFF_ID, complete.clone())
            .await
            .unwrap()
    );
    assert_eq!(state.lock().unwrap().exchanges, 1);
    begin.operation_id = Uuid::new_v4().to_string();
    let reconnect = providers
        .begin(database, native, policy::BFF_ID, begin.clone())
        .await
        .unwrap();
    assert_eq!(reconnect.connection_id, first.connection_id);
    complete.state = register_code(&state, &reconnect, "another-account");
    complete.code = "another-account".into();
    let wrong_account = providers
        .complete(database, native, policy::BFF_ID, complete.clone())
        .await
        .unwrap();
    assert!(!wrong_account.connected);
    assert_eq!(
        wrong_account.problem,
        proto::ProviderConnectionProblem::AccountMismatch as i32
    );
    assert_eq!(
        providers
            .complete(database, native, policy::BFF_ID, complete.clone())
            .await
            .unwrap(),
        wrong_account
    );
    begin.operation_id = Uuid::new_v4().to_string();
    let cancel = providers
        .begin(database, native, policy::BFF_ID, begin.clone())
        .await
        .unwrap();
    complete.state = register_code(&state, &cancel, "unused-cancelled-code");
    complete.code.clear();
    complete.error = "access_denied".into();
    let before = state.lock().unwrap().exchanges;
    assert!(
        !providers
            .complete(database, native, policy::BFF_ID, complete.clone())
            .await
            .unwrap()
            .connected
    );
    assert!(
        !providers
            .complete(database, native, policy::BFF_ID, complete)
            .await
            .unwrap()
            .connected
    );
    assert_eq!(state.lock().unwrap().exchanges, before);
    let denied = proto::BeginProviderConnectionRequest {
        operation_id: Uuid::new_v4().to_string(),
        profile_id: shared.id.clone(),
        ..begin.clone()
    };
    assert_eq!(
        providers
            .begin(database, native, policy::BFF_ID, denied)
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    let begin = proto::BeginProviderConnectionRequest {
        operation_id: Uuid::new_v4().to_string(),
        human: Some(administrator.clone()),
        profile_id: shared.id.clone(),
        ..begin
    };
    let shared_begin = providers
        .begin(database, native, ADMIN, begin)
        .await
        .unwrap();
    let response_state = register_code(&state, &shared_begin, "workspace-code");
    let complete = proto::CompleteProviderConnectionRequest {
        human: Some(administrator.clone()),
        profile_id: shared.id.clone(),
        state: response_state,
        binding,
        code: "workspace-code".into(),
        issuer: endpoint,
        error: String::new(),
    };
    providers
        .complete(database, native, ADMIN, complete.clone())
        .await
        .unwrap();
    let mut check = proto::CheckPlatformAccessRequest {
        operation_id: Uuid::new_v4().to_string(),
        subject: Some(proto::PlatformSubject {
            client_service: "opencode".into(),
            identity: Some(proto::platform_subject::Identity::WorkloadId(
                OPENCODE.into(),
            )),
        }),
        action: "kubernetes.status.read".into(),
        resources: vec![resource],
        request_hash: hash(b"provider fixture tool request"),
        ..Default::default()
    };
    let decision = authorization::check(database, native, RELAY, check.clone())
        .await
        .unwrap();
    assert!(decision.allowed);
    check.audit_receipt_id = decision.audit_receipt_id.clone();
    let record = proto::RecordPlatformExecutionRequest {
        operation_id: check.operation_id.clone(),
        authorization_receipt_id: check.audit_receipt_id.clone(),
        request_hash: check.request_hash.clone(),
        outcome: "started".into(),
        ..Default::default()
    };
    executions::record(database, RELAY, record.clone())
        .await
        .unwrap();
    let mut resolve = proto::ResolveProviderCredentialRequest {
        profile_id: shared.id.clone(),
        connector_id: shared.connector_id.clone(),
        destination: shared.resource_url.clone(),
        authorization: Some(check.clone()),
    };
    assert_eq!(
        providers
            .credential(database, native, OPENCODE, resolve.clone())
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    let mut wrong = resolve.clone();
    wrong.destination = "https://another.example/mcp".into();
    assert_eq!(
        providers
            .credential(database, native, RELAY, wrong)
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    let credential = providers
        .credential(database, native, RELAY, resolve.clone())
        .await
        .unwrap();
    let id = decision::parse_uuid(&credential.connection_id).unwrap();
    let connection = owner.pool.get().await.unwrap();
    let row = connection
        .query_one(
            "SELECT credential,profile_hash FROM ofz.provider_connections WHERE id=$1",
            &[&id],
        )
        .await
        .unwrap();
    let sealed: Vec<u8> = row.get(0);
    assert!(
        !sealed
            .windows(b"provider-access".len())
            .any(|bytes| bytes == b"provider-access")
    );
    let mut tokens: Tokens = providers
        .vault()
        .unwrap()
        .open(&credential_binding(id, &row.get::<_, Vec<u8>>(1)), &sealed)
        .unwrap();
    tokens.expires_at_ms = Some(database.state().await.unwrap().now_ms);
    connection.execute("UPDATE ofz.provider_connections SET credential=$2,expires_at_ms=ofz.now_ms() WHERE id=$1", &[&id, &providers.vault().unwrap().seal(&credential_binding(id, &row.get::<_, Vec<u8>>(1)), &tokens).unwrap()]).await.unwrap();
    let (one, two) = tokio::join!(
        providers.credential(database, native, RELAY, resolve.clone()),
        providers.credential(database, native, RELAY, resolve.clone())
    );
    assert_eq!(one.unwrap().access_token, two.unwrap().access_token);
    assert_eq!(state.lock().unwrap().refreshes, 1);
    let row = connection
        .query_one(
            "SELECT credential,profile_hash FROM ofz.provider_connections WHERE id=$1",
            &[&id],
        )
        .await
        .unwrap();
    let mut expired: Tokens = providers
        .vault()
        .unwrap()
        .open(
            &credential_binding(id, &row.get::<_, Vec<u8>>(1)),
            &row.get::<_, Vec<u8>>(0),
        )
        .unwrap();
    expired.expires_at_ms = Some(1);
    connection
        .execute(
            "UPDATE ofz.provider_connections SET credential=$2,expires_at_ms=1 WHERE id=$1",
            &[
                &id,
                &providers
                    .vault()
                    .unwrap()
                    .seal(&credential_binding(id, &row.get::<_, Vec<u8>>(1)), &expired)
                    .unwrap(),
            ],
        )
        .await
        .unwrap();
    state.lock().unwrap().lose_refresh = true;
    assert_eq!(
        providers
            .credential(database, native, RELAY, resolve.clone())
            .await
            .unwrap_err()
            .code(),
        Code::FailedPrecondition
    );
    assert_eq!(
        providers
            .credential(database, native, RELAY, resolve.clone())
            .await
            .unwrap_err()
            .code(),
        Code::FailedPrecondition
    );
    assert_eq!(state.lock().unwrap().refreshes, 2);
    state.lock().unwrap().lose_refresh = false;
    shared.scopes.push("pods.logs".into());
    state.lock().unwrap().scope = Some("pods.read pods.logs".into());
    let expanded = Providers::new(vec![profile.clone(), shared.clone()], &[77; 32]).unwrap();
    let directory = expanded
        .list(
            database,
            native,
            ADMIN,
            proto::ListProviderConnectionsRequest {
                human: Some(administrator.clone()),
                workspace_id: workspace,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        directory
            .connections
            .iter()
            .find(|info| info.profile_id == shared.id)
            .unwrap()
            .state,
        proto::ProviderConnectionState::Reconnect as i32
    );
    let expanded_begin = expanded
        .begin(
            database,
            native,
            ADMIN,
            proto::BeginProviderConnectionRequest {
                operation_id: Uuid::new_v4().to_string(),
                human: Some(administrator.clone()),
                profile_id: shared.id.clone(),
                binding: complete.binding.clone(),
                return_path: "/workspaces".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(expanded_begin.connection_id, shared_begin.connection_id);
    let complete = proto::CompleteProviderConnectionRequest {
        state: register_code(&state, &expanded_begin, "expanded-scopes"),
        code: "expanded-scopes".into(),
        ..complete
    };
    expanded
        .complete(database, native, ADMIN, complete.clone())
        .await
        .unwrap();
    assert_eq!(
        providers
            .credential(database, native, RELAY, resolve.clone())
            .await
            .unwrap_err()
            .code(),
        Code::FailedPrecondition
    );
    let providers = expanded;
    providers
        .credential(database, native, RELAY, resolve.clone())
        .await
        .unwrap();
    let rejected = proto::RecordPlatformExecutionRequest {
        outcome: "failed".into(),
        upstream_status: 401,
        ..record.clone()
    };
    let rejected_receipt = executions::record(database, RELAY, rejected.clone())
        .await
        .unwrap();
    assert_eq!(
        authorization::check(database, native, RELAY, check.clone())
            .await
            .unwrap_err()
            .code(),
        Code::FailedPrecondition
    );
    let repair = providers
        .begin(
            database,
            native,
            ADMIN,
            proto::BeginProviderConnectionRequest {
                operation_id: Uuid::new_v4().to_string(),
                human: Some(administrator.clone()),
                profile_id: shared.id.clone(),
                binding: complete.binding.clone(),
                return_path: "/workspaces".into(),
            },
        )
        .await
        .unwrap();
    let complete = proto::CompleteProviderConnectionRequest {
        state: register_code(&state, &repair, "repair-rejected-credential"),
        code: "repair-rejected-credential".into(),
        ..complete
    };
    providers
        .complete(database, native, ADMIN, complete.clone())
        .await
        .unwrap();
    assert_eq!(
        executions::record(database, RELAY, rejected).await.unwrap(),
        rejected_receipt
    );
    let directory = providers
        .list(
            database,
            native,
            ADMIN,
            proto::ListProviderConnectionsRequest {
                human: Some(administrator.clone()),
                workspace_id: shared.workspace_id.clone(),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        directory
            .connections
            .iter()
            .find(|info| info.profile_id == shared.id)
            .unwrap()
            .state,
        proto::ProviderConnectionState::Ready as i32
    );
    check.operation_id = Uuid::new_v4().to_string();
    check.audit_receipt_id.clear();
    check.audit_receipt_id = authorization::check(database, native, RELAY, check.clone())
        .await
        .unwrap()
        .audit_receipt_id;
    let record = proto::RecordPlatformExecutionRequest {
        operation_id: check.operation_id.clone(),
        authorization_receipt_id: check.audit_receipt_id.clone(),
        ..record
    };
    executions::record(database, RELAY, record.clone())
        .await
        .unwrap();
    resolve.authorization = Some(check.clone());
    providers
        .credential(database, native, RELAY, resolve.clone())
        .await
        .unwrap();
    resolve.profile_id = profile.id;
    resolve.connector_id = profile.connector_id;
    resolve.destination = profile.resource_url;
    assert_eq!(
        providers
            .credential(database, native, RELAY, resolve.clone())
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    let disconnect = proto::DisconnectProviderConnectionRequest {
        operation_id: Uuid::new_v4().to_string(),
        human: Some(administrator.clone()),
        profile_id: shared.id.clone(),
        connection_id: shared_begin.connection_id.clone(),
    };
    let disconnected = providers
        .disconnect(database, native, ADMIN, disconnect.clone())
        .await
        .unwrap();
    assert!(disconnected.provider_revocation_confirmed);
    assert_eq!(
        authorization::check(database, native, RELAY, check)
            .await
            .unwrap_err()
            .code(),
        Code::FailedPrecondition
    );
    assert_eq!(
        disconnected,
        providers
            .disconnect(database, native, ADMIN, disconnect)
            .await
            .unwrap()
    );
    assert!(
        !providers
            .complete(database, native, ADMIN, complete)
            .await
            .unwrap()
            .connected
    );
    resolve.profile_id = shared.id.clone();
    resolve.connector_id = shared.connector_id.clone();
    resolve.destination = format!(
        "{}/mcp",
        shared.authorization_endpoint.trim_end_matches("/authorize")
    );
    assert_eq!(
        providers
            .credential(database, native, RELAY, resolve)
            .await
            .unwrap_err()
            .code(),
        Code::FailedPrecondition
    );
    executions::record(
        database,
        RELAY,
        proto::RecordPlatformExecutionRequest {
            outcome: "failed".into(),
            ..record
        },
    )
    .await
    .unwrap();
    assert_eq!(connection.query_one("SELECT count(*) FROM ofz.audit WHERE receipt::text LIKE '%provider-access-%' OR receipt::text LIKE '%provider-refresh-%'", &[]).await.unwrap().get::<_, i64>(0), 0);
    drivers(database, native, shared, state, administrator, runtime).await;
    task.abort();
}

async fn drivers(
    database: &Database,
    native: &Native,
    shared: Profile,
    state: Arc<Mutex<ProviderState>>,
    administrator: proto::PlatformHumanSession,
    runtime: Runtime,
) {
    use platform_client::{ExecutionPayload, authz as sdk, relay as wire};
    use wire::relay_service_server::RelayService as _;
    let mut http = shared.clone();
    http.id = "fixture-workspace-http".into();
    http.connector_id = "fixture-oauth-http".into();
    http.resource_url = format!("{}/", shared.issuer);
    let providers = Providers::new(vec![shared.clone(), http.clone()], &[77; 32]).unwrap();
    for profile in [&shared, &http] {
        let binding = URL_SAFE_NO_PAD.encode([7; 32]);
        let begin = providers
            .begin(
                database,
                native,
                ADMIN,
                proto::BeginProviderConnectionRequest {
                    operation_id: Uuid::new_v4().to_string(),
                    human: Some(administrator.clone()),
                    profile_id: profile.id.clone(),
                    binding: binding.clone(),
                    return_path: "/workspaces".into(),
                },
            )
            .await
            .unwrap();
        let code = format!("driver-{}", profile.id);
        let complete = proto::CompleteProviderConnectionRequest {
            human: Some(administrator.clone()),
            profile_id: profile.id.clone(),
            state: register_code(&state, &begin, &code),
            binding,
            code,
            issuer: profile.issuer.clone(),
            error: String::new(),
        };
        providers
            .complete(database, native, ADMIN, complete)
            .await
            .unwrap();
    }
    let service = crate::platform::service::Service::new(
        database.clone(),
        native.clone(),
        crate::sessions::Issuer::new("https://identity.invalid/realms/tengri".into()).unwrap(),
        providers,
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let incoming = async_stream::stream! { loop { yield listener.accept().await.map(|(stream, _)| stream); } };
        tonic::transport::Server::builder().add_service(proto::platform_authorization_service_server::PlatformAuthorizationServiceServer::with_interceptor(service, |mut request: tonic::Request<()>| { request.extensions_mut().insert(crate::transport::Peer(RELAY.into())); Ok(request) })).serve_with_incoming(incoming).await.unwrap();
    });
    let channel = tonic::transport::Endpoint::from_shared(format!("http://{address}"))
        .unwrap()
        .connect()
        .await
        .unwrap();
    let enrollment =
        sdk::platform_authorization_service_client::PlatformAuthorizationServiceClient::new(
            channel.clone(),
        )
        .get_platform_configuration(platform_client::request(
            sdk::GetPlatformConfigurationRequest {},
        ))
        .await
        .unwrap()
        .into_inner();
    let http_connector = relay::http::Http::new(
        http.connector_id.clone(),
        &http.resource_url,
        http.ca_file.as_deref(),
        relay::credentials::Authentication::Oauth2 { profile: http.id },
        vec![relay::http::HttpOperation {
            operation: operation(),
            method: relay::http::Method::Get,
            path: "/records".into(),
        }],
    )
    .unwrap();
    let mcp_connector = relay::mcp::Mcp::new(
        shared.connector_id.clone(),
        relay::mcp::Transport::Http {
            endpoint: shared.resource_url,
            ca_file: shared.ca_file,
            authentication: relay::credentials::Authentication::Oauth2 { profile: shared.id },
        },
        vec![relay::mcp::McpOperation {
            operation: operation(),
            tool: "fixture_read".into(),
        }],
    )
    .unwrap();
    let relay = relay::service::Service::new(
        enrollment,
        vec![Box::new(http_connector), Box::new(mcp_connector)],
        channel,
    )
    .unwrap();
    let before = {
        let state = state.lock().unwrap();
        (state.http_calls, state.mcp_calls)
    };
    for connector_id in [&http.connector_id, &shared.connector_id] {
        for delegated in [false, true] {
            let payload = ExecutionPayload {
                operation_id: Uuid::new_v4().to_string(),
                client_service: if delegated { "tengri-web" } else { "opencode" }.into(),
                connector_id: connector_id.clone(),
                operation: "read".into(),
                arguments: serde_json::json!({"query":"verify a real provider read"}),
                binding: delegated.then(|| runtime.binding.clone()),
                delegation_id: delegated.then(|| runtime.delegation_id.clone()),
            };
            let body = serde_json::to_vec(&payload).unwrap();
            let identity = if delegated {
                sdk::platform_subject::Identity::Delegation(sdk::PlatformDelegationProof {
                    delegation_id: runtime.delegation_id.clone(),
                    credential: runtime.credential.clone(),
                    proof: crate::platform::proof::tests::signed_proof(
                        &runtime.credential,
                        &Sha256::digest(&body),
                    )
                    .1,
                })
            } else {
                sdk::platform_subject::Identity::WorkloadId(OPENCODE.into())
            };
            let mut request = platform_client::request(wire::ExecuteRequest {
                subject: Some(sdk::PlatformSubject {
                    client_service: payload.client_service,
                    identity: Some(identity),
                }),
                body,
            });
            request.extensions_mut().insert(platform_client::tls::Peer(
                if delegated { policy::BFF_ID } else { OPENCODE }.into(),
            ));
            let response = relay.execute(request).await.unwrap().into_inner();
            assert!(Uuid::parse_str(&response.authorization_receipt_id).is_ok());
            assert!(Uuid::parse_str(&response.execution_receipt_id).is_ok());
            let result: serde_json::Value = serde_json::from_slice(&response.result).unwrap();
            if connector_id == &http.connector_id {
                assert_eq!(result["ready"], true);
            } else {
                assert_eq!(result["content"][0]["text"], "provider response");
            }
        }
    }
    let state = state.lock().unwrap();
    assert_eq!(state.http_calls, before.0 + 2);
    assert_eq!(state.mcp_calls, before.1 + 2);
    server.abort();
}
