use platform_client::{
    ExecutionLookup, ExecutionPayload, MAX_RELAY_REQUEST_BYTES,
    authz::{PlatformSubject, platform_subject},
    relay::{
        ExecuteRequest, GetExecutionRequest, ListOperationsRequest,
        relay_service_client::RelayServiceClient,
    },
    request, tls,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

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
            let tools:Result<Vec<_>,_>=operations.into_iter().map(|op|serde_json::from_slice::<Value>(&op.input_schema_json).map(|schema|json!({"name":format!("{}__{}",op.connector_id,op.name),"description":op.description,"inputSchema":schema,"annotations":{"readOnlyHint":op.read_only,"destructiveHint":!op.read_only,"idempotentHint":op.read_only}}))).collect();
            Ok(json!({"tools":tools?}))
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
