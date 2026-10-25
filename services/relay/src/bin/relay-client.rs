use platform_client::{
    ExecutionPayload,
    authz::{PlatformSubject, platform_subject},
    relay::{ExecuteRequest, ListOperationsRequest, relay_service_client::RelayServiceClient},
    request, tls,
};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

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
                    client_service: service.into(),
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
                    client_service: service.into(),
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
            let response = client
                .execute(request(ExecuteRequest {
                    subject: Some(PlatformSubject {
                        client_service: service.into(),
                        identity: Some(platform_subject::Identity::WorkloadId(identity.into())),
                    }),
                    body: serde_json::to_vec(&payload)?,
                }))
                .await?
                .into_inner();
            if response.operation_id != payload.operation_id
                || uuid::Uuid::parse_str(&response.authorization_receipt_id).is_err()
                || uuid::Uuid::parse_str(&response.execution_receipt_id).is_err()
            {
                anyhow::bail!("Relay execution receipt is invalid");
            }
            Ok(
                json!({"content":[{"type":"text","text":String::from_utf8(response.result)?}],"isError":false}),
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
    .max_encoding_message_size(131_072);
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
