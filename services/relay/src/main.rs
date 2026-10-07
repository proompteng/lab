mod policy;
mod upstream;

use anyhow::{Context, bail};
use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, State},
    http::StatusCode,
    routing::{get, post},
};
use hyper_util::{
    rt::{TokioExecutor, TokioIo},
    server::conn::auto::Builder,
    service::TowerToHyperService,
};
use k8s_openapi::api::core::v1::{ConfigMap, Pod};
use kube::{
    Api, Client,
    api::{ApiResource, DynamicObject, GroupVersionKind, ListParams},
};
use policy::{Grant, Grants};
use serde_json::{Value, json};
use spiffe::{
    SpiffeId, TrustDomain, X509Source, X509Svid, cert::Certificate, x509_source::SvidPicker,
};
use spiffe_rustls::TrustDomainPolicy;
use std::{env, sync::Arc, time::Duration};
use tokio::{net::TcpListener, sync::Semaphore, time::timeout};
use tokio_rustls::TlsAcceptor;

#[derive(Clone)]
struct App {
    client: Client,
    domain: String,
    namespace: String,
    permits: Arc<Semaphore>,
}
struct OwnIdentity(SpiffeId);
impl SvidPicker for OwnIdentity {
    fn pick_svid(&self, svids: &[Arc<X509Svid>]) -> Option<usize> {
        svids.iter().position(|s| s.spiffe_id() == &self.0)
    }
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .map_err(|_| anyhow::anyhow!("install TLS crypto provider"))?;
    tracing_subscriber::fmt()
        .json()
        .with_env_filter("relay=info")
        .init();
    let domain: TrustDomain = env::var("SPIFFE_TRUST_DOMAIN")?.parse()?;
    let namespace = env::var("RELAY_NAMESPACE").unwrap_or_else(|_| "relay".into());
    let own: SpiffeId = format!("spiffe://{domain}/ns/{namespace}/sa/relay").parse()?;
    let source = X509Source::builder()
        .endpoint(env::var("SPIFFE_ENDPOINT_SOCKET")?)
        .picker(OwnIdentity(own))
        .initial_sync_timeout(Duration::from_secs(30))
        .build()
        .await?;
    let allowed_domain = domain.to_string();
    let tls = spiffe_rustls::mtls_server(source)
        .authorize(move |peer: &SpiffeId| {
            policy::guest_uid(&peer.to_string(), &allowed_domain).is_ok()
        })
        .trust_domain_policy(TrustDomainPolicy::LocalOnly(domain.clone()))
        .with_alpn_protocols([b"h2".to_vec(), b"http/1.1".to_vec()])
        .build()?;
    let app = App {
        client: Client::try_default().await?,
        domain: domain.to_string(),
        namespace,
        permits: Arc::new(Semaphore::new(32)),
    };
    app.grants()
        .await
        .context("validate initial connector grants")?;
    let health_app = app.clone();
    let health = Router::new()
        .route("/livez", get(|| async { StatusCode::OK }))
        .route(
            "/readyz",
            get(move || {
                let app = health_app.clone();
                async move {
                    if timeout(Duration::from_secs(3), app.grants())
                        .await
                        .is_ok_and(|r| r.is_ok())
                    {
                        StatusCode::OK
                    } else {
                        StatusCode::SERVICE_UNAVAILABLE
                    }
                }
            }),
        );
    let health_listener = TcpListener::bind("0.0.0.0:8080").await?;
    tokio::spawn(async move {
        if let Err(error) = axum::serve(health_listener, health).await {
            tracing::error!(%error, "health listener stopped");
        }
    });
    let listener = TcpListener::bind("0.0.0.0:8443").await?;
    let acceptor = TlsAcceptor::from(Arc::new(tls));
    let connections = Arc::new(Semaphore::new(64));
    tracing::info!("Relay connector listener ready");
    loop {
        let (socket, _) = listener.accept().await?;
        let Ok(permit) = connections.clone().try_acquire_owned() else {
            continue;
        };
        let acceptor = acceptor.clone();
        let app = app.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let Ok(Ok(stream)) = timeout(Duration::from_secs(10), acceptor.accept(socket)).await
            else {
                return;
            };
            let peer = stream
                .get_ref()
                .1
                .peer_certificates()
                .and_then(|c| c.first())
                .and_then(|c| Certificate::try_from(c.as_ref()).ok())
                .and_then(|c| c.spiffe_id().ok());
            let Some(peer) = peer else { return };
            let router = Router::new()
                .route("/mcp", post(mcp))
                .layer(DefaultBodyLimit::max(1 << 20))
                .layer(Extension(peer.to_string()))
                .with_state(app);
            let builder = Builder::new(TokioExecutor::new());
            let connection =
                builder.serve_connection(TokioIo::new(stream), TowerToHyperService::new(router));
            let _ = timeout(Duration::from_secs(120), connection).await;
        });
    }
}
impl App {
    async fn grants(&self) -> anyhow::Result<Grants> {
        let cm: ConfigMap = Api::namespaced(self.client.clone(), &self.namespace)
            .get("relay-grants")
            .await?;
        let raw = cm
            .data
            .as_ref()
            .and_then(|d| d.get("config.json"))
            .context("missing connector grants")?;
        let grants: Grants = serde_json::from_str(raw)?;
        grants.validate()?;
        Ok(grants)
    }
    async fn agent(&self, peer: &str) -> anyhow::Result<(String, String)> {
        let uid = policy::guest_uid(peer, &self.domain)?;
        let pods: Api<Pod> = Api::namespaced(self.client.clone(), "tengri");
        let found = pods
            .list(
                &ListParams::default()
                    .labels("app.kubernetes.io/name=nanoagent,app.kubernetes.io/component=microvm"),
            )
            .await?;
        let pod = found
            .items
            .iter()
            .find(|p| {
                p.metadata.uid.as_deref() == Some(uid) && p.metadata.deletion_timestamp.is_none()
            })
            .context("guest incarnation no longer active")?;
        let owner = pod
            .metadata
            .owner_references
            .as_ref()
            .and_then(|refs| {
                refs.iter()
                    .find(|r| r.kind == "MicroVM" && r.controller == Some(true))
            })
            .context("unowned guest")?;
        let resource = ApiResource::from_gvk(&GroupVersionKind::gvk(
            "runtime.proompteng.ai",
            "v1alpha1",
            "MicroVM",
        ));
        let vms: Api<DynamicObject> =
            Api::namespaced_with(self.client.clone(), "tengri", &resource);
        let vm = vms.get(&owner.name).await?;
        if pod.status.as_ref().and_then(|s| s.phase.as_deref()) != Some("Running")
            || vm.metadata.uid != Some(owner.uid.clone())
            || vm.metadata.deletion_timestamp.is_some()
            || vm.data["spec"]["desiredState"] != "Running"
            || vm.data["status"]["podUid"] != uid
        {
            bail!("inactive guest");
        }
        let owner_hash = vm.data["spec"]["ownerHash"]
            .as_str()
            .context("missing owner")?
            .to_string();
        Ok((owner.name.clone(), owner_hash))
    }
    async fn permitted(&self, peer: &str) -> anyhow::Result<Vec<Grant>> {
        let (agent, owner) = self.agent(peer).await?;
        Ok(self
            .grants()
            .await?
            .connectors
            .into_iter()
            .filter(|g| g.agent_id == agent && g.owner_hash == owner)
            .collect())
    }
    async fn request(&self, peer: &str, request: &Value) -> anyhow::Result<Value> {
        let method = request["method"].as_str().context("missing method")?;
        let grants = self.permitted(peer).await?;
        match method {
            "initialize" => {
                let protocol = request["params"]["protocolVersion"]
                    .as_str()
                    .context("missing protocol version")?;
                if !["2025-03-26", "2025-06-18", "2025-11-25"].contains(&protocol) {
                    bail!("unsupported MCP protocol version");
                }
                Ok(
                    json!({"protocolVersion": protocol, "capabilities": {"tools": {}}, "serverInfo": {"name": "Relay", "version": env!("CARGO_PKG_VERSION")}, "instructions": "Connector tools are scoped to this agent. Credentials stay in Relay."}),
                )
            }
            "ping" => Ok(json!({})),
            "tools/list" => {
                let mut tools = Vec::new();
                for grant in grants {
                    for tool in grant.tools {
                        tools.push(json!({"name": format!("{}__{}", grant.id, tool.name), "description": tool.description, "inputSchema": tool.input_schema, "annotations": {"readOnlyHint": true, "openWorldHint": true}}));
                    }
                }
                Ok(json!({"tools": tools}))
            }
            "tools/call" => {
                let name = request["params"]["name"]
                    .as_str()
                    .context("missing tool name")?;
                let (connector, tool) = name.split_once("__").context("invalid tool name")?;
                let grant = grants
                    .into_iter()
                    .find(|g| g.id == connector && g.tools.iter().any(|t| t.name == tool))
                    .context("tool not granted")?;
                let args = request["params"]
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                if !args.is_object() {
                    bail!("invalid arguments");
                }
                // Re-read durable authorization immediately before sending any third-party call.
                let still_granted = self.permitted(peer).await?.into_iter().any(|g| g == grant);
                if !still_granted {
                    bail!("grant revoked");
                }
                upstream::call(&grant, tool, args, || async {
                    if !self.permitted(peer).await?.into_iter().any(|g| g == grant) {
                        bail!("grant revoked");
                    }
                    Ok(())
                })
                .await
            }
            _ => bail!("unsupported MCP method"),
        }
    }
}
async fn mcp(
    State(app): State<App>,
    Extension(peer): Extension<String>,
    Json(request): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    if request["jsonrpc"] != "2.0"
        || request.is_array()
        || !(id.is_string() || id.is_number() || id.is_null())
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(
                json!({"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid request"}}),
            ),
        );
    }
    if request["method"] == "notifications/initialized" && request.get("id").is_none() {
        return (StatusCode::ACCEPTED, Json(Value::Null));
    }
    if request.get("id").is_none() || id.is_null() {
        return (
            StatusCode::BAD_REQUEST,
            Json(
                json!({"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Request ID required"}}),
            ),
        );
    }
    let Ok(_permit) = app.permits.clone().try_acquire_owned() else {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":"Relay busy"}})),
        );
    };
    let method = match request["method"].as_str() {
        Some("initialize") => "initialize",
        Some("ping") => "ping",
        Some("tools/list") => "tools/list",
        Some("tools/call") => "tools/call",
        _ => "unsupported",
    };
    match timeout(Duration::from_secs(60), app.request(&peer, &request)).await {
        Ok(Ok(result)) => {
            tracing::info!(method, outcome = "allowed", "connector request");
            (
                StatusCode::OK,
                Json(json!({"jsonrpc":"2.0","id":id,"result":result})),
            )
        }
        _ => {
            tracing::warn!(method, outcome = "denied_or_failed", "connector request");
            (
                StatusCode::OK,
                Json(
                    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":"Relay denied the request or the connector is unavailable"}}),
                ),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::State;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const UID: &str = "00112233-4455-6677-8899-aabbccddeeff";
    #[derive(Clone)]
    struct Fixture {
        owner: String,
        pod_uid: String,
        revoke: bool,
        reads: Arc<AtomicUsize>,
    }
    async fn fixture_response(State(f): State<Fixture>, uri: axum::http::Uri) -> Json<Value> {
        let owner_ref = json!({"apiVersion":"runtime.proompteng.ai/v1alpha1","kind":"MicroVM","name":"agent-test","uid":"vm-uid","controller":true});
        if uri.path().ends_with("/pods") {
            return Json(
                json!({"apiVersion":"v1","kind":"PodList","metadata":{},"items":[{"apiVersion":"v1","kind":"Pod","metadata":{"name":"guest","uid":UID,"ownerReferences":[owner_ref]},"status":{"phase":"Running"}}]}),
            );
        }
        if uri.path().ends_with("/agent-test") {
            return Json(
                json!({"apiVersion":"runtime.proompteng.ai/v1alpha1","kind":"MicroVM","metadata":{"name":"agent-test","uid":"vm-uid"},"spec":{"ownerHash":f.owner,"desiredState":"Running"},"status":{"podUid":f.pod_uid}}),
            );
        }
        let read = f.reads.fetch_add(1, Ordering::SeqCst);
        let connectors = if f.revoke && read > 0 {
            json!([])
        } else {
            json!([{"id":"docs","ownerHash":"a".repeat(64),"agentId":"agent-test","endpoint":"https://example.com/mcp","credentialKey":"docs-token","tools":[{"name":"search","description":"Search","inputSchema":{"type":"object"},"readOnly":true}]}])
        };
        Json(
            json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"relay-grants"},"data":{"config.json":json!({"connectors":connectors}).to_string()}}),
        )
    }
    async fn app(
        owner: &str,
        pod_uid: &str,
        revoke: bool,
    ) -> (App, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
        let reads = Arc::new(AtomicUsize::new(0));
        let fixture = Fixture {
            owner: owner.into(),
            pod_uid: pod_uid.into(),
            revoke,
            reads: reads.clone(),
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new()
                    .fallback(get(fixture_response))
                    .with_state(fixture),
            )
            .await
            .unwrap();
        });
        let config = kube::Config::new(format!("http://{address}").parse().unwrap());
        (
            App {
                client: Client::try_from(config).unwrap(),
                namespace: "relay".into(),
                domain: "proompteng.ai".into(),
                permits: Arc::new(Semaphore::new(32)),
            },
            reads,
            server,
        )
    }
    fn peer() -> String {
        format!("spiffe://proompteng.ai/ns/tengri/nanoagent/pod/{UID}")
    }
    #[tokio::test]
    async fn discovery_is_owner_scoped_and_never_includes_credentials() {
        let (app, _, server) = app(&"a".repeat(64), UID, false).await;
        let result = app
            .request(&peer(), &json!({"method":"tools/list"}))
            .await
            .unwrap();
        assert_eq!(result["tools"][0]["name"], "docs__search");
        assert!(!result.to_string().contains("docs-token"));
        assert!(!result.to_string().contains("example.com"));
        server.abort();
        let (app, _, server) = self::app(&"b".repeat(64), UID, false).await;
        assert_eq!(
            app.request(&peer(), &json!({"method":"tools/list"}))
                .await
                .unwrap()["tools"],
            json!([])
        );
        assert!(
            app.request(
                &peer(),
                &json!({"method":"tools/call","params":{"name":"docs__search"}})
            )
            .await
            .is_err()
        );
        server.abort();
    }
    #[tokio::test]
    async fn stale_incarnations_are_denied() {
        let (app, _, server) = app(
            &"a".repeat(64),
            "ffeeddcc-bbaa-9988-7766-554433221100",
            false,
        )
        .await;
        assert!(
            app.request(&peer(), &json!({"method":"tools/list"}))
                .await
                .is_err()
        );
        server.abort();
    }
    #[tokio::test]
    async fn revocation_is_rechecked_before_provider_dispatch() {
        let (app, reads, server) = app(&"a".repeat(64), UID, true).await;
        let error = app
            .request(
                &peer(),
                &json!({"method":"tools/call","params":{"name":"docs__search","arguments":{}}}),
            )
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "grant revoked");
        assert_eq!(reads.load(Ordering::SeqCst), 2);
        server.abort();
    }
    #[tokio::test]
    async fn ungranted_tools_and_sampling_are_denied() {
        let (app, _, server) = app(&"a".repeat(64), UID, false).await;
        for request in [
            json!({"method":"tools/call","params":{"name":"docs__delete"}}),
            json!({"method":"sampling/createMessage"}),
            json!({"method":"resources/read"}),
        ] {
            assert!(app.request(&peer(), &request).await.is_err());
        }
        server.abort();
    }
}
