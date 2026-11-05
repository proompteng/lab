use platform_client::{
    ExecutionLookup, ExecutionPayload, MAX_RELAY_REQUEST_BYTES,
    authz::{PlatformSubject, platform_subject},
    relay::{
        ConnectorOperation, ExecuteRequest, GetExecutionRequest, ListOperationsRequest,
        relay_service_client::RelayServiceClient,
    },
    request, tls,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

const TOOLS_PAGE_SIZE: usize = 50;
const CURSOR_LENGTH: usize = 80;

#[derive(Debug)]
struct InvalidListParams;

impl std::fmt::Display for InvalidListParams {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Invalid tools/list parameters or cursor; restart listing without a cursor")
    }
}

impl std::error::Error for InvalidListParams {}

struct ListCursor<'a> {
    start: usize,
    fingerprint: &'a str,
}

fn list_cursor(input: &Value) -> Result<Option<ListCursor<'_>>, InvalidListParams> {
    let Some(params) = input.get("params") else {
        return Ok(None);
    };
    let params = params.as_object().ok_or(InvalidListParams)?;
    let Some(cursor) = params.get("cursor") else {
        return Ok(None);
    };
    let cursor = cursor.as_str().ok_or(InvalidListParams)?;
    if cursor.len() != CURSOR_LENGTH
        || !cursor
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(InvalidListParams);
    }
    let start = usize::from_str_radix(&cursor[..16], 16).map_err(|_| InvalidListParams)?;
    if start == 0 || start % TOOLS_PAGE_SIZE != 0 {
        return Err(InvalidListParams);
    }
    Ok(Some(ListCursor {
        start,
        fingerprint: &cursor[16..],
    }))
}

fn tools_page(
    mut operations: Vec<ConnectorOperation>,
    cursor: Option<ListCursor<'_>>,
) -> anyhow::Result<Value> {
    operations.sort_by_cached_key(|op| {
        (
            format!("{}__{}", op.connector_id, op.name),
            op.connector_id.clone(),
        )
    });
    // Bind the position to all authorized discovery fields, not just tool names. Resource,
    // schema and annotation changes must invalidate cursors even if the count is unchanged.
    let fingerprint = format!("{:x}", Sha256::digest(serde_json::to_vec(&operations)?));
    let start = match cursor {
        Some(cursor) => {
            if cursor.start >= operations.len() || cursor.fingerprint != fingerprint {
                return Err(InvalidListParams.into());
            }
            cursor.start
        }
        None => 0,
    };
    let end = (start + TOOLS_PAGE_SIZE).min(operations.len());
    let tools = operations[start..end]
        .iter()
        .map(|op| {
            let schema: Value = serde_json::from_slice(&op.input_schema_json)?;
            Ok(json!({
                "name": format!("{}__{}", op.connector_id, op.name),
                "description": op.description,
                "inputSchema": schema,
                "annotations": {
                    "readOnlyHint": op.read_only,
                    "destructiveHint": !op.read_only,
                    "idempotentHint": op.read_only,
                },
            }))
        })
        .collect::<Result<Vec<_>, serde_json::Error>>()?;
    let mut result = json!({"tools": tools});
    if end < operations.len() {
        result["nextCursor"] = json!(format!("{end:016x}{fingerprint}"));
    }
    Ok(result)
}

async fn uncertain_execution(
    client: &mut RelayServiceClient<tonic::transport::Channel>,
    subject: PlatformSubject,
    operation_id: &str,
    body: Vec<u8>,
    code: tonic::Code,
) -> anyhow::Result<Value> {
    let request_hash = Sha256::digest(&body).to_vec();
    let lookup = ExecutionLookup {
        execution_body: String::from_utf8(body)?,
        binding: None,
        delegation_id: None,
    };
    let observed = client
        .get_execution(request(GetExecutionRequest {
            subject: Some(subject),
            body: serde_json::to_vec(&lookup)?,
        }))
        .await;
    let mut metadata = json!({"operationId":operation_id,"outcome":"unknown"});
    let failure = format!("The result for operation {operation_id} is unavailable ({code:?}).");
    let mut text =
        format!("{failure} Its outcome could not be confirmed. The request was not resent.");
    if let Ok(response) = observed {
        let response = response.into_inner();
        if let Some(execution) = response.execution.filter(|execution| {
            execution.operation_id == operation_id
                && execution.request_hash == request_hash
                && matches!(
                    execution.outcome.as_str(),
                    "started" | "succeeded" | "failed" | "withheld"
                )
                && uuid::Uuid::parse_str(&execution.authorization_receipt_id).is_ok()
                && uuid::Uuid::parse_str(&execution.execution_receipt_id).is_ok()
                && uuid::Uuid::parse_str(&response.lookup_receipt_id).is_ok()
                && execution.upstream_status <= 599
                && execution.updated_at_unix_ms > 0
                && (execution.result_hash.is_empty() || execution.result_hash.len() == 32)
                && (!matches!(execution.outcome.as_str(), "succeeded" | "withheld")
                    || execution.result_hash.len() == 32)
        }) {
            text = format!(
                "{failure} Relay recorded its outcome as {}. The original result is unavailable. The request was not resent.",
                execution.outcome
            );
            metadata = json!({
                "operationId":operation_id,
                "outcome":execution.outcome,
                "authorizationReceiptId":execution.authorization_receipt_id,
                "executionReceiptId":execution.execution_receipt_id,
                "lookupReceiptId":response.lookup_receipt_id,
                "upstreamStatus":execution.upstream_status,
                "updatedAtUnixMs":execution.updated_at_unix_ms,
            });
        }
    }
    Ok(json!({"content":[{"type":"text","text":text}],"isError":true,"_meta":{"relay":metadata}}))
}

async fn handle(
    client: &mut RelayServiceClient<tonic::transport::Channel>,
    service: &str,
    identity: &str,
    input: &Value,
) -> anyhow::Result<Value> {
    match input.get("method").and_then(Value::as_str) {
        Some("initialize") => Ok(
            json!({"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"relay","version":"1"}}),
        ),
        Some("ping") => Ok(json!({})),
        Some("tools/list") => {
            let cursor = list_cursor(input)?;
            let operations = client
                .list_operations(request(ListOperationsRequest {
                    subject: Some(PlatformSubject {
                        client_service: service.into(),
                        identity: Some(platform_subject::Identity::WorkloadId(identity.into())),
                    }),
                }))
                .await?
                .into_inner()
                .operations;
            tools_page(operations, cursor)
        }
        Some("tools/call") => {
            let params = input
                .get("params")
                .ok_or_else(|| anyhow::anyhow!("tool parameters required"))?;
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("tool name required"))?;
            let operations = client
                .list_operations(request(ListOperationsRequest {
                    subject: Some(PlatformSubject {
                        client_service: service.into(),
                        identity: Some(platform_subject::Identity::WorkloadId(identity.into())),
                    }),
                }))
                .await?
                .into_inner()
                .operations;
            let operation = operations
                .iter()
                .find(|op| format!("{}__{}", op.connector_id, op.name) == name)
                .ok_or_else(|| anyhow::anyhow!("unknown Relay tool"))?;
            let payload = ExecutionPayload {
                operation_id: uuid::Uuid::new_v4().to_string(),
                client_service: service.into(),
                connector_id: operation.connector_id.clone(),
                operation: operation.name.clone(),
                arguments: params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({})),
                binding: None,
                delegation_id: None,
            };
            let subject = PlatformSubject {
                client_service: service.into(),
                identity: Some(platform_subject::Identity::WorkloadId(identity.into())),
            };
            let body = serde_json::to_vec(&payload)?;
            let response = client
                .execute(request(ExecuteRequest {
                    subject: Some(subject.clone()),
                    body: body.clone(),
                }))
                .await;
            let response = match response {
                Ok(response) => response.into_inner(),
                Err(error) => {
                    return uncertain_execution(
                        client,
                        subject,
                        &payload.operation_id,
                        body,
                        error.code(),
                    )
                    .await;
                }
            };
            let receipt_valid = response.operation_id == payload.operation_id
                && uuid::Uuid::parse_str(&response.authorization_receipt_id).is_ok()
                && uuid::Uuid::parse_str(&response.execution_receipt_id).is_ok();
            let result = match (receipt_valid, String::from_utf8(response.result)) {
                (true, Ok(result)) => result,
                _ => {
                    return uncertain_execution(
                        client,
                        subject,
                        &payload.operation_id,
                        body,
                        tonic::Code::DataLoss,
                    )
                    .await;
                }
            };
            Ok(
                json!({"content":[{"type":"text","text":result}],"isError":false,"_meta":{"relay":{"operationId":response.operation_id,"outcome":"succeeded","authorizationReceiptId":response.authorization_receipt_id,"executionReceiptId":response.execution_receipt_id}}}),
            )
        }
        _ => anyhow::bail!("unsupported MCP method"),
    }
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .map_err(|_| anyhow::anyhow!("TLS crypto provider already installed"))?;
    let service = std::env::var("RELAY_CLIENT_SERVICE")?;
    let svid = std::env::var("SPIFFE_ID")?;
    let identity = tls::Identity::load(&svid).await?;
    let mut client = RelayServiceClient::new(identity.channel(
        &std::env::var("RELAY_GRPC_TARGET")?,
        "spiffe://proompteng.ai/ns/relay/sa/relay",
    )?)
    .max_decoding_message_size(1_114_112)
    .max_encoding_message_size(MAX_RELAY_REQUEST_BYTES);
    let mut input = tokio::io::BufReader::new(tokio::io::stdin());
    let mut stdout = tokio::io::stdout();
    loop {
        let mut line = Vec::new();
        // read_until is bounded by taking at most one message budget from the stream.
        let count = tokio::io::AsyncReadExt::take(&mut input, 131_073)
            .read_until(b'\n', &mut line)
            .await?;
        if count == 0 {
            break;
        }
        if line.len() > 131_072 || !line.ends_with(b"\n") {
            anyhow::bail!("MCP input exceeds its byte budget");
        }
        let message: Value = match serde_json::from_slice(&line) {
            Ok(value) => value,
            Err(_) => {
                stdout.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32700,\"message\":\"Invalid JSON\"}}\n").await?;
                continue;
            }
        };
        let Some(id) = message.get("id") else {
            continue;
        };
        let result = match handle(&mut client, &service, &svid, &message).await {
            Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
            Err(error) if error.is::<InvalidListParams>() => {
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32602,"message":error.to_string()}})
            }
            Err(_) => {
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":"Relay denied the operation or the connector is unavailable"}})
            }
        };
        stdout.write_all(&serde_json::to_vec(&result)?).await?;
        stdout.write_all(b"\n").await?;
        stdout.flush().await?;
    }
    Ok(())
}
