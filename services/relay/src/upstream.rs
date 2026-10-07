use crate::policy::{self, Connector};
use anyhow::{Context, bail, ensure};
use futures::StreamExt;
use reqwest::{Client, header::HeaderValue};
use serde_json::{Value, json};
use std::{net::SocketAddr, time::Duration};
const LIMIT: usize = 2 << 20;
const PROTOCOL: &str = "2025-11-25";

pub async fn call<F, Fut>(
    grant: &Connector,
    tool: &str,
    args: Value,
    authorize: F,
) -> anyhow::Result<Value>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<()>>,
{
    let url = policy::endpoint(&grant.endpoint)?;
    let host = url.host_str().context("missing endpoint hostname")?;
    let resolved: Vec<SocketAddr> = tokio::net::lookup_host((host, 443))
        .await?
        .filter(|address| address.is_ipv4())
        .collect();
    // Fail mixed public/private resolutions, then pin the vetted addresses for the entire session.
    ensure!(
        !resolved.is_empty() && resolved.iter().all(|a| policy::public_ip(a.ip())),
        "non-public endpoint resolution"
    );
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(host, &resolved)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(45))
        .build()?;
    let token = match &grant.credential_key {
        Some(key) => {
            let value =
                tokio::fs::read_to_string(format!("/var/run/secrets/relay-credentials/{key}"))
                    .await
                    .context("connector credential unavailable")?;
            ensure!(
                value.len() >= 8 && value.len() <= 8192 && !value.contains(['\r', '\n']),
                "invalid connector credential"
            );
            Some(value)
        }
        None => None,
    };
    let mut session = Session {
        client,
        endpoint: grant.endpoint.clone(),
        token,
        session_id: None,
        protocol: PROTOCOL.to_string(),
    };
    let initialize = session.rpc(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":PROTOCOL,"capabilities":{},"clientInfo":{"name":"Relay","version":env!("CARGO_PKG_VERSION")}}}), Some(1)).await?;
    let protocol = initialize["result"]["protocolVersion"]
        .as_str()
        .context("invalid initialize response")?;
    ensure!(
        ["2025-03-26", "2025-06-18", PROTOCOL].contains(&protocol),
        "unsupported MCP protocol"
    );
    session.protocol = protocol.into();
    session
        .rpc(
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            None,
        )
        .await?;
    authorize().await?;
    let result = session.rpc(json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":tool,"arguments":args}}), Some(2)).await?;
    let result = result
        .get("result")
        .context("connector rejected tool call")?
        .clone();
    ensure!(result["content"].is_array(), "invalid tool result");
    if let Some(token) = &session.token {
        ensure!(
            !contains_credential(&result, token),
            "connector response contains credentials"
        );
    }
    Ok(result)
}
fn contains_credential(value: &Value, token: &str) -> bool {
    match value {
        Value::String(text) => text.contains(token),
        Value::Array(values) => values.iter().any(|value| contains_credential(value, token)),
        Value::Object(values) => values
            .iter()
            .any(|(key, value)| key.contains(token) || contains_credential(value, token)),
        _ => false,
    }
}
struct Session {
    client: Client,
    endpoint: String,
    token: Option<String>,
    session_id: Option<HeaderValue>,
    protocol: String,
}
impl Drop for Session {
    fn drop(&mut self) {
        if let Some(id) = self.session_id.clone() {
            let mut request = self
                .client
                .delete(&self.endpoint)
                .header("Mcp-Session-Id", id)
                .header("MCP-Protocol-Version", &self.protocol);
            if let Some(token) = &self.token {
                request = request.bearer_auth(token);
            }
            tokio::spawn(async move {
                let _ = tokio::time::timeout(Duration::from_secs(5), request.send()).await;
            });
        }
    }
}
impl Session {
    async fn rpc(&mut self, message: Value, id: Option<i64>) -> anyhow::Result<Value> {
        let mut request = self
            .client
            .post(&self.endpoint)
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", &self.protocol)
            .json(&message);
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        if let Some(session) = &self.session_id {
            request = request.header("Mcp-Session-Id", session);
        }
        let response = request.send().await?;
        ensure!(
            response.status().is_success(),
            "upstream HTTP request failed"
        );
        if let Some(session) = response.headers().get("Mcp-Session-Id") {
            ensure!(
                session.len() <= 512 && session.to_str().is_ok(),
                "invalid upstream session ID"
            );
            self.session_id = Some(session.clone());
        }
        if id.is_none() {
            return Ok(Value::Null);
        }
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("")
            .to_owned();
        ensure!(
            content_type.starts_with("application/json")
                || content_type.starts_with("text/event-stream"),
            "unsupported MCP response transport"
        );
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            ensure!(
                body.len() + chunk.len() <= LIMIT,
                "connector response too large"
            );
            body.extend_from_slice(&chunk);
            if content_type.starts_with("text/event-stream")
                && let Some(value) = sse_response(&body, id.unwrap())?
            {
                return Ok(value);
            }
        }
        if content_type.starts_with("application/json") {
            let value: Value = serde_json::from_slice(&body)?;
            validate_response(&value, id.unwrap())?;
            return Ok(value);
        }
        bail!("MCP stream ended without response")
    }
}
fn validate_response(value: &Value, id: i64) -> anyhow::Result<()> {
    ensure!(
        value["jsonrpc"] == "2.0"
            && value["id"] == id
            && value.get("method").is_none()
            && (value.get("result").is_some() ^ value.get("error").is_some()),
        "invalid MCP response"
    );
    Ok(())
}
fn sse_response(bytes: &[u8], id: i64) -> anyhow::Result<Option<Value>> {
    let raw = match std::str::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) if e.error_len().is_none() => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let normalized = raw.replace("\r\n", "\n");
    let mut frames = normalized.split("\n\n").peekable();
    while let Some(frame) = frames.next() {
        if frames.peek().is_none() {
            break;
        }
        let data = frame
            .lines()
            .filter_map(|l| l.strip_prefix("data:").map(str::trim_start))
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(&data)?;
        // Do not forward server-initiated elicitation/sampling requests to the agent.
        ensure!(
            value.get("method").is_none() || value.get("id").is_none(),
            "server requests are unsupported"
        );
        if value["id"] == id {
            validate_response(&value, id)?;
            return Ok(Some(value));
        }
    }
    Ok(None)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_credentials_in_decoded_strings_and_object_keys() {
        for token in [
            "token\"with-quotes",
            "token\\with-backslash",
            "ordinary-token",
        ] {
            for result in [
                json!({"content":[{"type":"text","text":format!("echo: {token}") }]}),
                json!({"content":[],"structuredContent":{"nested":[null, {"value":token}]}}),
                json!({"content":[],"structuredContent":{(token):true}}),
            ] {
                let encoded = serde_json::to_string(&result).unwrap();
                if token.contains(['"', '\\']) {
                    assert!(
                        !encoded.contains(token),
                        "serialized search reproduces the leak"
                    );
                }
                let decoded: Value = serde_json::from_str(&encoded).unwrap();
                assert!(contains_credential(&decoded, token));
            }
        }
    }
    #[test]
    fn allows_results_without_credentials() {
        let result = json!({"content":[{"type":"text","text":"public response"}],
            "structuredContent":{"nested":[null, true, 8, {"value":"safe"}]}});
        assert!(!contains_credential(&result, "private-token"));
    }
    #[test]
    fn bounded_sse_handles_chunking_and_rejects_server_requests() {
        assert!(
            sse_response(b"data: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{}}\n", 2)
                .unwrap()
                .is_none()
        );
        assert!(
            sse_response(
                b"event: message\r\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{}}\r\n\r\n",
                2
            )
            .unwrap()
            .is_some()
        );
        assert!(
            sse_response(
                b"data: {\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"elicitation/create\"}\n\n",
                2
            )
            .is_err()
        );
        assert!(
            validate_response(&json!({"jsonrpc":"2.0","id":2,"result":{},"error":{}}), 2).is_err()
        );
        assert!(validate_response(&json!({"jsonrpc":"2.0","id":3,"result":{}}), 2).is_err());
    }
}
