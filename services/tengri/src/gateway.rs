use std::{collections::HashMap, sync::Arc, time::Duration};

use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{
        Query, State, WebSocketUpgrade,
        ws::{Message as AxumMessage, rejection::WebSocketUpgradeRejection},
    },
    http::{HeaderMap, HeaderName, HeaderValue, Request, Response, StatusCode, header},
    response::IntoResponse,
    routing::{get, post},
};
use futures::{SinkExt, StreamExt};
use kube::{Api, Client, api::ListParams};
use reqwest::redirect::Policy;
use serde::Deserialize;
use tokio::net::TcpStream;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async_with_config,
    tungstenite::{
        Message as TungsteniteMessage, client::IntoClientRequest, protocol::WebSocketConfig,
    },
};

use crate::{
    activity::ActivityTracker,
    crd::MicroVM,
    guest::GuestClient,
    metrics,
    tickets::{PreviewSessionRecord, TicketScope, TicketStore},
};

const MAX_PROXY_BODY: usize = 32 << 20;
const MAX_BOOTSTRAP_BODY: usize = 4 << 10;
const MAX_WEBSOCKET_FRAME: usize = 2 << 20;
const MAX_WEBSOCKET_MESSAGE: usize = 8 << 20;
const MAX_WEBSOCKET_WRITE_BUFFER: usize = 16 << 20;
const READINESS_TIMEOUT: Duration = Duration::from_secs(2);
const PREVIEW_COOKIE: &str = "__Host-tengri_preview";
const PREVIEW_SESSION_LABEL_LENGTH: usize = 24;
const PREVIEW_SESSION_MARKER: &str = "{session}";
const TERMINAL_TICKET_PROTOCOL_PREFIX: &str = "tengri.ticket.";
type UpstreamWebSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;
const PREVIEW_BOOTSTRAP_SCRIPT: &str = r#"(() => {
  const token = decodeURIComponent(window.location.hash.slice(1));
  const target = window.location.pathname + window.location.search;
  history.replaceState(null, '', target);
  if (!token) {
    document.body.textContent = 'Preview session is missing or expired.';
    return;
  }
  fetch('/_tengri/bootstrap', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
    .then((response) => {
      if (!response.ok) throw new Error('preview session rejected');
      window.location.reload();
    })
    .catch(() => {
      document.body.textContent = 'Preview session is missing or expired.';
    });
})();
"#;
const OPEN_PREVIEW_BOOTSTRAP_SCRIPT: &str = r#"(() => {
  const token = decodeURIComponent(window.location.hash.slice(1));
  history.replaceState(null, '', '/v1/preview/open');
  if (!token) {
    document.body.textContent = 'Preview ticket is missing or expired.';
    return;
  }
  fetch('/v1/preview/open', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
    .then(async (response) => {
      if (!response.ok) throw new Error('preview ticket rejected');
      const payload = await response.json();
      if (typeof payload.location !== 'string') throw new Error('preview location missing');
      window.location.replace(payload.location);
    })
    .catch(() => {
      document.body.textContent = 'Preview ticket is missing or expired.';
    });
})();
"#;

#[derive(Clone)]
pub struct GatewayState {
    pub client: Client,
    pub namespace: String,
    pub tickets: TicketStore,
    activity: ActivityTracker,
    http: reqwest::Client,
    preview_origin: PreviewOrigin,
}

#[derive(Clone)]
struct PreviewOrigin {
    desktop_origin: Arc<str>,
    domain: Arc<str>,
    template: Arc<str>,
}

#[derive(Deserialize)]
struct TerminalQuery {
    #[serde(flatten)]
    terminal: HashMap<String, String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviewBootstrapRequest {
    token: String,
}

impl GatewayState {
    pub fn new(
        client: Client,
        namespace: String,
        tickets: TicketStore,
        activity: ActivityTracker,
        preview_url_template: String,
        desktop_origin: String,
    ) -> anyhow::Result<Self> {
        Ok(Self {
            client,
            namespace,
            tickets,
            activity,
            http: reqwest::Client::builder()
                .redirect(Policy::none())
                .build()?,
            preview_origin: PreviewOrigin::parse(preview_url_template, desktop_origin)?,
        })
    }
}

impl PreviewOrigin {
    fn parse(template: String, desktop_origin: String) -> anyhow::Result<Self> {
        let template = template.trim().trim_end_matches('/');
        anyhow::ensure!(
            template.matches(PREVIEW_SESSION_MARKER).count() == 1,
            "TENGRI_PREVIEW_URL_TEMPLATE must contain {PREVIEW_SESSION_MARKER} exactly once"
        );
        let sample = template.replace(PREVIEW_SESSION_MARKER, "sample");
        let sample_url = reqwest::Url::parse(&sample)?;
        let sample_host = sample_url
            .host_str()
            .ok_or_else(|| anyhow::anyhow!("TENGRI_PREVIEW_URL_TEMPLATE must contain a host"))?;
        let domain = sample_host
            .strip_prefix("tengri-sample.")
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "TENGRI_PREVIEW_URL_TEMPLATE host must be tengri-{PREVIEW_SESSION_MARKER}.<domain>"
                )
            })?;
        anyhow::ensure!(
            sample_url.scheme() == "https"
                || (sample_url.scheme() == "http"
                    && (domain == "localhost" || domain.ends_with(".localhost"))),
            "TENGRI_PREVIEW_URL_TEMPLATE must use HTTPS outside localhost"
        );
        anyhow::ensure!(
            sample_url.path() == "/"
                && sample_url.query().is_none()
                && sample_url.fragment().is_none()
                && sample_url.username().is_empty()
                && sample_url.password().is_none(),
            "TENGRI_PREVIEW_URL_TEMPLATE must be an origin without credentials, path, query, or fragment"
        );

        let desktop_origin = desktop_origin.trim().trim_end_matches('/');
        let desktop_url = reqwest::Url::parse(desktop_origin)?;
        let desktop_host = desktop_url
            .host_str()
            .ok_or_else(|| anyhow::anyhow!("TENGRI_DESKTOP_ORIGIN must contain a host"))?;
        anyhow::ensure!(
            desktop_url.scheme() == "https"
                || (desktop_url.scheme() == "http"
                    && (desktop_host == "localhost" || desktop_host.ends_with(".localhost"))),
            "TENGRI_DESKTOP_ORIGIN must use HTTPS outside localhost"
        );
        anyhow::ensure!(
            desktop_url.path() == "/"
                && desktop_url.query().is_none()
                && desktop_url.fragment().is_none()
                && desktop_url.username().is_empty()
                && desktop_url.password().is_none(),
            "TENGRI_DESKTOP_ORIGIN must be an origin without credentials, path, query, or fragment"
        );

        Ok(Self {
            desktop_origin: Arc::from(desktop_origin.to_owned()),
            domain: Arc::from(domain.to_owned()),
            template: Arc::from(template.to_owned()),
        })
    }

    fn origin(&self, session_id: &str) -> String {
        self.template.replace(PREVIEW_SESSION_MARKER, session_id)
    }

    fn session_id(&self, authority: &str) -> Option<String> {
        let url = reqwest::Url::parse(&format!("http://{authority}")).ok()?;
        let host = url.host_str()?;
        let label = host
            .strip_suffix(self.domain.as_ref())?
            .strip_suffix('.')?
            .strip_prefix("tengri-")?;
        (label.len() == PREVIEW_SESSION_LABEL_LENGTH
            && label
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit()))
        .then(|| label.to_owned())
    }
}

pub fn router(state: GatewayState) -> Router {
    Router::new()
        .route("/livez", get(|| async { StatusCode::NO_CONTENT }))
        .route("/readyz", get(readiness))
        .route("/healthz", get(readiness))
        .route("/metrics", get(export_metrics))
        .route("/v1/terminal/ws", get(terminal_websocket))
        .route(
            "/v1/preview/open",
            get(open_preview_bootstrap).post(open_preview),
        )
        .route(
            "/_tengri/open-preview.js",
            get(serve_open_preview_bootstrap_script),
        )
        .route("/_tengri/bootstrap", post(preview_bootstrap))
        .route("/_tengri/bootstrap.js", get(serve_preview_bootstrap_script))
        .fallback(preview_host_proxy)
        .with_state(state)
}

async fn readiness(State(state): State<GatewayState>) -> StatusCode {
    if state.tickets.stats().is_err() {
        return StatusCode::SERVICE_UNAVAILABLE;
    }

    let agents: Api<MicroVM> = Api::namespaced(state.client, &state.namespace);
    match tokio::time::timeout(
        READINESS_TIMEOUT,
        agents.list(&ListParams::default().limit(1)),
    )
    .await
    {
        Ok(Ok(_)) => StatusCode::NO_CONTENT,
        Ok(Err(_)) | Err(_) => StatusCode::SERVICE_UNAVAILABLE,
    }
}

async fn export_metrics(State(state): State<GatewayState>) -> impl IntoResponse {
    let agents: Api<MicroVM> = Api::namespaced(state.client.clone(), &state.namespace);
    let agents = match agents.list(&ListParams::default()).await {
        Ok(agents) => agents.items,
        Err(_) => return (StatusCode::SERVICE_UNAVAILABLE, "metrics unavailable").into_response(),
    };
    let tickets = match state.tickets.stats() {
        Ok(stats) => stats,
        Err(_) => return (StatusCode::SERVICE_UNAVAILABLE, "metrics unavailable").into_response(),
    };
    (
        StatusCode::OK,
        [(
            header::CONTENT_TYPE,
            "text/plain; version=0.0.4; charset=utf-8",
        )],
        metrics::global().render(&agents, tickets),
    )
        .into_response()
}

async fn terminal_websocket(
    State(state): State<GatewayState>,
    Query(query): Query<TerminalQuery>,
    headers: HeaderMap,
    websocket: WebSocketUpgrade,
) -> impl IntoResponse {
    let Some((protocol, token)) = terminal_ticket_protocol(&headers) else {
        return (StatusCode::UNAUTHORIZED, "terminal ticket is required").into_response();
    };
    let ticket = match state.tickets.consume(&token) {
        Ok(ticket) => ticket,
        Err(error) => return status_response(error.code(), error.message()),
    };
    let TicketScope::Terminal { terminal_id } = ticket.scope else {
        return status_response(
            tonic::Code::PermissionDenied,
            "ticket is not scoped to a terminal",
        );
    };
    state.activity.touch(&ticket.agent_id);
    let guest = match GuestClient::for_agent(state.client, &state.namespace, &ticket.agent_id).await
    {
        Ok(guest) => guest,
        Err(error) => return (StatusCode::SERVICE_UNAVAILABLE, error.to_string()).into_response(),
    };
    let terminal_query = query
        .terminal
        .into_iter()
        .filter(|(name, _)| matches!(name.as_str(), "reconnect" | "since" | "cols" | "rows"))
        .collect::<Vec<_>>();
    let query = serde_urlencoded::to_string(terminal_query).unwrap_or_default();
    let url = format!(
        "ws://{}/v1/terminals/{terminal_id}/ws{}{}",
        guest.base_url().trim_start_matches("http://"),
        if query.is_empty() { "" } else { "?" },
        query,
    );
    let activity = state.activity;
    let agent_id = ticket.agent_id;
    websocket
        .max_frame_size(MAX_WEBSOCKET_FRAME)
        .max_message_size(MAX_WEBSOCKET_MESSAGE)
        .max_write_buffer_size(MAX_WEBSOCKET_WRITE_BUFFER)
        .protocols([protocol])
        .on_upgrade(move |socket| {
            bridge_websocket(socket, url, guest.token().to_owned(), activity, agent_id)
        })
        .into_response()
}

async fn open_preview(
    State(state): State<GatewayState>,
    request: Request<Body>,
) -> impl IntoResponse {
    let body = match to_bytes(request.into_body(), MAX_BOOTSTRAP_BODY).await {
        Ok(body) => body,
        Err(_) => return (StatusCode::BAD_REQUEST, "invalid preview ticket").into_response(),
    };
    let input: PreviewBootstrapRequest = match serde_json::from_slice(&body) {
        Ok(input) => input,
        Err(_) => return (StatusCode::BAD_REQUEST, "invalid preview ticket").into_response(),
    };
    let ticket = match state.tickets.consume(&input.token) {
        Ok(ticket) => ticket,
        Err(error) => return status_response(error.code(), error.message()),
    };
    let session = match state.tickets.create_preview_session(ticket) {
        Ok(session) => session,
        Err(error) => return status_response(error.code(), error.message()),
    };
    let location = preview_launch_location(
        &state.preview_origin,
        &session.id,
        &session.token,
        &session.initial_path,
    );
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json".to_owned()),
            (header::CACHE_CONTROL, "no-store".to_owned()),
            (
                HeaderName::from_static("referrer-policy"),
                "no-referrer".to_owned(),
            ),
        ],
        serde_json::json!({"location": location}).to_string(),
    )
        .into_response()
}

async fn open_preview_bootstrap(State(state): State<GatewayState>) -> axum::response::Response {
    preview_script_document(
        &state.preview_origin.desktop_origin,
        "/_tengri/open-preview.js",
        "Tengri Preview",
    )
}

async fn serve_open_preview_bootstrap_script() -> axum::response::Response {
    script_response(OPEN_PREVIEW_BOOTSTRAP_SCRIPT)
}

fn terminal_ticket_protocol(headers: &HeaderMap) -> Option<(String, String)> {
    headers
        .get(header::SEC_WEBSOCKET_PROTOCOL)?
        .to_str()
        .ok()?
        .split(',')
        .map(str::trim)
        .find_map(|protocol| {
            let token = protocol.strip_prefix(TERMINAL_TICKET_PROTOCOL_PREFIX)?;
            (!token.is_empty()).then(|| (protocol.to_owned(), token.to_owned()))
        })
}

async fn preview_bootstrap(
    State(state): State<GatewayState>,
    request: Request<Body>,
) -> impl IntoResponse {
    let Some(authority) = request_authority(&request) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(session_id) = state.preview_origin.session_id(&authority) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let body = match to_bytes(request.into_body(), MAX_BOOTSTRAP_BODY).await {
        Ok(body) => body,
        Err(_) => return (StatusCode::BAD_REQUEST, "invalid preview bootstrap").into_response(),
    };
    let input: PreviewBootstrapRequest = match serde_json::from_slice(&body) {
        Ok(input) => input,
        Err(_) => return (StatusCode::BAD_REQUEST, "invalid preview bootstrap").into_response(),
    };
    let session = match state.tickets.preview_session(&session_id, &input.token) {
        Ok(session) => session,
        Err(error) => return status_response(error.code(), error.message()),
    };
    state.activity.touch(&session.agent_id);
    let cookie = format!(
        "{PREVIEW_COOKIE}={}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=1800",
        session.token,
    );
    (
        StatusCode::NO_CONTENT,
        [
            (header::SET_COOKIE, cookie),
            (header::CACHE_CONTROL, "no-store".to_owned()),
            (
                HeaderName::from_static("referrer-policy"),
                "no-referrer".to_owned(),
            ),
        ],
    )
        .into_response()
}

async fn serve_preview_bootstrap_script(
    State(state): State<GatewayState>,
    request: Request<Body>,
) -> axum::response::Response {
    let Some(authority) = request_authority(&request) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if state.preview_origin.session_id(&authority).is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
    script_response(PREVIEW_BOOTSTRAP_SCRIPT)
}

fn script_response(script: &'static str) -> axum::response::Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/javascript; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header("Referrer-Policy", "no-referrer")
        .header("X-Content-Type-Options", "nosniff")
        .body(Body::from(script))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn preview_host_proxy(
    State(state): State<GatewayState>,
    websocket: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
    request: Request<Body>,
) -> axum::response::Response {
    let Some(authority) = request_authority(&request) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(session_id) = state.preview_origin.session_id(&authority) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let websocket = websocket.ok();
    let cookie = request
        .headers()
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| cookie_value(value, PREVIEW_COOKIE))
        .unwrap_or_default();
    if cookie.is_empty() {
        if request.method() == http::Method::GET && websocket.is_none() {
            return preview_bootstrap_document(&state.preview_origin.desktop_origin);
        }
        return (
            StatusCode::UNAUTHORIZED,
            "preview session is not initialized",
        )
            .into_response();
    }
    let session = match state.tickets.preview_session(&session_id, &cookie) {
        Ok(session) => session,
        Err(error) => return status_response(error.code(), error.message()),
    };
    state.activity.touch(&session.agent_id);
    let guest =
        match GuestClient::for_agent(state.client.clone(), &state.namespace, &session.agent_id)
            .await
        {
            Ok(guest) => guest,
            Err(error) => {
                return (StatusCode::SERVICE_UNAVAILABLE, error.to_string()).into_response();
            }
        };
    let path = request.uri().path();
    let query = request
        .uri()
        .query()
        .map(|value| format!("?{value}"))
        .unwrap_or_default();
    let target = format!(
        "{}/v1/preview/{}{}{}",
        guest.base_url(),
        session.port,
        path,
        query,
    );
    if let Some(websocket) = websocket {
        let websocket_target = target.replacen("http://", "ws://", 1);
        let token = guest.token().to_owned();
        let activity = state.activity;
        let agent_id = session.agent_id;
        let (upstream, selected_protocol) =
            match connect_upstream_websocket(&websocket_target, &token, Some(request.headers()))
                .await
            {
                Ok(connection) => connection,
                Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
            };
        let websocket = websocket
            .max_frame_size(MAX_WEBSOCKET_FRAME)
            .max_message_size(MAX_WEBSOCKET_MESSAGE)
            .max_write_buffer_size(MAX_WEBSOCKET_WRITE_BUFFER);
        let websocket = if let Some(protocol) = selected_protocol {
            websocket.protocols([protocol])
        } else {
            websocket
        };
        return websocket
            .on_upgrade(move |socket| bridge_open_websocket(socket, upstream, activity, agent_id))
            .into_response();
    }
    proxy_http(state, session, guest, target, request).await
}

fn preview_bootstrap_document(desktop_origin: &str) -> axum::response::Response {
    preview_script_document(desktop_origin, "/_tengri/bootstrap.js", "Tengri Preview")
}

fn preview_script_document(
    desktop_origin: &str,
    script_path: &str,
    title: &str,
) -> axum::response::Response {
    let policy = format!(
        "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors {desktop_origin}"
    );
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header("Content-Security-Policy", policy)
        .header("Referrer-Policy", "no-referrer")
        .header("X-Content-Type-Options", "nosniff")
        .body(Body::from(format!(
            "<!doctype html><meta charset=\"utf-8\"><title>{title}</title><script src=\"{script_path}\" defer></script>",
        )))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn request_authority(request: &Request<Body>) -> Option<String> {
    request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

fn preview_launch_location(
    preview_origin: &PreviewOrigin,
    session_id: &str,
    token: &str,
    initial_path: &str,
) -> String {
    format!(
        "{}{initial_path}#{token}",
        preview_origin.origin(session_id)
    )
}

async fn proxy_http(
    state: GatewayState,
    session: PreviewSessionRecord,
    guest: GuestClient,
    target: String,
    request: Request<Body>,
) -> axum::response::Response {
    let (parts, body) = request.into_parts();
    let body = match to_bytes(body, MAX_PROXY_BODY).await {
        Ok(body) => body,
        Err(_) => {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                "preview request body is too large",
            )
                .into_response();
        }
    };
    let mut upstream = state
        .http
        .request(parts.method, target)
        .bearer_auth(guest.token());
    for (name, value) in &parts.headers {
        if forward_request_header(name) {
            if name == header::COOKIE {
                if let Ok(value) = value.to_str() {
                    let cookies = strip_cookie(value, PREVIEW_COOKIE);
                    if !cookies.is_empty() {
                        upstream = upstream.header(name, cookies);
                    }
                }
            } else {
                upstream = upstream.header(name, value);
            }
        }
    }
    if !body.is_empty() {
        upstream = upstream.body(body);
    }
    let upstream = match upstream.send().await {
        Ok(response) => response,
        Err(_) => {
            return (
                StatusCode::BAD_GATEWAY,
                "preview application is unavailable",
            )
                .into_response();
        }
    };
    let status = upstream.status();
    let headers = upstream.headers().clone();
    let stream = upstream.bytes_stream();
    let preview_origin = state.preview_origin.origin(&session.id);
    let default_frame_policy =
        default_preview_frame_policy(&headers, &state.preview_origin.desktop_origin);
    let mut response = Response::builder().status(status);
    for (name, value) in &headers {
        if forward_response_header(name) {
            if name == header::SET_COOKIE {
                if let Ok(value) = value.to_str()
                    && let Some(rewritten) = rewrite_guest_cookie(value)
                    && let Ok(value) = HeaderValue::from_str(&rewritten)
                {
                    response = response.header(name, value);
                }
            } else if name == header::LOCATION {
                if let Ok(value) = value.to_str() {
                    let rewritten = rewrite_preview_location(value, session.port, &preview_origin);
                    if let Ok(value) = HeaderValue::from_str(&rewritten) {
                        response = response.header(name, value);
                    }
                }
            } else if name == HeaderName::from_static("content-security-policy") {
                if let Ok(value) = value.to_str() {
                    let rewritten =
                        rewrite_frame_ancestors(value, &state.preview_origin.desktop_origin);
                    if let Ok(value) = HeaderValue::from_str(&rewritten) {
                        response = response.header(name, value);
                    }
                }
            } else {
                response = response.header(name, value);
            }
        }
    }
    if let Some(policy) = default_frame_policy {
        response = response.header(header::CONTENT_SECURITY_POLICY, policy);
    }
    response = response.header(header::CACHE_CONTROL, "no-store");
    response
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
}

async fn bridge_websocket(
    mut browser: axum::extract::ws::WebSocket,
    target: String,
    token: String,
    activity: ActivityTracker,
    agent_id: String,
) {
    activity.touch(&agent_id);
    let Ok((upstream, _)) = connect_upstream_websocket(&target, &token, None).await else {
        let _ = browser.send(AxumMessage::Close(None)).await;
        return;
    };
    bridge_open_websocket(browser, upstream, activity, agent_id).await;
}

async fn connect_upstream_websocket(
    target: &str,
    token: &str,
    forwarded_headers: Option<&HeaderMap>,
) -> Result<(UpstreamWebSocket, Option<String>), ()> {
    let request = upstream_websocket_request(target, token, forwarded_headers)?;
    let requested_protocols = websocket_protocols(request.headers())?;
    let config = WebSocketConfig::default()
        .max_frame_size(Some(MAX_WEBSOCKET_FRAME))
        .max_message_size(Some(MAX_WEBSOCKET_MESSAGE))
        .max_write_buffer_size(MAX_WEBSOCKET_WRITE_BUFFER);
    let (upstream, response) = connect_async_with_config(request, Some(config), false)
        .await
        .map_err(|_| ())?;
    let selected_protocol = selected_websocket_protocol(response.headers(), &requested_protocols)?;
    Ok((upstream, selected_protocol))
}

async fn bridge_open_websocket(
    mut browser: axum::extract::ws::WebSocket,
    upstream: UpstreamWebSocket,
    activity: ActivityTracker,
    agent_id: String,
) {
    let (mut upstream_write, mut upstream_read) = upstream.split();
    loop {
        tokio::select! {
            browser_message = browser.recv() => {
                let Some(Ok(message)) = browser_message else { break };
                let message = match message {
                    AxumMessage::Text(value) => TungsteniteMessage::Text(value.to_string().into()),
                    AxumMessage::Binary(value) => TungsteniteMessage::Binary(value),
                    AxumMessage::Ping(value) => TungsteniteMessage::Ping(value),
                    AxumMessage::Pong(value) => TungsteniteMessage::Pong(value),
                    AxumMessage::Close(_) => TungsteniteMessage::Close(None),
                };
                activity.touch(&agent_id);
                if upstream_write.send(message).await.is_err() { break; }
            }
            upstream_message = upstream_read.next() => {
                let Some(Ok(message)) = upstream_message else { break };
                let message = match message {
                    TungsteniteMessage::Text(value) => AxumMessage::Text(value.to_string().into()),
                    TungsteniteMessage::Binary(value) => AxumMessage::Binary(value),
                    TungsteniteMessage::Ping(value) => AxumMessage::Ping(value),
                    TungsteniteMessage::Pong(value) => AxumMessage::Pong(value),
                    TungsteniteMessage::Close(_) => AxumMessage::Close(None),
                    TungsteniteMessage::Frame(_) => continue,
                };
                activity.touch(&agent_id);
                if browser.send(message).await.is_err() { break; }
            }
        }
    }
}

fn upstream_websocket_request(
    target: &str,
    token: &str,
    forwarded_headers: Option<&HeaderMap>,
) -> Result<http::Request<()>, ()> {
    let mut request = target.into_client_request().map_err(|_| ())?;
    let authorization = HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| ())?;
    request
        .headers_mut()
        .insert(header::AUTHORIZATION, authorization);
    if let Some(headers) = forwarded_headers {
        if let Some(origin) = headers.get(header::ORIGIN) {
            request.headers_mut().insert(header::ORIGIN, origin.clone());
        }
        if let Some(cookies) = headers
            .get(header::COOKIE)
            .and_then(|value| value.to_str().ok())
        {
            let cookies = strip_cookie(cookies, PREVIEW_COOKIE);
            if !cookies.is_empty() {
                request.headers_mut().insert(
                    header::COOKIE,
                    HeaderValue::from_str(&cookies).map_err(|_| ())?,
                );
            }
        }
        let protocols = websocket_protocols(headers)?;
        if !protocols.is_empty() {
            request.headers_mut().insert(
                header::SEC_WEBSOCKET_PROTOCOL,
                HeaderValue::from_str(&protocols.join(", ")).map_err(|_| ())?,
            );
        }
    }
    Ok(request)
}

fn websocket_protocols(headers: &HeaderMap) -> Result<Vec<String>, ()> {
    let mut protocols = Vec::new();
    for value in headers.get_all(header::SEC_WEBSOCKET_PROTOCOL) {
        for protocol in value.to_str().map_err(|_| ())?.split(',').map(str::trim) {
            if protocol.is_empty()
                || protocol.len() > 128
                || !protocol
                    .bytes()
                    .all(|byte| byte.is_ascii_graphic() && byte != b',')
            {
                return Err(());
            }
            protocols.push(protocol.to_owned());
        }
    }
    Ok(protocols)
}

fn selected_websocket_protocol(
    headers: &HeaderMap,
    requested_protocols: &[String],
) -> Result<Option<String>, ()> {
    let Some(selected) = headers.get(header::SEC_WEBSOCKET_PROTOCOL) else {
        return Ok(None);
    };
    let selected = selected.to_str().map_err(|_| ())?.trim();
    requested_protocols
        .iter()
        .any(|protocol| protocol == selected)
        .then(|| selected.to_owned())
        .map(Some)
        .ok_or(())
}

fn status_response(code: tonic::Code, message: &str) -> axum::response::Response {
    let status = match code {
        tonic::Code::Unauthenticated => StatusCode::UNAUTHORIZED,
        tonic::Code::PermissionDenied => StatusCode::FORBIDDEN,
        tonic::Code::NotFound => StatusCode::NOT_FOUND,
        tonic::Code::ResourceExhausted => StatusCode::TOO_MANY_REQUESTS,
        _ => StatusCode::BAD_REQUEST,
    };
    (status, message.to_owned()).into_response()
}

fn cookie_value(cookies: &str, name: &str) -> Option<String> {
    cookies.split(';').find_map(|cookie| {
        let (key, value) = cookie.trim().split_once('=')?;
        (key == name).then(|| value.to_owned())
    })
}

fn strip_cookie(cookies: &str, name: &str) -> String {
    cookies
        .split(';')
        .filter(|cookie| {
            cookie
                .trim()
                .split_once('=')
                .is_none_or(|(key, _)| key != name)
        })
        .map(str::trim)
        .collect::<Vec<_>>()
        .join("; ")
}

fn rewrite_guest_cookie(cookie: &str) -> Option<String> {
    let parts = cookie
        .split(';')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let cookie_name = parts.first()?.split_once('=')?.0.trim();
    if cookie_name.eq_ignore_ascii_case(PREVIEW_COOKIE) {
        return None;
    }
    Some(
        parts
            .into_iter()
            .filter(|part| !part.to_ascii_lowercase().starts_with("domain="))
            .collect::<Vec<_>>()
            .join("; "),
    )
}

fn rewrite_preview_location(location: &str, port: u16, preview_origin: &str) -> String {
    let absolute_location = location
        .strip_prefix("//")
        .map(|location| format!("http://{location}"));
    let location_to_parse = absolute_location.as_deref().unwrap_or(location);
    let Ok(upstream) = reqwest::Url::parse(location_to_parse) else {
        return location.to_owned();
    };
    let loopback = matches!(upstream.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if !loopback || upstream.port_or_known_default() != Some(port) {
        return location.to_owned();
    }
    let Ok(mut rewritten) = reqwest::Url::parse(preview_origin) else {
        return location.to_owned();
    };
    rewritten.set_path(upstream.path());
    rewritten.set_query(upstream.query());
    rewritten.set_fragment(upstream.fragment());
    rewritten.to_string()
}

fn rewrite_frame_ancestors(policy: &str, desktop_origin: &str) -> String {
    let mut directives = policy
        .split(';')
        .map(str::trim)
        .filter(|directive| {
            !directive.is_empty()
                && !directive
                    .to_ascii_lowercase()
                    .starts_with("frame-ancestors")
        })
        .map(str::to_owned)
        .collect::<Vec<_>>();
    directives.push(format!("frame-ancestors {desktop_origin}"));
    directives.join("; ")
}

fn default_preview_frame_policy(headers: &HeaderMap, desktop_origin: &str) -> Option<String> {
    (!headers.contains_key(header::CONTENT_SECURITY_POLICY))
        .then(|| format!("frame-ancestors {desktop_origin}"))
}

fn forward_request_header(name: &HeaderName) -> bool {
    !matches!(
        name.as_str().to_ascii_lowercase().as_str(),
        "authorization"
            | "connection"
            | "host"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "x-forwarded-for"
            | "x-forwarded-host"
            | "x-forwarded-proto"
    )
}

fn forward_response_header(name: &HeaderName) -> bool {
    !matches!(
        name.as_str().to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "x-frame-options"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use kube::client::Body as KubeBody;

    fn test_gateway_state(client: Client) -> GatewayState {
        let tickets = TicketStore::new(
            "https://tengri.proompteng.ai".to_owned(),
            "ticket-signing-secret-that-is-at-least-32-bytes".to_owned(),
        )
        .expect("ticket store");
        GatewayState::new(
            client.clone(),
            "tengri".to_owned(),
            tickets,
            ActivityTracker::new(client, "tengri".to_owned()),
            "https://tengri-{session}.proompteng.ai".to_owned(),
            "https://proompteng.ai".to_owned(),
        )
        .expect("gateway state")
    }

    async fn readiness_for_kubernetes_response(status: StatusCode, body: &str) -> StatusCode {
        let (service, mut handle) =
            tower_test::mock::pair::<Request<KubeBody>, Response<KubeBody>>();
        let state = test_gateway_state(Client::new(service, "tengri"));
        let readiness = tokio::spawn(readiness(State(state)));
        let (request, response) = handle.next_request().await.expect("readiness request");
        assert_eq!(
            request.uri().path(),
            "/apis/runtime.proompteng.ai/v1alpha1/namespaces/tengri/microvms"
        );
        response.send_response(
            Response::builder()
                .status(status)
                .header(header::CONTENT_TYPE, "application/json")
                .body(KubeBody::from(body.as_bytes().to_vec()))
                .expect("Kubernetes response"),
        );
        readiness.await.expect("readiness task")
    }

    #[tokio::test]
    async fn readiness_requires_a_working_kubernetes_control_path() {
        let ready = readiness_for_kubernetes_response(
            StatusCode::OK,
            r#"{"apiVersion":"runtime.proompteng.ai/v1alpha1","kind":"MicroVMList","metadata":{},"items":[]}"#,
        )
        .await;
        assert_eq!(ready, StatusCode::NO_CONTENT);

        let unavailable = readiness_for_kubernetes_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            r#"{"apiVersion":"v1","kind":"Status","status":"Failure","message":"unavailable","reason":"InternalError","code":500}"#,
        )
        .await;
        assert_eq!(unavailable, StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn preview_cookie_is_not_forwarded_to_guest_app() {
        let cookies = format!("theme=dark; {PREVIEW_COOKIE}=secret; app=value");
        assert_eq!(
            strip_cookie(&cookies, PREVIEW_COOKIE),
            "theme=dark; app=value"
        );
    }

    #[test]
    fn terminal_ticket_uses_websocket_protocol_instead_of_request_target() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_static("other, tengri.ticket.nonce.signature"),
        );
        assert_eq!(
            terminal_ticket_protocol(&headers),
            Some((
                "tengri.ticket.nonce.signature".to_owned(),
                "nonce.signature".to_owned(),
            ))
        );
    }

    #[test]
    fn guest_websocket_request_contains_a_complete_client_handshake() {
        let request =
            upstream_websocket_request("ws://127.0.0.1:8080/terminal", "guest-token", None)
                .expect("websocket request");

        assert_eq!(
            request.headers().get(header::HOST).unwrap(),
            "127.0.0.1:8080"
        );
        assert_eq!(request.headers().get(header::UPGRADE).unwrap(), "websocket");
        assert_eq!(
            request.headers().get(header::CONNECTION).unwrap(),
            "Upgrade"
        );
        assert_eq!(
            request
                .headers()
                .get(header::SEC_WEBSOCKET_VERSION)
                .unwrap(),
            "13"
        );
        assert!(request.headers().contains_key(header::SEC_WEBSOCKET_KEY));
        assert_eq!(
            request.headers().get(header::AUTHORIZATION).unwrap(),
            "Bearer guest-token"
        );
    }

    #[test]
    fn preview_websocket_preserves_sanitized_application_handshake_headers() {
        let mut browser_headers = HeaderMap::new();
        browser_headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://tengri-session.proompteng.ai"),
        );
        browser_headers.insert(
            header::COOKIE,
            HeaderValue::from_static("app=session; __Host-tengri_preview=secret"),
        );
        browser_headers.insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_static("vite-hmr, app-v1"),
        );

        let request = upstream_websocket_request(
            "ws://127.0.0.1:8080/v1/preview/3000/ws",
            "guest-token",
            Some(&browser_headers),
        )
        .expect("websocket request");

        assert_eq!(
            request.headers().get(header::ORIGIN).unwrap(),
            "https://tengri-session.proompteng.ai"
        );
        assert_eq!(
            request.headers().get(header::COOKIE).unwrap(),
            "app=session"
        );
        assert_eq!(
            request
                .headers()
                .get(header::SEC_WEBSOCKET_PROTOCOL)
                .unwrap(),
            "vite-hmr, app-v1"
        );
        assert_eq!(
            request.headers().get(header::AUTHORIZATION).unwrap(),
            "Bearer guest-token"
        );

        let mut response_headers = HeaderMap::new();
        response_headers.insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_static("app-v1"),
        );
        assert_eq!(
            selected_websocket_protocol(
                &response_headers,
                &["vite-hmr".to_owned(), "app-v1".to_owned()],
            ),
            Ok(Some("app-v1".to_owned()))
        );
        assert!(selected_websocket_protocol(&response_headers, &["other".to_owned()]).is_err());
    }

    #[test]
    fn guest_cookie_is_host_only_and_cannot_replace_preview_session() {
        assert_eq!(
            rewrite_guest_cookie("session=abc; Domain=.proompteng.ai; Path=/app; HttpOnly"),
            Some("session=abc; Path=/app; HttpOnly".to_owned())
        );
        assert_eq!(
            rewrite_guest_cookie(&format!("{PREVIEW_COOKIE}=attacker; Path=/")),
            None
        );
    }

    #[test]
    fn preview_origins_preserve_root_relative_assets_and_hide_tokens_in_fragments() {
        let origin = PreviewOrigin::parse(
            "https://tengri-{session}.proompteng.ai".to_owned(),
            "https://proompteng.ai".to_owned(),
        )
        .expect("preview origin");
        let session_id = "a1b2c3d4e5f6a1b2c3d4e5f6";
        assert_eq!(
            origin.session_id(&format!("tengri-{session_id}.proompteng.ai:443")),
            Some(session_id.to_owned())
        );
        let launch =
            preview_launch_location(&origin, session_id, "secret.ticket", "/dashboard?mode=dev");
        let parsed = reqwest::Url::parse(&launch).expect("launch URL");
        assert_eq!(
            parsed.origin().ascii_serialization(),
            origin.origin(session_id)
        );
        assert_eq!(parsed.path(), "/dashboard");
        assert_eq!(parsed.query(), Some("mode=dev"));
        assert_eq!(parsed.fragment(), Some("secret.ticket"));
    }

    #[test]
    fn preview_rewrites_loopback_redirects_and_frame_ancestors() {
        assert_eq!(
            rewrite_preview_location(
                "http://localhost:3000/dashboard?mode=dev#ready",
                3000,
                "https://tengri-session.proompteng.ai",
            ),
            "https://tengri-session.proompteng.ai/dashboard?mode=dev#ready"
        );
        assert_eq!(
            rewrite_preview_location(
                "//127.0.0.1:3000/assets",
                3000,
                "https://tengri-session.proompteng.ai",
            ),
            "https://tengri-session.proompteng.ai/assets"
        );
        assert_eq!(
            rewrite_frame_ancestors(
                "default-src 'self'; frame-ancestors 'none'; script-src 'self'",
                "https://proompteng.ai",
            ),
            "default-src 'self'; script-src 'self'; frame-ancestors https://proompteng.ai"
        );
    }

    #[test]
    fn preview_frame_policy_is_safe_when_guest_has_no_policy() {
        let mut headers = HeaderMap::new();
        assert_eq!(
            default_preview_frame_policy(&headers, "https://proompteng.ai"),
            Some("frame-ancestors https://proompteng.ai".to_owned()),
        );
        headers.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("default-src 'self'"),
        );
        assert_eq!(
            default_preview_frame_policy(&headers, "https://proompteng.ai"),
            None,
        );
    }
}
