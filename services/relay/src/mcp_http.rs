use futures::{StreamExt, stream::BoxStream};
use http::{HeaderName, HeaderValue};
use rmcp::{
    model::{ClientJsonRpcMessage, ServerJsonRpcMessage},
    transport::streamable_http_client::{
        HttpStatusError, StreamableHttpClient, StreamableHttpError, StreamableHttpPostResponse,
    },
};
use std::{collections::HashMap, io, sync::Arc};
use tonic::Status;

#[derive(Clone)]
pub(crate) struct Client(reqwest::Client);
type Error = StreamableHttpError<io::Error>;
type Events = BoxStream<'static, Result<sse_stream::Sse, sse_stream::Error>>;

fn invalid(message: &'static str) -> Error {
    StreamableHttpError::Io(io::Error::other(message))
}

impl Client {
    pub(crate) fn new(ca: Option<&str>) -> Result<Self, Status> {
        crate::http::client(ca)
            .map(Self)
            .map_err(|_| Status::unavailable("upstream MCP TLS configuration is invalid"))
    }
    fn request(
        &self,
        method: reqwest::Method,
        uri: &str,
        session: Option<&str>,
        token: Option<&str>,
        headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<reqwest::RequestBuilder, Error> {
        let mut request = self.0.request(method, uri);
        for (name, value) in headers {
            if matches!(
                name.as_str(),
                "host"
                    | "authorization"
                    | "proxy-authorization"
                    | "cookie"
                    | "content-length"
                    | "transfer-encoding"
                    | "connection"
                    | "upgrade"
                    | "accept"
                    | "content-type"
                    | "mcp-session-id"
                    | "forwarded"
                    | "x-forwarded-host"
            ) {
                return Err(StreamableHttpError::ReservedHeaderConflict(
                    name.to_string(),
                ));
            }
            request = request.header(name, value);
        }
        if let Some(session) = session {
            request = request.header("mcp-session-id", session);
        }
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        Ok(request)
    }
    fn status(response: &reqwest::Response) -> Result<(), Error> {
        if response.status().is_success() {
            Ok(())
        } else {
            Err(HttpStatusError::new(response.status().as_u16(), None).into())
        }
    }
    async fn body(response: reqwest::Response) -> Result<Vec<u8>, Error> {
        if response
            .content_length()
            .is_some_and(|length| length > 262_144)
        {
            return Err(invalid("MCP response exceeds its byte budget"));
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| invalid("MCP response interrupted"))?;
            if bytes.len() + chunk.len() > 262_144 {
                return Err(invalid("MCP response exceeds its byte budget"));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
    fn events(response: reqwest::Response) -> Events {
        let mut received = 0;
        let stream = response.bytes_stream().map(move |chunk| {
            let bytes = chunk.map_err(|_| io::Error::other("MCP event stream interrupted"))?;
            received += bytes.len();
            if received > 262_144 {
                return Err(io::Error::other("MCP event stream exceeds its byte budget"));
            }
            Ok(bytes)
        });
        sse_stream::SseStream::from_bytes_stream(stream).boxed()
    }
}

impl StreamableHttpClient for Client {
    type Error = io::Error;
    async fn post_message(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session: Option<Arc<str>>,
        token: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<StreamableHttpPostResponse, Error> {
        let response = self
            .request(
                reqwest::Method::POST,
                &uri,
                session.as_deref(),
                token.as_deref(),
                headers,
            )?
            .header(
                reqwest::header::ACCEPT,
                "application/json, text/event-stream",
            )
            .json(&message)
            .send()
            .await
            .map_err(|_| invalid("MCP request failed"))?;
        if response.status() == reqwest::StatusCode::NOT_FOUND && session.is_some() {
            return Err(StreamableHttpError::SessionExpired);
        }
        Self::status(&response)?;
        if matches!(
            response.status(),
            reqwest::StatusCode::ACCEPTED | reqwest::StatusCode::NO_CONTENT
        ) {
            return Ok(StreamableHttpPostResponse::Accepted);
        }
        let session = response
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .filter(|v| v.len() <= 1024)
            .map(str::to_owned);
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if content_type.starts_with("text/event-stream") {
            return Ok(StreamableHttpPostResponse::Sse(
                Self::events(response),
                session,
            ));
        }
        if !content_type.starts_with("application/json") {
            return Err(invalid("MCP response has an invalid content type"));
        }
        let body = Self::body(response).await?;
        // Notifications may acknowledge with an empty body; requests always require a correlated result.
        if body.is_empty() && !matches!(message, ClientJsonRpcMessage::Request(_)) {
            return Ok(StreamableHttpPostResponse::Accepted);
        }
        let message: ServerJsonRpcMessage = serde_json::from_slice(&body)?;
        Ok(StreamableHttpPostResponse::Json(message, session))
    }
    async fn get_stream(
        &self,
        uri: Arc<str>,
        session: Option<Arc<str>>,
        last_event_id: Option<String>,
        token: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<Events, Error> {
        let mut request = self
            .request(
                reqwest::Method::GET,
                &uri,
                session.as_deref(),
                token.as_deref(),
                headers,
            )?
            .header(reqwest::header::ACCEPT, "text/event-stream");
        if let Some(id) = last_event_id {
            request = request.header("last-event-id", id);
        }
        let response = request
            .send()
            .await
            .map_err(|_| invalid("MCP event request failed"))?;
        if response.status() == reqwest::StatusCode::METHOD_NOT_ALLOWED {
            return Err(StreamableHttpError::ServerDoesNotSupportSse);
        }
        Self::status(&response)?;
        if !response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .is_some_and(|v| v.as_bytes().starts_with(b"text/event-stream"))
        {
            return Err(invalid("MCP event response has an invalid content type"));
        }
        Ok(Self::events(response))
    }
    async fn delete_session(
        &self,
        uri: Arc<str>,
        session: Arc<str>,
        token: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<(), Error> {
        let response = self
            .request(
                reqwest::Method::DELETE,
                &uri,
                Some(&session),
                token.as_deref(),
                headers,
            )?
            .send()
            .await
            .map_err(|_| invalid("MCP session cleanup request failed"))?;
        if response.status() == reqwest::StatusCode::METHOD_NOT_ALLOWED {
            return Err(StreamableHttpError::ServerDoesNotSupportDeleteSession);
        }
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(());
        }
        Self::status(&response)
    }
}
