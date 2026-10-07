use std::{path::PathBuf, pin::Pin, sync::Arc, time::Duration};

use anyhow::{Context as _, bail};
use async_stream::try_stream;
use futures::{Stream, StreamExt};
use kube::{
    Api, Client, ResourceExt,
    api::{ListParams, Patch, PatchParams},
};
use reqwest::{StatusCode, Url, redirect::Policy};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::time::sleep;
use tonic::Status;

use crate::crd::MicroVM;

pub(crate) const ENROLLED_ANNOTATION: &str = "runtime.proompteng.ai/spicedb-enrolled";
pub(crate) const SCHEMA: &str = include_str!("authz.zed");
const ENROLLMENT_VERSION: &str = "v1";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
const REVOCATION_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Clone)]
pub(crate) enum WorkspaceAuthorization {
    SpiceDb(Arc<SpiceDb>),
    #[cfg(test)]
    Fixture,
}

pub(crate) struct SpiceDb {
    http: reqwest::Client,
    endpoint: Url,
    key_file: PathBuf,
}

#[derive(Clone)]
pub(crate) struct WorkspaceAccess {
    authorization: WorkspaceAuthorization,
    resource_id: String,
    owner_hash: String,
}

#[derive(Deserialize)]
struct CheckResponse {
    permissionship: Permissionship,
}

#[derive(Deserialize)]
enum Permissionship {
    #[serde(rename = "PERMISSIONSHIP_HAS_PERMISSION")]
    Allowed,
    #[serde(rename = "PERMISSIONSHIP_NO_PERMISSION")]
    Denied,
    #[serde(rename = "PERMISSIONSHIP_CONDITIONAL_PERMISSION")]
    Conditional,
}

impl WorkspaceAuthorization {
    pub(crate) fn new(endpoint: &str, key_file: PathBuf) -> anyhow::Result<Self> {
        let endpoint = Url::parse(endpoint).context("parse TENGRI_AUTHZ_ENDPOINT")?;
        anyhow::ensure!(
            matches!(endpoint.scheme(), "http" | "https")
                && endpoint.host_str().is_some()
                && endpoint.username().is_empty()
                && endpoint.password().is_none()
                && endpoint.query().is_none()
                && endpoint.fragment().is_none()
                && endpoint.path() == "/",
            "TENGRI_AUTHZ_ENDPOINT must be an HTTP(S) origin without credentials"
        );
        Ok(Self::SpiceDb(Arc::new(SpiceDb {
            http: reqwest::Client::builder()
                .timeout(REQUEST_TIMEOUT)
                .redirect(Policy::none())
                .build()?,
            endpoint,
            key_file,
        })))
    }

    pub(crate) fn access(
        &self,
        namespace: &str,
        agent_id: &str,
        owner_hash: &str,
    ) -> WorkspaceAccess {
        WorkspaceAccess {
            authorization: self.clone(),
            resource_id: format!("{namespace}/{agent_id}"),
            owner_hash: owner_hash.to_owned(),
        }
    }

    pub(crate) async fn ready(&self) -> anyhow::Result<()> {
        match self {
            Self::SpiceDb(remote) => {
                remote
                    .check("__tengri_readiness__", &"0".repeat(64))
                    .await?;
                Ok(())
            }
            #[cfg(test)]
            Self::Fixture => Ok(()),
        }
    }

    pub(crate) async fn initialize(&self, client: Client, namespace: &str) -> anyhow::Result<()> {
        match self {
            Self::SpiceDb(remote) => {
                let response = remote.request("/v1/schema/read", json!({})).await?;
                if response.status() == StatusCode::NOT_FOUND {
                    let error: Value = response.json().await?;
                    anyhow::ensure!(error["code"] == 5, "unexpected SpiceDB schema error");
                    remote
                        .successful("/v1/schema/write", json!({"schema": SCHEMA}))
                        .await?;
                } else {
                    response.error_for_status().context("read SpiceDB schema")?;
                }
            }
            #[cfg(test)]
            Self::Fixture => {}
        }
        self.ready()
            .await
            .context("Tengri permission schema is unavailable")?;
        let agents: Api<MicroVM> = Api::namespaced(client.clone(), namespace);
        for agent in agents.list(&ListParams::default()).await? {
            if agent.metadata.deletion_timestamp.is_none() {
                self.enroll(client.clone(), namespace, &agent).await?;
            }
        }
        Ok(())
    }

    pub(crate) async fn enroll(
        &self,
        client: Client,
        namespace: &str,
        agent: &MicroVM,
    ) -> anyhow::Result<()> {
        match agent
            .annotations()
            .get(ENROLLED_ANNOTATION)
            .map(String::as_str)
        {
            Some(ENROLLMENT_VERSION) => return Ok(()),
            Some(_) => bail!("unsupported Tengri authorization enrollment version"),
            None => {}
        }
        anyhow::ensure!(
            agent.spec.owner_hash.len() == 64
                && agent
                    .spec
                    .owner_hash
                    .bytes()
                    .all(|value| value.is_ascii_hexdigit() && !value.is_ascii_uppercase()),
            "workspace has an invalid owner hash"
        );
        match self {
            Self::SpiceDb(remote) => {
                remote.successful("/v1/relationships/write", json!({
                    "updates": [{
                        "operation": "OPERATION_TOUCH",
                        "relationship": {
                            "resource": {"objectType": "tengri_workspace", "objectId": format!("{namespace}/{}", agent.name_any())},
                            "relation": "owner",
                            "subject": {"object": {"objectType": "tengri_user", "objectId": agent.spec.owner_hash}}
                        }
                    }]
                })).await?;
                let agents = Api::<MicroVM>::namespaced(client, namespace);
                let mut current = agent.clone();
                for _ in 0..4 {
                    match agents
                        .patch(
                            &agent.name_any(),
                            &PatchParams::default(),
                            &Patch::Merge(json!({"metadata": {
                                "resourceVersion": current.resource_version(),
                                "annotations": {ENROLLED_ANNOTATION: ENROLLMENT_VERSION}
                            }})),
                        )
                        .await
                    {
                        Ok(_) => return Ok(()),
                        Err(kube::Error::Api(error)) if error.code == 409 => {
                            current = agents.get(&agent.name_any()).await?;
                            anyhow::ensure!(
                                current.uid() == agent.uid()
                                    && current.spec.owner_hash == agent.spec.owner_hash
                                    && current.metadata.deletion_timestamp.is_none(),
                                "workspace changed during authorization enrollment"
                            );
                            match current
                                .annotations()
                                .get(ENROLLED_ANNOTATION)
                                .map(String::as_str)
                            {
                                Some(ENROLLMENT_VERSION) => return Ok(()),
                                Some(_) => {
                                    bail!("unsupported Tengri authorization enrollment version")
                                }
                                None => {}
                            }
                        }
                        Err(error) => {
                            return Err(error)
                                .context("persist workspace authorization enrollment");
                        }
                    }
                }
                bail!("workspace changed repeatedly during authorization enrollment")
            }
            #[cfg(test)]
            Self::Fixture => Ok(()),
        }
    }

    pub(crate) async fn remove(&self, namespace: &str, agent_id: &str) -> anyhow::Result<()> {
        match self {
            Self::SpiceDb(remote) => {
                remote.successful("/v1/relationships/delete", json!({
                    "relationshipFilter": {"resourceType": "tengri_workspace", "optionalResourceId": format!("{namespace}/{agent_id}")}
                })).await?;
                Ok(())
            }
            #[cfg(test)]
            Self::Fixture => Ok(()),
        }
    }
}

impl SpiceDb {
    async fn request(&self, path: &str, body: Value) -> anyhow::Result<reqwest::Response> {
        let key = tokio::fs::read_to_string(&self.key_file)
            .await
            .context("read SpiceDB credential file")?;
        let key = key.trim();
        anyhow::ensure!(!key.is_empty(), "SpiceDB credential file is empty");
        self.http
            .post(self.endpoint.join(path)?)
            .bearer_auth(key)
            .json(&body)
            .send()
            .await
            .with_context(|| format!("SpiceDB request {path} failed"))
    }

    async fn successful(&self, path: &str, body: Value) -> anyhow::Result<reqwest::Response> {
        self.request(path, body)
            .await?
            .error_for_status()
            .with_context(|| format!("SpiceDB request {path} was rejected"))
    }

    async fn check(&self, resource_id: &str, owner_hash: &str) -> anyhow::Result<bool> {
        let response: CheckResponse = self
            .successful(
                "/v1/permissions/check",
                json!({
                    "consistency": {"fullyConsistent": true},
                    "resource": {"objectType": "tengri_workspace", "objectId": resource_id},
                    "permission": "access",
                    "subject": {"object": {"objectType": "tengri_user", "objectId": owner_hash}}
                }),
            )
            .await?
            .json()
            .await
            .context("decode SpiceDB permission response")?;
        Ok(matches!(response.permissionship, Permissionship::Allowed))
    }
}

impl WorkspaceAccess {
    pub(crate) async fn require(&self) -> Result<(), Status> {
        let allowed = match &self.authorization {
            WorkspaceAuthorization::SpiceDb(remote) => remote
                .check(&self.resource_id, &self.owner_hash)
                .await
                .map_err(|error| {
                    Status::unavailable(format!("authorization service is unavailable: {error:#}"))
                })?,
            #[cfg(test)]
            WorkspaceAuthorization::Fixture => true,
        };
        if !allowed {
            return Err(Status::permission_denied("workspace access is denied"));
        }
        Ok(())
    }

    pub(crate) async fn revoked(&self) -> Status {
        loop {
            sleep(REVOCATION_INTERVAL).await;
            if let Err(error) = self.require().await {
                return error;
            }
        }
    }

    pub(crate) fn guard_stream<T: Send + 'static>(
        &self,
        stream: impl Stream<Item = Result<T, Status>> + Send + 'static,
    ) -> Pin<Box<dyn Stream<Item = Result<T, Status>> + Send>> {
        let access = self.clone();
        Box::pin(try_stream! {
            let revoked = access.revoked();
            tokio::pin!(revoked);
            let mut stream = Box::pin(stream);
            loop {
                let event = tokio::select! {
                    biased;
                    error = &mut revoked => Some(Err(error)),
                    event = stream.next() => event,
                };
                let Some(event) = event else { break };
                yield event?;
            }
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use axum::{
        Json, Router, extract::State, http::HeaderMap, response::IntoResponse, routing::post,
    };
    use std::sync::{
        Mutex,
        atomic::{AtomicU8, Ordering},
    };
    use tokio::{net::TcpListener, task::JoinHandle};

    #[derive(Clone)]
    struct FixtureState {
        mode: Arc<AtomicU8>,
        requests: Arc<Mutex<Vec<(String, Value)>>>,
    }

    pub(crate) struct SpiceFixture {
        pub(crate) authorization: WorkspaceAuthorization,
        pub(crate) mode: Arc<AtomicU8>,
        requests: Arc<Mutex<Vec<(String, Value)>>>,
        key_file: PathBuf,
        server: JoinHandle<()>,
    }

    impl SpiceFixture {
        pub(crate) async fn new() -> Self {
            let key_file =
                std::env::temp_dir().join(format!("tengri-authz-{}", uuid::Uuid::new_v4()));
            tokio::fs::write(&key_file, "fixture-key").await.unwrap();
            let mode = Arc::new(AtomicU8::new(0));
            let requests = Arc::new(Mutex::new(Vec::new()));
            let state = FixtureState {
                mode: mode.clone(),
                requests: requests.clone(),
            };
            let app = Router::new()
                .fallback(post(
                    move |State(state): State<FixtureState>,
                          uri: axum::http::Uri,
                          headers: HeaderMap,
                          Json(body): Json<Value>| async move {
                        state
                            .requests
                            .lock()
                            .unwrap()
                            .push((uri.path().to_owned(), body));
                        if headers.get("authorization").and_then(|v| v.to_str().ok())
                            != Some("Bearer fixture-key")
                        {
                            return (StatusCode::FORBIDDEN, Json(json!({"code": 7})))
                                .into_response();
                        }
                        match state.mode.load(Ordering::SeqCst) {
                            0 => Json(json!({"permissionship": "PERMISSIONSHIP_HAS_PERMISSION"}))
                                .into_response(),
                            1 => Json(json!({"permissionship": "PERMISSIONSHIP_NO_PERMISSION"}))
                                .into_response(),
                            2 => Json(
                                json!({"permissionship": "PERMISSIONSHIP_CONDITIONAL_PERMISSION"}),
                            )
                            .into_response(),
                            3 => Json(json!({"permissionship": "unrecognized"})).into_response(),
                            4 => (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"code": 14})))
                                .into_response(),
                            5 => (
                                StatusCode::TEMPORARY_REDIRECT,
                                [("location", "http://127.0.0.1:1/credential-leak")],
                            )
                                .into_response(),
                            _ => {
                                sleep(Duration::from_secs(5)).await;
                                Json(json!({"permissionship": "PERMISSIONSHIP_HAS_PERMISSION"}))
                                    .into_response()
                            }
                        }
                    },
                ))
                .with_state(state);
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });
            let authorization = WorkspaceAuthorization::new(&endpoint, key_file.clone()).unwrap();
            Self {
                authorization,
                mode,
                requests,
                key_file,
                server,
            }
        }
    }

    impl Drop for SpiceFixture {
        fn drop(&mut self) {
            self.server.abort();
            let _ = std::fs::remove_file(&self.key_file);
        }
    }

    #[tokio::test]
    async fn authoritative_checks_are_fully_consistent_and_namespace_scoped() {
        let fixture = SpiceFixture::new().await;
        let access = fixture
            .authorization
            .access("tengri", "agent-example", &"a".repeat(64));
        access.require().await.unwrap();
        let requests = fixture.requests.lock().unwrap();
        assert_eq!(
            requests[0],
            (
                "/v1/permissions/check".into(),
                json!({
                    "consistency": {"fullyConsistent": true},
                    "resource": {"objectType": "tengri_workspace", "objectId": "tengri/agent-example"},
                    "permission": "access",
                    "subject": {"object": {"objectType": "tengri_user", "objectId": "a".repeat(64)}}
                })
            )
        );
    }

    #[tokio::test]
    async fn denial_conditional_results_and_service_failures_never_allow_access() {
        let fixture = SpiceFixture::new().await;
        let access = fixture
            .authorization
            .access("tengri", "agent-example", &"a".repeat(64));
        for (mode, code) in [
            (1, tonic::Code::PermissionDenied),
            (2, tonic::Code::PermissionDenied),
            (3, tonic::Code::Unavailable),
            (4, tonic::Code::Unavailable),
            (5, tonic::Code::Unavailable),
        ] {
            fixture.mode.store(mode, Ordering::SeqCst);
            assert_eq!(access.require().await.unwrap_err().code(), code);
        }
    }

    #[tokio::test]
    async fn credential_projection_is_read_again_for_each_request() {
        let fixture = SpiceFixture::new().await;
        let access = fixture
            .authorization
            .access("tengri", "agent-example", &"a".repeat(64));
        access.require().await.unwrap();
        tokio::fs::write(&fixture.key_file, "rotated-key")
            .await
            .unwrap();
        let error = access.require().await.unwrap_err();
        assert_eq!(error.code(), tonic::Code::Unavailable);
        assert!(!error.message().contains("rotated-key"));
        tokio::fs::write(&fixture.key_file, "fixture-key")
            .await
            .unwrap();
        access.require().await.unwrap();
    }

    #[tokio::test]
    async fn unresponsive_authority_has_a_bounded_deadline() {
        let fixture = SpiceFixture::new().await;
        fixture.mode.store(6, Ordering::SeqCst);
        let error = tokio::time::timeout(
            Duration::from_secs(3),
            fixture
                .authorization
                .access("tengri", "agent-example", &"a".repeat(64))
                .require(),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert_eq!(error.code(), tonic::Code::Unavailable);
    }

    #[tokio::test]
    async fn revocation_and_outages_terminate_idle_streams() {
        let fixture = SpiceFixture::new().await;
        let access = fixture
            .authorization
            .access("tengri", "agent-example", &"a".repeat(64));
        for (mode, code) in [
            (1, tonic::Code::PermissionDenied),
            (4, tonic::Code::Unavailable),
        ] {
            fixture.mode.store(0, Ordering::SeqCst);
            access.require().await.unwrap();
            let mut stream = access.guard_stream(futures::stream::pending::<Result<(), Status>>());
            fixture.mode.store(mode, Ordering::SeqCst);
            let error = tokio::time::timeout(Duration::from_secs(2), stream.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap_err();
            assert_eq!(error.code(), code);
            assert!(stream.next().await.is_none());
        }
    }

    #[tokio::test]
    async fn revocation_interrupts_a_busy_stream() {
        let fixture = SpiceFixture::new().await;
        let access = fixture
            .authorization
            .access("tengri", "agent-example", &"a".repeat(64));
        access.require().await.unwrap();
        let source = futures::stream::repeat_with(|| Ok::<_, Status>(()));
        let mut stream = access.guard_stream(source);
        assert!(stream.next().await.unwrap().is_ok());
        fixture.mode.store(1, Ordering::SeqCst);
        let code = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Err(error) = stream.next().await.unwrap() {
                    return error.code();
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(code, tonic::Code::PermissionDenied);
    }

    #[tokio::test]
    #[ignore = "runs against an isolated SpiceDB instance through test-authz.sh"]
    async fn real_spicedb_enrollment_revocation_and_schema_preservation() {
        use http::Response;
        use kube::client::Body;
        let authorization = WorkspaceAuthorization::new(
            &std::env::var("TENGRI_AUTHZ_TEST_ENDPOINT").unwrap(),
            PathBuf::from(std::env::var("TENGRI_AUTHZ_TEST_KEY_FILE").unwrap()),
        )
        .unwrap();
        let WorkspaceAuthorization::SpiceDb(remote) = &authorization else {
            unreachable!()
        };
        let owner = "a".repeat(64);
        let mut agent: MicroVM = serde_json::from_value(json!({
            "apiVersion": "runtime.proompteng.ai/v1alpha1", "kind": "MicroVM",
            "metadata": {"name": "agent-authz-test", "namespace": "tengri", "uid": "fixture-workspace", "resourceVersion": "1"},
            "spec": {"displayName": "Authorization test", "ownerHash": owner, "desiredState": "Sleeping",
                "image": "fixture", "architecture": "amd64", "resources": {"cpuMillis": 100, "memoryMib": 128, "workspaceGib": 1},
                "createdAt": "2026-10-06T00:00:00Z", "idleDeadline": "2026-10-06T01:00:00Z"}
        })).unwrap();
        let (service, mut handle) = tower_test::mock::pair::<http::Request<Body>, Response<Body>>();
        let client = Client::new(service, "tengri");
        let startup = authorization.clone();
        let startup_client = client.clone();
        let task = tokio::spawn(async move { startup.initialize(startup_client, "tengri").await });
        let (request, response) = handle.next_request().await.unwrap();
        assert_eq!(request.method(), http::Method::GET);
        assert!(request.uri().path().ends_with("/microvms"));
        response.send_response(Response::builder().header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&json!({"apiVersion": "runtime.proompteng.ai/v1alpha1", "kind": "MicroVMList", "metadata": {}, "items": [agent]})).unwrap())).unwrap());

        let (request, response) = handle.next_request().await.unwrap();
        assert_eq!(request.method(), http::Method::PATCH);
        response.send_response(Response::builder().status(409).header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&json!({"apiVersion":"v1", "kind":"Status", "status":"Failure", "message":"fixture status write", "reason":"Conflict", "code":409})).unwrap())).unwrap());
        agent.metadata.resource_version = Some("2".into());
        let (request, response) = handle.next_request().await.unwrap();
        assert_eq!(request.method(), http::Method::GET);
        response.send_response(
            Response::builder()
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&agent).unwrap()))
                .unwrap(),
        );
        let (request, response) = handle.next_request().await.unwrap();
        assert_eq!(request.method(), http::Method::PATCH);
        let patch: Value =
            serde_json::from_slice(&request.into_body().collect_bytes().await.unwrap()).unwrap();
        assert_eq!(patch["metadata"]["resourceVersion"], "2");
        assert_eq!(
            patch["metadata"]["annotations"][ENROLLED_ANNOTATION],
            ENROLLMENT_VERSION
        );
        agent
            .metadata
            .annotations
            .get_or_insert_default()
            .insert(ENROLLED_ANNOTATION.into(), ENROLLMENT_VERSION.into());
        response.send_response(
            Response::builder()
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&agent).unwrap()))
                .unwrap(),
        );
        task.await.unwrap().unwrap();

        let access = authorization.access("tengri", &agent.name_any(), &owner);
        access.require().await.unwrap();
        assert_eq!(
            authorization
                .access("tengri", &agent.name_any(), &"b".repeat(64))
                .require()
                .await
                .unwrap_err()
                .code(),
            tonic::Code::PermissionDenied
        );
        assert_eq!(
            authorization
                .access("other", &agent.name_any(), &owner)
                .require()
                .await
                .unwrap_err()
                .code(),
            tonic::Code::PermissionDenied
        );
        let mut stream = access.guard_stream(futures::stream::pending::<Result<(), Status>>());
        authorization
            .remove("tengri", &agent.name_any())
            .await
            .unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(3), stream.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap_err()
                .code(),
            tonic::Code::PermissionDenied
        );
        authorization
            .enroll(client.clone(), "tengri", &agent)
            .await
            .unwrap();
        assert_eq!(
            access.require().await.unwrap_err().code(),
            tonic::Code::PermissionDenied
        );

        remote
            .successful(
                "/v1/schema/write",
                json!({"schema": format!("{SCHEMA}\ndefinition unrelated_application {{}}\n")}),
            )
            .await
            .unwrap();
        let existing: Value = remote
            .successful("/v1/schema/read", json!({}))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let restarted = authorization.clone();
        let task = tokio::spawn(async move { restarted.initialize(client, "tengri").await });
        let (_, response) = handle.next_request().await.unwrap();
        response.send_response(Response::builder().header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&json!({"apiVersion": "runtime.proompteng.ai/v1alpha1", "kind": "MicroVMList", "metadata": {}, "items": [agent]})).unwrap())).unwrap());
        task.await.unwrap().unwrap();
        assert_eq!(
            access.require().await.unwrap_err().code(),
            tonic::Code::PermissionDenied
        );
        let preserved: Value = remote
            .successful("/v1/schema/read", json!({}))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(preserved["schemaText"], existing["schemaText"]);
        assert!(
            preserved["schemaText"]
                .as_str()
                .unwrap()
                .contains("unrelated_application")
        );
    }
}
