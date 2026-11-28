use axum::{
    Json, Router,
    extract::State as HttpState,
    http::StatusCode,
    routing::{get, post},
};
use serde::de::DeserializeOwned;

use super::*;

const MAX_RESPONSE_BYTES: usize = 16 << 20;

#[derive(Clone)]
pub(super) struct Client {
    url: reqwest::Url,
    http: reqwest::Client,
}

impl Client {
    pub(super) fn new(url: &str) -> Result<Self, Status> {
        let url =
            reqwest::Url::parse(url).map_err(|_| Status::internal("invalid run reader URL"))?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host().is_none()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(Status::internal("invalid run reader URL"));
        }
        Ok(Self {
            url,
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(2))
                .build()
                .map_err(|_| Status::internal("create run reader client"))?,
        })
    }

    async fn post<T: DeserializeOwned>(
        &self,
        path: &str,
        body: &impl Serialize,
    ) -> Result<T, Status> {
        let url = self
            .url
            .join(path)
            .map_err(|_| Status::internal("invalid run reader path"))?;
        let response = self
            .http
            .post(url)
            .header(reqwest::header::ACCEPT, "application/json")
            .json(body)
            .send()
            .await
            .map_err(|error| {
                tracing::warn!(
                    operation = path,
                    timeout = error.is_timeout(),
                    connect = error.is_connect(),
                    "run state request failed"
                );
                Status::unavailable("run state reader unavailable")
            })?;
        if response.status().is_server_error() {
            tracing::warn!(
                operation = path,
                http_status = response.status().as_u16(),
                "run state backend unavailable"
            );
        }
        match response.status().as_u16() {
            200 => {}
            400 => return Err(Status::invalid_argument("invalid run query")),
            401 => return Err(Status::unauthenticated("run authorization is invalid")),
            403 => return Err(Status::permission_denied("run unavailable")),
            404 => {
                return Err(Status::not_found(
                    "run is unavailable or its retention expired",
                ));
            }
            408 => {
                return Err(Status::deadline_exceeded(
                    "run query expired before admission",
                ));
            }
            422 => return Err(Status::failed_precondition("run query was rejected")),
            409 => {
                return Err(Status::already_exists(
                    "operation ID already has different input",
                ));
            }
            500..=599 => return Err(Status::unavailable("run state reader unavailable")),
            _ => return Err(Status::internal("invalid run state reader response")),
        }
        bounded_json(response).await
    }

    pub(super) async fn status(&self, query: &Query) -> Result<Snapshot, Status> {
        self.post("status", query).await
    }

    pub(super) async fn active(&self, query: &Query) -> Result<Vec<Claim>, Status> {
        self.post("active", query).await
    }
}

pub(super) fn client() -> Result<&'static Client, Status> {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let url = env::var("TENGRI_RUN_READER")
        .map_err(|_| Status::unavailable("run state reader is not configured"))?;
    let client = Client::new(&url)?;
    Ok(CLIENT.get_or_init(|| client))
}

async fn bounded_json<T: DeserializeOwned>(mut response: reqwest::Response) -> Result<T, Status> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| Status::unavailable("run state response interrupted"))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(Status::internal("run state response exceeds its budget"));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| Status::internal("invalid run state response"))
}

#[derive(Clone)]
pub(super) struct Backend(Client);

#[derive(Deserialize)]
struct Rows {
    rows: Vec<Row>,
}
#[derive(Deserialize)]
struct Row {
    value_utf8: String,
}

impl Backend {
    pub(super) fn new(url: &str) -> Result<Self, Status> {
        let mut client = Client::new(url)?;
        client.http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(STATUS_RECOVERY_TIMEOUT)
            .build()
            .map_err(|_| Status::internal("create run state backend"))?;
        Ok(Self(client))
    }

    async fn state<T: DeserializeOwned>(
        &self,
        service: &'static str,
        key: &str,
        field: &'static str,
    ) -> Result<Option<T>, Status> {
        // Only canonical UUIDs enter the fixed query. Callers cannot supply SQL, table names, or state fields.
        let key = canonical_uuid(key)?;
        let query = format!(
            "SELECT value_utf8 FROM state WHERE service_name='{service}' AND service_key='{key}' AND key='{field}' LIMIT 2"
        );
        let rows: Rows = self
            .0
            .post("query", &serde_json::json!({"query": query}))
            .await?;
        if rows.rows.len() > 1 {
            return Err(Status::internal("ambiguous run state"));
        }
        rows.rows
            .into_iter()
            .next()
            .map(|row| {
                serde_json::from_str(&row.value_utf8)
                    .map_err(|_| Status::internal("invalid stored run state"))
            })
            .transpose()
    }

    async fn claims(&self, query: &Query) -> Result<Vec<Claim>, Status> {
        admit(query)?;
        let active: BTreeMap<String, Claim> = self
            .state("TengriWorkspaceRuns", &query.workspace_uid, "active")
            .await?
            .unwrap_or_default();
        Ok(active
            .into_values()
            .filter(|claim| claim.workspace_uid == query.workspace_uid)
            .collect())
    }

    async fn snapshot(&self, query: &Query) -> Result<Snapshot, Status> {
        admit(query)?;
        canonical_uuid(&query.run_id)?;
        let snapshot: Option<Snapshot> = self
            .state("TengriAgentRun", &query.run_id, "snapshot")
            .await?;
        let Some(snapshot) = snapshot else {
            // A durable admission or workspace claim can precede the first snapshot. Reconcile it without resending.
            if query.digest.is_some()
                || self
                    .claims(query)
                    .await?
                    .iter()
                    .any(|claim| claim.run_id == query.run_id)
            {
                return Err(Status::unavailable("run is being admitted"));
            }
            return Err(Status::not_found(
                "run is unavailable or its retention expired",
            ));
        };
        if snapshot.run_id != query.run_id
            || snapshot.workspace_uid != query.workspace_uid
            || snapshot.owner_hash != query.owner_hash
        {
            return Err(Status::permission_denied("run unavailable"));
        }
        if query
            .digest
            .as_ref()
            .is_some_and(|digest| digest != &snapshot.digest)
        {
            return Err(Status::already_exists(
                "operation ID already has different input",
            ));
        }
        Ok(snapshot)
    }
}

fn canonical_uuid(value: &str) -> Result<String, Status> {
    let id = Uuid::parse_str(value)
        .map_err(|_| Status::invalid_argument("invalid run query identity"))?;
    if id.to_string() != value {
        return Err(Status::invalid_argument("invalid run query identity"));
    }
    Ok(id.to_string())
}

fn admit(query: &Query) -> Result<(), Status> {
    canonical_uuid(&query.workspace_uid)?;
    if query.expires_at_ms < crate::ofz::now_ms()? {
        return Err(Status::deadline_exceeded(
            "run query expired before admission",
        ));
    }
    Ok(())
}

fn http_error(error: Status) -> (StatusCode, String) {
    let status = match error.code() {
        tonic::Code::InvalidArgument => StatusCode::BAD_REQUEST,
        tonic::Code::PermissionDenied | tonic::Code::Unauthenticated => StatusCode::FORBIDDEN,
        tonic::Code::NotFound => StatusCode::NOT_FOUND,
        tonic::Code::AlreadyExists => StatusCode::CONFLICT,
        tonic::Code::DeadlineExceeded => StatusCode::REQUEST_TIMEOUT,
        _ => StatusCode::SERVICE_UNAVAILABLE,
    };
    (status, error.message().to_owned())
}

// The mesh admits only the existing Tengri controller identity. User authority is checked by Ofz before these reads.
pub(super) fn router(backend: Backend) -> Router {
    Router::new()
        .route(
            "/status",
            post(
                |HttpState(backend): HttpState<Backend>, Json(query): Json<Query>| async move {
                    backend.snapshot(&query).await.map(Json).map_err(http_error)
                },
            ),
        )
        .route(
            "/active",
            post(
                |HttpState(backend): HttpState<Backend>, Json(query): Json<Query>| async move {
                    backend.claims(&query).await.map(Json).map_err(http_error)
                },
            ),
        )
        .route("/healthz", get(|| async { "ok" }))
        .route(
            "/readyz",
            get(|HttpState(backend): HttpState<Backend>| async move {
                backend
                    .0
                    .post::<serde_json::Value>("query", &serde_json::json!({"query":"SELECT 1"}))
                    .await
                    .map(|_| "ok")
                    .map_err(http_error)
            }),
        )
        .layer(axum::extract::DefaultBodyLimit::max(4096))
        .with_state(backend)
}

pub(crate) async fn serve() -> anyhow::Result<()> {
    let backend = Backend::new(&env::var("TENGRI_RESTATE_ADMIN")?)?;
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await?;
    axum::serve(listener, router(backend))
        .with_graceful_shutdown(async {
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("install termination handler");
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use std::sync::Mutex;
    use tower::ServiceExt;

    fn query() -> Query {
        Query {
            run_id: Uuid::new_v4().to_string(),
            workspace_uid: Uuid::new_v4().to_string(),
            owner_hash: "a".repeat(64),
            digest: None,
            expires_at_ms: crate::ofz::now_ms().unwrap() + 2000,
        }
    }

    async fn backend(
        value: Option<serde_json::Value>,
    ) -> (
        Backend,
        Arc<Mutex<Vec<String>>>,
        tokio::task::JoinHandle<()>,
    ) {
        let queries = Arc::new(Mutex::new(Vec::new()));
        let captured = queries.clone();
        let app = Router::new().route(
            "/query",
            post(
                move |headers: axum::http::HeaderMap, Json(body): Json<serde_json::Value>| {
                    assert_eq!(headers[reqwest::header::ACCEPT], "application/json");
                    captured
                        .lock()
                        .unwrap()
                        .push(body["query"].as_str().unwrap().to_owned());
                    let rows = value
                        .clone()
                        .map(|value| serde_json::json!({"value_utf8":value.to_string()}))
                        .into_iter()
                        .collect::<Vec<_>>();
                    async move { Json(serde_json::json!({"rows":rows})) }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend = Backend::new(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (backend, queries, task)
    }

    async fn request(app: Router, path: &str, body: impl Serialize) -> StatusCode {
        app.oneshot(
            axum::http::Request::post(path)
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap()
        .status()
    }

    #[tokio::test]
    async fn snapshot_reads_bind_owner_workspace_and_input_without_creating_invocations() {
        let mut query = query();
        let snapshot = serde_json::json!({"run_id":query.run_id,"workspace_uid":query.workspace_uid,"owner_hash":query.owner_hash,"agent_id":"fixture","thread_id":"thread","digest":"original","state":{"phase":"running","turnId":"accepted"}});
        let (backend, queries, task) = backend(Some(snapshot)).await;
        let app = router(backend);
        assert_eq!(
            request(app.clone(), "/status", &query).await,
            StatusCode::OK
        );
        query.digest = Some("changed".into());
        assert_eq!(
            request(app.clone(), "/status", &query).await,
            StatusCode::CONFLICT
        );
        query.digest = None;
        let workspace = query.workspace_uid.clone();
        query.workspace_uid = Uuid::new_v4().to_string();
        assert_eq!(
            request(app.clone(), "/status", &query).await,
            StatusCode::FORBIDDEN
        );
        query.workspace_uid = workspace;
        query.owner_hash = "b".repeat(64);
        assert_eq!(request(app, "/status", &query).await, StatusCode::FORBIDDEN);
        let expected = format!(
            "SELECT value_utf8 FROM state WHERE service_name='TengriAgentRun' AND service_key='{}' AND key='snapshot' LIMIT 2",
            query.run_id
        );
        assert_eq!(*queries.lock().unwrap(), vec![expected; 4]);
        task.abort();
    }

    #[tokio::test]
    async fn workspace_claims_preserve_collaborator_activity_for_archive_checks() {
        let query = query();
        let own = Claim {
            workspace_uid: query.workspace_uid.clone(),
            owner_hash: query.owner_hash.clone(),
            thread_id: "own-thread".into(),
            run_id: Uuid::new_v4().to_string(),
        };
        let collaborator = Claim {
            owner_hash: "b".repeat(64),
            thread_id: "collaborator-thread".into(),
            run_id: Uuid::new_v4().to_string(),
            ..own.clone()
        };
        let foreign = Claim {
            workspace_uid: Uuid::new_v4().to_string(),
            thread_id: "foreign-workspace".into(),
            ..own.clone()
        };
        let state = BTreeMap::from([
            (own.thread_id.clone(), own.clone()),
            (collaborator.thread_id.clone(), collaborator.clone()),
            (foreign.thread_id.clone(), foreign),
        ]);
        let (backend, _, task) = backend(Some(serde_json::to_value(state).unwrap())).await;
        let claims = backend.claims(&query).await.unwrap();
        assert_eq!(claims.len(), 2);
        assert!(claims.contains(&own));
        assert!(claims.contains(&collaborator));
        task.abort();
    }

    #[tokio::test]
    async fn expired_malformed_and_arbitrary_sql_requests_do_not_reach_storage() {
        let (backend, queries, task) = backend(None).await;
        let app = router(backend);
        let mut query = query();
        query.expires_at_ms = 0;
        assert_eq!(
            request(app.clone(), "/status", &query).await,
            StatusCode::REQUEST_TIMEOUT
        );
        query.expires_at_ms = crate::ofz::now_ms().unwrap() + 2000;
        query.run_id = "' OR true --".into();
        assert_eq!(
            request(app.clone(), "/status", &query).await,
            StatusCode::BAD_REQUEST
        );
        query.run_id = Uuid::new_v4().to_string();
        let mut body = serde_json::to_value(query).unwrap();
        body["query"] = serde_json::json!("DELETE FROM state");
        assert_eq!(
            request(app, "/status", body).await,
            StatusCode::UNPROCESSABLE_ENTITY
        );
        assert!(queries.lock().unwrap().is_empty());
        task.abort();
    }

    #[tokio::test]
    async fn missing_state_distinguishes_an_unknown_run_from_pending_acceptance() {
        let (backend, _, task) = backend(None).await;
        let mut query = query();
        assert_eq!(
            backend.snapshot(&query).await.unwrap_err().code(),
            tonic::Code::NotFound
        );
        query.digest = Some("submitted-input".into());
        assert_eq!(
            backend.snapshot(&query).await.unwrap_err().code(),
            tonic::Code::Unavailable
        );
        assert!(backend.claims(&query).await.unwrap().is_empty());
        task.abort();
    }

    #[tokio::test]
    async fn the_private_client_rejects_invalid_success_responses() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = Client::new(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route("/status", post(|| async { "invalid JSON" })),
            )
            .await
            .unwrap()
        });
        assert_eq!(
            client.status(&query()).await.unwrap_err().code(),
            tonic::Code::Internal
        );
        task.abort();
    }
}
