use crate::{
    connector::{Connector, Failure, Normalized, Output},
    registered::{Operation, Prepared, RegisteredOperation},
};
use futures::StreamExt;
use platform_client::{authz::PlatformConnectionScope, relay::ConnectorOperation};
use serde::Deserialize;
use std::{collections::BTreeMap, path::Path, time::Duration};
use tonic::Status;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Method {
    Get,
    Post,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HttpOperation {
    pub operation: Operation,
    pub method: Method,
    pub path: String,
}

pub struct Http {
    id: String,
    client: reqwest::Client,
    bearer_token_file: Option<String>,
    operations: BTreeMap<String, (RegisteredOperation, Method, reqwest::Url)>,
}

pub(crate) fn validate(
    endpoint: &str,
    ca: Option<&str>,
    token: Option<&str>,
    operations: &[HttpOperation],
) -> anyhow::Result<()> {
    let endpoint = reqwest::Url::parse(endpoint)?;
    anyhow::ensure!(
        endpoint.scheme() == "https"
            && endpoint.host_str().is_some()
            && endpoint.username().is_empty()
            && endpoint.password().is_none()
            && endpoint.path() == "/"
            && endpoint.query().is_none()
            && endpoint.fragment().is_none()
            && ca.is_none_or(|path| Path::new(path).is_absolute())
            && token.is_none_or(|path| Path::new(path).is_absolute())
            && !operations.is_empty()
            && operations.len() <= 64,
        "invalid HTTP profile"
    );
    let mut names = std::collections::BTreeSet::new();
    for entry in operations {
        let operation = RegisteredOperation::new(entry.operation.clone())?;
        anyhow::ensure!(
            names.insert(operation.name().to_owned()),
            "duplicate HTTP operation"
        );
        route(&endpoint, &entry.path)?;
    }
    Ok(())
}

fn route(endpoint: &reqwest::Url, path: &str) -> anyhow::Result<reqwest::Url> {
    let url = endpoint.join(path)?;
    anyhow::ensure!(
        path.starts_with('/')
            && !path.starts_with("//")
            && path.len() <= 2048
            && url.origin() == endpoint.origin()
            && url.query().is_none()
            && url.fragment().is_none(),
        "invalid HTTP operation path"
    );
    Ok(url)
}

pub(crate) fn client(ca: Option<&str>) -> anyhow::Result<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(10));
    if let Some(path) = ca {
        let bytes = std::fs::read(path)?;
        anyhow::ensure!(bytes.len() <= 131_072, "HTTP CA exceeds its byte budget");
        builder = builder.tls_certs_only([reqwest::Certificate::from_pem(&bytes)?]);
    }
    Ok(builder.build()?)
}

impl Http {
    pub fn new(
        id: String,
        endpoint: &str,
        ca: Option<&str>,
        bearer_token_file: Option<String>,
        operations: Vec<HttpOperation>,
    ) -> anyhow::Result<Self> {
        validate(endpoint, ca, bearer_token_file.as_deref(), &operations)?;
        let endpoint = reqwest::Url::parse(endpoint)?;
        let client = client(ca)?;
        let mut registered = BTreeMap::new();
        for entry in operations {
            let operation = RegisteredOperation::new(entry.operation)?;
            registered.insert(
                operation.name().to_owned(),
                (operation, entry.method, route(&endpoint, &entry.path)?),
            );
        }
        Ok(Self {
            id,
            client,
            bearer_token_file,
            operations: registered,
        })
    }
}

fn failure(status: Status, upstream_status: u32) -> Failure {
    Failure {
        status,
        upstream_status,
    }
}

#[async_trait::async_trait]
impl Connector for Http {
    fn id(&self) -> &str {
        &self.id
    }
    fn operations(&self, access: Option<&[PlatformConnectionScope]>) -> Vec<ConnectorOperation> {
        self.operations
            .values()
            .filter_map(|(operation, _, _)| operation.discovery(&self.id, access))
            .collect()
    }
    fn normalize(&self, operation: &str, arguments: &[u8]) -> Result<Normalized, Status> {
        let (registered, method, _) = self
            .operations
            .get(operation)
            .ok_or_else(|| Status::not_found("HTTP operation not registered"))?;
        let normalized = registered.normalize(arguments)?;
        if matches!(method, Method::Get) {
            let prepared: Prepared = serde_json::from_slice(&normalized.prepared_request)
                .map_err(|_| Status::internal("invalid normalized HTTP request"))?;
            if prepared.arguments.as_object().is_none_or(|arguments| {
                arguments
                    .values()
                    .any(|value| value.is_array() || value.is_object())
            }) {
                return Err(Status::invalid_argument(
                    "HTTP query arguments must be scalar values",
                ));
            }
        }
        Ok(normalized)
    }
    async fn execute(&self, request: &Normalized) -> Result<Output, Failure> {
        let prepared: Prepared = serde_json::from_slice(&request.prepared_request)
            .map_err(|_| failure(Status::internal("invalid normalized HTTP request"), 0))?;
        let (_, method, url) = self
            .operations
            .get(&prepared.operation)
            .ok_or_else(|| failure(Status::internal("normalized HTTP operation missing"), 0))?;
        let mut request = match method {
            Method::Get => {
                let query: Vec<_> = prepared
                    .arguments
                    .as_object()
                    .expect("validated object arguments")
                    .iter()
                    .map(|(key, value)| {
                        (
                            key.clone(),
                            value
                                .as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| value.to_string()),
                        )
                    })
                    .collect();
                self.client.get(url.clone()).query(&query)
            }
            Method::Post => self.client.post(url.clone()).json(&prepared.arguments),
        };
        if let Some(path) = &self.bearer_token_file {
            let token = crate::credentials::read_file(path)
                .await
                .map_err(|status| failure(status, 0))?;
            if token.chars().any(char::is_control) {
                return Err(failure(Status::unavailable("invalid HTTP credential"), 0));
            }
            request = request.bearer_auth(token);
        }
        let response = request
            .send()
            .await
            .map_err(|_| failure(Status::unavailable("HTTP provider request failed"), 0))?;
        let code = u32::from(response.status().as_u16());
        if !response.status().is_success() {
            return Err(failure(
                match code {
                    401 => Status::failed_precondition(
                        "HTTP provider credentials require reconnecting",
                    ),
                    403 => Status::permission_denied("HTTP provider denied this operation"),
                    404 => Status::not_found("HTTP provider resource not found"),
                    _ => Status::unavailable("HTTP provider rejected this operation"),
                },
                code,
            ));
        }
        if response
            .content_length()
            .is_some_and(|length| length > 262_144)
        {
            return Err(failure(
                Status::resource_exhausted("HTTP response exceeds its byte budget"),
                code,
            ));
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .filter(|v| v.len() <= 256)
            .unwrap_or("application/octet-stream")
            .to_owned();
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk
                .map_err(|_| failure(Status::unavailable("HTTP response interrupted"), code))?;
            if bytes.len() + chunk.len() > 262_144 {
                return Err(failure(
                    Status::resource_exhausted("HTTP response exceeds its byte budget"),
                    code,
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(Output {
            bytes,
            content_type,
            upstream_status: code,
        })
    }
}
