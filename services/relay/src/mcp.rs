use crate::{
    connector::{Connector, Failure, Normalized, Output},
    credentials::Authentication,
    process::Profile,
    registered::{Operation, Prepared, RegisteredOperation},
};
use platform_client::{authz::PlatformConnectionScope, relay::ConnectorOperation};
use rmcp::{
    RoleClient, ServiceExt, service::RunningService, transport::async_rw::AsyncRwTransport,
};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    process::Stdio,
    time::Duration,
};
use tonic::Status;

fn provider_error(error: &(dyn std::error::Error + 'static), message: &'static str) -> Status {
    // The SDK's public errors retain their typed transport error without exposing it through source().
    let transport = error
        .downcast_ref::<rmcp::service::ClientInitializeError>()
        .and_then(|error| match error {
            rmcp::service::ClientInitializeError::TransportError { error, .. } => Some(error),
            _ => None,
        })
        .or_else(|| {
            error
                .downcast_ref::<rmcp::ServiceError>()
                .and_then(|error| match error {
                    rmcp::ServiceError::TransportSend(error) => Some(error),
                    _ => None,
                })
        });
    if let Some(transport) = transport {
        use rmcp::transport::streamable_http_client::StreamableHttpError;
        match transport
            .error
            .downcast_ref::<StreamableHttpError<std::io::Error>>()
        {
            Some(StreamableHttpError::HttpStatus(http)) if http.status == 401 => {
                let mut status =
                    Status::failed_precondition("MCP provider credentials require reconnecting");
                status.metadata_mut().insert(
                    "x-relay-upstream-status",
                    "401".parse().expect("static metadata"),
                );
                return status;
            }
            Some(StreamableHttpError::HttpStatus(http)) if http.status == 403 => {
                let mut status = Status::permission_denied("MCP provider denied this operation");
                status.metadata_mut().insert(
                    "x-relay-upstream-status",
                    "403".parse().expect("static metadata"),
                );
                return status;
            }
            Some(StreamableHttpError::SessionExpired) => {
                return Status::failed_precondition(
                    "MCP provider session expired; the call was not repeated. Check its outcome before retrying",
                );
            }
            _ => {}
        }
    }
    Status::unavailable(message)
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Transport {
    Stdio {
        process: Profile,
    },
    Http {
        endpoint: String,
        ca_file: Option<String>,
        authentication: Authentication,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpOperation {
    pub operation: Operation,
    pub tool: String,
}

pub struct Mcp {
    id: String,
    transport: Transport,
    operations: BTreeMap<String, (RegisteredOperation, String)>,
}

pub(crate) fn validate(transport: &Transport, operations: &[McpOperation]) -> anyhow::Result<()> {
    match transport {
        Transport::Stdio { process } => process.validate()?,
        Transport::Http {
            endpoint,
            ca_file,
            authentication,
        } => {
            let url = reqwest::Url::parse(endpoint)?;
            anyhow::ensure!(
                url.scheme() == "https"
                    && url.host_str().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.query().is_none()
                    && url.fragment().is_none()
                    && ca_file
                        .as_ref()
                        .is_none_or(|path| std::path::Path::new(path).is_absolute()),
                "invalid upstream MCP endpoint"
            );
            authentication.validate()?;
        }
    }
    anyhow::ensure!(
        !operations.is_empty() && operations.len() <= 64,
        "invalid MCP operation count"
    );
    let mut names = BTreeSet::new();
    let mut tools = BTreeSet::new();
    for entry in operations {
        let operation = RegisteredOperation::new(entry.operation.clone())?;
        anyhow::ensure!(
            names.insert(operation.name().to_owned())
                && tools.insert(entry.tool.clone())
                && !entry.tool.is_empty()
                && entry.tool.len() <= 128
                && entry
                    .tool
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b)),
            "invalid or duplicate MCP tool registration"
        );
    }
    Ok(())
}

impl Mcp {
    pub fn new(
        id: String,
        transport: Transport,
        operations: Vec<McpOperation>,
    ) -> anyhow::Result<Self> {
        validate(&transport, &operations)?;
        let mut registered = BTreeMap::new();
        for entry in operations {
            let operation = RegisteredOperation::new(entry.operation)?;
            registered.insert(operation.name().into(), (operation, entry.tool));
        }
        Ok(Self {
            id,
            transport,
            operations: registered,
        })
    }

    async fn invoke(
        &self,
        service: &RunningService<RoleClient, ()>,
        prepared: &Prepared,
    ) -> Result<Output, Status> {
        let (operation, name) = self
            .operations
            .get(&prepared.operation)
            .ok_or_else(|| Status::internal("normalized MCP operation missing"))?;
        let mut cursor = None;
        let mut seen = BTreeSet::new();
        let mut matched = false;
        for _ in 0..16 {
            let page = service
                .peer()
                .list_tools(cursor)
                .await
                .map_err(|error| provider_error(&error, "upstream MCP catalog unavailable"))?;
            if let Some(tool) = page.tools.iter().find(|tool| tool.name.as_ref() == name) {
                if serde_json::Value::Object(tool.input_schema.as_ref().clone())
                    != *operation.input_schema()
                    || tool.annotations.as_ref().is_some_and(|annotations| {
                        annotations.read_only_hint == Some(false)
                            || annotations.destructive_hint == Some(true)
                    })
                {
                    return Err(Status::failed_precondition(
                        "MCP tool changed; review its registration before reconnecting",
                    ));
                }
                matched = true;
                break;
            }
            match page.next_cursor {
                Some(next) if seen.insert(next.clone()) => {
                    cursor = Some(
                        serde_json::from_value(serde_json::json!({"cursor":next}))
                            .map_err(|_| Status::internal("encode MCP catalog cursor"))?,
                    );
                }
                _ => break,
            }
        }
        if !matched {
            return Err(Status::failed_precondition(
                "registered MCP tool is absent from its bounded catalog",
            ));
        }
        let result = service
            .peer()
            .call_tool(
                serde_json::from_value(
                    serde_json::json!({"name":name,"arguments":prepared.arguments}),
                )
                .map_err(|_| Status::internal("encode upstream MCP call"))?,
            )
            .await
            .map_err(|error| {
                provider_error(
                    &error,
                    "upstream MCP tool response unavailable; the call was not repeated",
                )
            })?;
        if result.is_error == Some(true) {
            return Err(Status::unavailable("upstream MCP tool reported failure"));
        }
        let bytes = serde_json::to_vec(&result)
            .map_err(|_| Status::data_loss("invalid upstream MCP response"))?;
        if bytes.len() > 262_144 {
            return Err(Status::resource_exhausted(
                "MCP response exceeds its byte budget",
            ));
        }
        Ok(Output {
            bytes,
            content_type: "application/json".into(),
            upstream_status: 0,
        })
    }

    async fn run(&self, prepared: Prepared, bearer: Option<&str>) -> Result<Output, Status> {
        let mut process = None;
        let service = match &self.transport {
            Transport::Stdio { process: profile } => {
                process = Some(profile.spawn(Stdio::null()).await?);
                let child = &mut process.as_mut().expect("spawned MCP process").child;
                let transport = AsyncRwTransport::new_client(
                    child.stdout.take().expect("piped stdout"),
                    child.stdin.take().expect("piped stdin"),
                )
                .with_max_line_length(262_144);
                ().serve(transport)
                    .await
                    .map_err(|error| provider_error(&error, "upstream MCP initialization failed"))?
            }
            Transport::Http {
                endpoint,
                ca_file,
                authentication,
            } => {
                let client = crate::mcp_http::Client::new(ca_file.as_deref())?;
                let mut config = rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig::with_uri(endpoint.clone())
                    .max_concurrent_requests(1).max_sse_event_size(262_144).reinit_on_expired_session(false);
                config.retry_config = std::sync::Arc::new(
                    rmcp::transport::common::client_side_sse::NeverRetry::default(),
                );
                let config = if let Some(token) = authentication.bearer(bearer).await? {
                    config.auth_header(token)
                } else {
                    config
                };
                let transport = rmcp::transport::streamable_http_client::StreamableHttpClientTransport::with_client(client, config);
                ().serve(transport)
                    .await
                    .map_err(|error| provider_error(&error, "upstream MCP initialization failed"))?
            }
        };
        let result = self.invoke(&service, &prepared).await;
        if service.cancel().await.is_err() {
            eprintln!("upstream MCP session cleanup failed");
        }
        drop(process);
        result
    }
}

#[async_trait::async_trait]
impl Connector for Mcp {
    fn id(&self) -> &str {
        &self.id
    }
    fn provider(&self) -> Option<crate::credentials::Provider<'_>> {
        match &self.transport {
            Transport::Http {
                endpoint,
                authentication,
                ..
            } => authentication.provider(endpoint),
            Transport::Stdio { .. } => None,
        }
    }
    fn operations(&self, access: Option<&[PlatformConnectionScope]>) -> Vec<ConnectorOperation> {
        self.operations
            .values()
            .filter_map(|(operation, _)| operation.discovery(&self.id, access))
            .collect()
    }
    fn normalize(&self, operation: &str, arguments: &[u8]) -> Result<Normalized, Status> {
        self.operations
            .get(operation)
            .ok_or_else(|| Status::not_found("MCP operation not registered"))?
            .0
            .normalize(arguments)
    }
    async fn execute(&self, request: &Normalized, bearer: Option<&str>) -> Result<Output, Failure> {
        let prepared = serde_json::from_slice(&request.prepared_request).map_err(|_| Failure {
            status: Status::internal("invalid normalized MCP request"),
            upstream_status: 0,
        })?;
        tokio::time::timeout(Duration::from_secs(10), self.run(prepared, bearer))
            .await
            .map_err(|_| Failure {
                status: Status::deadline_exceeded("upstream MCP operation timed out"),
                upstream_status: 0,
            })?
            .map_err(Failure::from)
    }
}
